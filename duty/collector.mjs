import { SourceClient } from './client.mjs'
import { Store, packetKey, parsePacketKey } from './store.mjs'
import { parseModel, attributeRecord, indexReadings, evaluateAction, headsFor } from './model.mjs'
import { buildDemand, reconcile, runsInOrder, localSecondsForFieldWindow } from './planner.mjs'
import { decodePacket, encodePacket } from './packet.mjs'

const STREAMS = ['plans', 'actions', 'lanes', 'retention', 'sync', 'calibration', 'saved', 'consumed']

// 一轮值班采集：登记 → 对账 → 领取 → 认定 → 测计/验收 → 交班。
// 已下载的包只按当前对时/校准重新认定，无须向网关重复领取同一秒。
export async function runRound({ root, stateDir, client }) {
  const store = new Store(stateDir)
  const state = await store.load()
  client ??= new SourceClient(root)
  const before = {
    edition: state.edition,
    rows: Object.fromEntries(Object.entries(state.etags).map(([k, v]) => [k, v.rows])),
  }

  const catalog = await client.catalog()
  const edition = catalog.edition
  const transition = before.edition !== null && before.edition !== edition

  const streams = {}
  const revalidated = []
  for (const name of STREAMS) {
    const kept = state.etags[name]
    const res = await client.stream(name, kept?.etag)
    if (res.notModified && kept) {
      streams[name] = kept.rows
      revalidated.push(name)
    } else {
      streams[name] = res.rows
      state.etags[name] = { etag: res.etag, rows: res.rows }
    }
  }
  const model = parseModel(streams)
  const oldModel = transition ? parseModel(before.rows) : null
  const changes = transition ? diffModels(oldModel, model) : []
  if (transition) state.quota = {} // 换班：共用额度台账按新资料版重新建立

  state.edition = edition
  state.runSeq += 1
  const run = {
    seq: state.runSeq, edition, transition, revalidated,
    fetched: {}, media: {}, gaps: {}, lost: {},
  }

  // 在库原包集合（跨轮、跨资料版复用）
  const cached = new Map()
  for (const key of Object.keys(state.packets)) {
    const { genKey, second } = parsePacketKey(key)
    addCached(cached, genKey, second)
  }
  const ctx = { client, store, state, model, run, cached }

  // —— 需求与对账：几个试验一起登记，需求合并去重
  const demand = buildDemand(model)
  const firstPass = reconcile(model, demand, cached)
  for (const [genKey, entry] of firstPass.perGen) {
    for (const item of entry.lost) pushLost(run, genKey, item.second)
    for (const item of entry.future) pushGap(run, genKey, item.second, '尚未进入留存窗')
  }

  // 1) 已备份原件：免费复用，不占采集额
  for (const [genKey, entry] of firstPass.perGen) {
    for (const item of entry.media) {
      try {
        const buffer = await client.media(item.mediaId)
        for (const rec of decodePacket(buffer).records) {
          await store.putPacket(packetKey(genKey, rec.second), encodePacket([rec]),
            { origin: 'media', mediaId: item.mediaId, run: run.seq })
          addCached(cached, genKey, rec.second)
        }
        push(run.media, genKey, item.second)
      } catch {
        pushGap(run, genKey, item.second, '原件读取失败')
      }
    }
  }

  // 2) 在线领取：更早失去先收，同界依计划优先序；额度按班共用
  for (const r of runsInOrder(firstPass.order)) {
    await fetchRun(ctx, r.genKey, r.from, r.until)
  }

  // 3) 已交结论（consumed）依据的原件：免费调入在库，供交接核实
  for (const rec of model.consumed) {
    for (const mediaId of rec.media) {
      if (Object.values(state.packets).some(p => p.mediaId === mediaId)) continue
      const home = findSavedHome(model, mediaId)
      if (!home) continue
      try {
        const buffer = await client.media(mediaId)
        for (const rec2 of decodePacket(buffer).records) {
          await store.putPacket(packetKey(home.genKey, rec2.second), encodePacket([rec2]),
            { origin: 'media', mediaId, run: run.seq })
          addCached(cached, home.genKey, rec2.second)
        }
      } catch { /* 原件暂不可得：交接评估照实记录 */ }
    }
  }

  // —— 认定：全部在库原包按当前对时/校准认到工况
  const readings = []
  for (const key of Object.keys(state.packets)) {
    const buffer = await store.getPacket(key)
    if (!buffer) continue
    const { genKey } = parsePacketKey(key)
    for (const rec of decodePacket(buffer).records) {
      readings.push(...attributeRecord(genKey, rec, model))
    }
  }
  const readingIndex = indexReadings(readings)

  // —— 逐动作评估与处置
  const evaluations = []
  const issued = []
  const maintained = []
  const overturned = []
  for (const action of model.actions.values()) {
    const plan = model.plans.get(action.plan)
    if (!plan) continue
    const ev = evaluateAction(action, plan, model, readingIndex)
    const entry = describeAction(ev)
    evaluations.push(entry)

    const prev = state.acceptances[action.id]
    if (ev.eligible) {
      const evidence = evidenceOf(ev)
      const sameWindow = prev && prev.window[0] === action.from && prev.window[1] === action.until
      const sameSeconds = prev && prev.coveredSeconds.join(',') === ev.coveredSeconds.join(',')
      if (prev && sameWindow && sameSeconds) {
        maintained.push(prev.id)
      } else {
        const credential = {
          id: 'AC' + (++state.credentialSeq),
          action: action.id, edition,
          window: [action.from, action.until],
          coveredSeconds: [...ev.coveredSeconds],
          evidence, run: run.seq,
        }
        state.acceptances[action.id] = credential
        issued.push(credential)
        entry.credential = credential.id
      }
    } else if (prev) {
      // 已发验收被推翻：动作调整、探头更换或校准更正
      delete state.acceptances[action.id]
      overturned.push({
        credential: prev,
        causes: relevantCauses(changes, action.id, genKeysOf(ev)),
        periods: classifyPeriods(ev, model, cached, [prev.window[0], prev.window[1]]),
      })
    }
  }

  // —— 业务已交结论（consumed）的交接核实
  const consumedReports = []
  for (const rec of model.consumed) {
    const action = model.actions.get(rec.action)
    const plan = action && model.plans.get(action.plan)
    const report = { handover: rec.handover, action: rec.action, media: rec.media, causes: [], periods: [], shaken: true }
    if (!action || !plan) {
      report.causes.push('动作或计划已不存在')
    } else {
      const ev = evaluateAction(action, plan, model, readingIndex)
      report.causes = relevantCauses(changes, action.id, genKeysOf({ directions: headsFor(action, plan, model) }))
      report.periods = classifyPeriods(ev, model, cached, [action.from, action.until])
      report.shaken = report.periods.some(p => p.status !== 'confirmed')
    }
    consumedReports.push(report)
  }

  // —— 交班：已实际拿到的包、仍应尝试的缺口、已失去的时段
  const handover = buildHandover(state, model, run, cached, demand, issued, maintained, overturned, consumedReports)

  const report = {
    seq: run.seq, edition, transition, changes, revalidated,
    fetch: fetchSummary(model, state, run, firstPass, cached),
    demand: demandSummary(demand),
    actions: evaluations,
    issued, maintained, overturned, consumed: consumedReports,
  }

  state.runs.push({
    seq: run.seq, edition, transition,
    fetched: run.fetched, media: run.media, gaps: run.gaps, lost: run.lost,
    issued: issued.map(c => c.id), overturned: overturned.map(o => o.credential.id),
  })
  state.runs = state.runs.slice(-50)
  await store.save()
  await store.writeReport(`round-${run.seq}.json`, report)
  await store.writeReport('last-handover.json', handover)
  return { report, handover, state }
}

// 在线领取一个连续段；越期/限额时已到数据照常入库，剩余逐秒补试。
async function fetchRun(ctx, genKey, from, until) {
  const { client, store, state, model, run, cached } = ctx
  const [gateway, generation] = genKey.split('/')
  const wanted = []
  for (let s = from; s < until; s++) wanted.push(s)
  const pending = new Set(wanted)

  const noteQuota = res => {
    const remaining = res.remaining ?? res.error?.remaining
    if (Number.isInteger(remaining)) {
      const ret = model.retention.get(genKey)
      state.quota[genKey] = {
        remaining, budget: ret?.budget ?? null,
        retention: ret ? [ret.from, ret.until] : null,
      }
    }
  }

  if (state.quota[genKey]?.remaining === 0) {
    for (const s of wanted) pushGap(run, genKey, s, '额度不足')
    return
  }

  const accept = async records => {
    for (const rec of records) {
      await store.putPacket(packetKey(genKey, rec.second), encodePacket([rec]),
        { origin: 'fetch', run: run.seq })
      pending.delete(rec.second)
      addCached(cached, genKey, rec.second)
      push(run.fetched, genKey, rec.second)
    }
  }

  const res = await client.samples(gateway, generation, from, until)
  noteQuota(res)
  await accept(res.records)

  if (res.error) {
    if (res.error.code === 410) {
      // 越期：按网关返回的留存边界更新认知，边界以下记已失去
      rememberRetention(state, genKey, res.error)
      for (const s of [...pending]) {
        if (Number.isInteger(res.error.start) && s < res.error.start) {
          pushLost(run, genKey, s)
          pending.delete(s)
        } else if (Number.isInteger(res.error.stop) && s >= res.error.stop) {
          pushGap(run, genKey, s, '尚未进入留存窗')
          pending.delete(s)
        }
      }
    }
    // 剩余逐秒补试：限额首试即 429 时，本设备代其余一律记缺口
    let exhausted = false
    for (const s of [...pending].sort((a, b) => a - b)) {
      if (exhausted) {
        pushGap(run, genKey, s, '额度不足')
        pending.delete(s)
        continue
      }
      const one = await client.samples(gateway, generation, s, s + 1)
      noteQuota(one)
      await accept(one.records)
      if (!one.error) continue
      if (one.error.code === 410) {
        rememberRetention(state, genKey, one.error)
        pushLost(run, genKey, s)
      } else if (one.error.code === 429) {
        pushGap(run, genKey, s, '额度不足')
        exhausted = true
      } else {
        pushGap(run, genKey, s, '网关错误 ' + one.error.code)
      }
      pending.delete(s)
    }
  }
  // 整段成功但网关没有的秒：记缺口（无记录），不消耗额度
  for (const s of [...pending]) {
    pushGap(run, genKey, s, '网关无该秒记录')
    pending.delete(s)
  }
}

// —— 时段处置分类：确认中 / 待校准补交 / 掉样不足 / 可补领 / 已失去 / 尚未到窗
function classifyPeriods(ev, model, cached, windowOverride) {
  const [w0, w1] = windowOverride ?? [ev.action.from, ev.action.until]
  const periods = []
  if (!ev.measurable) {
    for (let fs = w0; fs < w1; fs++) periods.push({ second: fs, status: 'no-head', detail: '缺方向采样头' })
    return periods
  }
  const genKeys = [...ev.directions['+'], ...ev.directions['-']].map(h => h.genKey)
  for (let fs = w0; fs < w1; fs++) {
    const sec = ev.seconds.get(fs)
    if (!sec) {
      periods.push({ second: fs, status: 'out-of-window', detail: '已退出当前动作窗口' })
      continue
    }
    if (sec.covered) {
      periods.push({ second: fs, status: 'confirmed' })
      continue
    }
    const dirs = ['+', '-']
    const enoughIfCalibrated = dirs.every(d => sec[d].valid.length + sec[d].pending.length >= 2)
    const anyPending = dirs.some(d => sec[d].pending.length > 0)
    if (enoughIfCalibrated && anyPending) {
      periods.push({ second: fs, status: 'pending-calibration', detail: '原料在库' })
      continue
    }
    const needed = []
    for (const gk of genKeys) {
      for (const s of localSecondsForFieldWindow(model, gk, fs, fs + 1)) needed.push({ genKey: gk, second: s })
    }
    const held = n => cached.get(n.genKey)?.has(n.second) || model.saved.get(n.genKey)?.has(n.second)
    const gone = n => {
      if (held(n)) return false
      const ret = model.retention.get(n.genKey)
      return !ret || n.second < ret.from
    }
    if (needed.every(held)) {
      const drops = dirs.map(d => sec[d].dropped.length).reduce((a, b) => a + b, 0)
      periods.push({ second: fs, status: 'dropped-short', detail: `原料在库，掉样 ${drops} 致有效读数不足` })
    } else if (needed.some(gone)) {
      periods.push({ second: fs, status: 'lost', detail: '所需原包已越过留存窗' })
    } else if (needed.every(n => held(n) || withinRetention(model, n))) {
      periods.push({ second: fs, status: 'recollectable', detail: '所需原包仍在留存窗' })
    } else {
      periods.push({ second: fs, status: 'not-yet', detail: '尚未进入留存窗' })
    }
  }
  return periods
}

function withinRetention(model, n) {
  const ret = model.retention.get(n.genKey)
  return !!ret && n.second >= ret.from && n.second < ret.until
}

function evidenceOf(ev) {
  const set = new Set()
  for (const fs of ev.coveredSeconds) {
    const sec = ev.seconds.get(fs)
    for (const dir of ['+', '-']) {
      for (const r of sec[dir].valid) set.add(packetKey(r.genKey, r.second))
    }
  }
  return [...set].sort()
}

function describeAction(ev) {
  const { action, plan } = ev
  const heads = {
    '+': ev.directions['+'].map(h => `${h.genKey}(${h.head})`),
    '-': ev.directions['-'].map(h => `${h.genKey}(${h.head})`),
  }
  const seconds = {}
  for (const [fs, sec] of ev.seconds) {
    seconds[fs] = {
      covered: sec.covered,
      '+': tally(sec['+']),
      '-': tally(sec['-']),
    }
  }
  let decision, reason
  if (action.status === 'cancelled') {
    decision = 'cancelled'; reason = '已取消：在库原件保留备查，不作测计'
  } else if (!ev.measurable) {
    decision = 'impossible'
    reason = ev.directions['+'].length + ev.directions['-'].length === 0
      ? `工况 ${action.condition} 在流道 ${plan.lane} 无对应采样头`
      : `缺 ${ev.directions['+'].length === 0 ? '+' : '-'} 方向采样头`
  } else if (action.status !== 'signed') {
    decision = 'protect'; reason = '未签：原料保护中，不提前交作测计'
  } else if (ev.eligible) {
    decision = 'accept'; reason = '温差与流量覆盖确认，给予验收领取'
  } else {
    decision = 'withhold'; reason = '未全覆盖，不予验收领取'
  }
  return {
    id: action.id, plan: plan.id, window: [action.from, action.until],
    status: action.status, condition: action.condition,
    heads, measurable: ev.measurable, decision, reason,
    seconds, coveredSeconds: ev.coveredSeconds, gapSeconds: ev.gapSeconds,
  }
}

function tally(dirSec) {
  return {
    valid: dirSec.valid.length,
    dropped: dirSec.dropped.length,
    pending: dirSec.pending.length,
    zero: dirSec.valid.filter(r => r.trueZero).length,
  }
}

function genKeysOf(ev) {
  return [...ev.directions['+'], ...ev.directions['-']].map(h => h.genKey)
}

// 资料版差异：动作调整 / 探头更换 / 校准更正 / 对时更新 / 留存窗滑动
function diffModels(oldM, newM) {
  const causes = []
  for (const [id, a] of newM.actions) {
    const o = oldM.actions.get(id)
    if (!o) { causes.push(`新动作 ${id}（${a.condition} [${a.from},${a.until}) ${a.status}）`); continue }
    if (o.from !== a.from || o.until !== a.until) causes.push(`动作${id} 窗口 [${o.from},${o.until}) → [${a.from},${a.until})`)
    if (o.status !== a.status) causes.push(`动作${id} 状态 ${o.status} → ${a.status}`)
    if (o.condition !== a.condition) causes.push(`动作${id} 工况 ${o.condition} → ${a.condition}`)
  }
  for (const id of oldM.actions.keys()) if (!newM.actions.has(id)) causes.push(`动作${id} 已移除`)
  const laneKey = l => `${l.genKey}/${l.head}/${l.lane}/${l.direction}/${l.condition}`
  const oldLanes = new Set(oldM.lanes.map(laneKey))
  const newLanes = new Set(newM.lanes.map(laneKey))
  for (const l of newM.lanes) if (!oldLanes.has(laneKey(l))) causes.push(`采样头新增 ${laneKey(l)}`)
  for (const l of oldM.lanes) if (!newLanes.has(laneKey(l))) causes.push(`探头更换/移除 ${laneKey(l)}`)
  for (const [gk, segs] of newM.sync) {
    const o = oldM.sync.get(gk) ?? []
    if (JSON.stringify(o) !== JSON.stringify(segs)) causes.push(`对时更新 ${gk}（${o.length}段 → ${segs.length}段）`)
  }
  for (const [gk, cals] of newM.calibration) {
    const o = oldM.calibration.get(gk) ?? []
    if (JSON.stringify(o) !== JSON.stringify(cals)) {
      causes.push(`校准更正 ${gk}（${o.map(c => c.id).join(',') || '无'} → ${cals.map(c => c.id).join(',') || '无'}）`)
    }
  }
  for (const gk of oldM.calibration.keys()) if (!newM.calibration.has(gk)) causes.push(`校准撤回 ${gk}`)
  for (const [gk, ret] of newM.retention) {
    const o = oldM.retention.get(gk)
    if (o && (o.from !== ret.from || o.until !== ret.until)) {
      causes.push(`留存窗滑动 ${gk} [${o.from},${o.until}) → [${ret.from},${ret.until})`)
    }
  }
  return causes
}

function relevantCauses(causes, actionId, genKeys) {
  return causes.filter(c =>
    c.includes(`动作${actionId} `) || c.includes(`动作${actionId}（`) ||
    genKeys.some(gk => c.includes(` ${gk} `) || c.includes(` ${gk}（`)))
}

function findSavedHome(model, mediaId) {
  for (const [genKey, bySecond] of model.saved) {
    for (const [second, id] of bySecond) {
      if (id === mediaId) return { genKey, second }
    }
  }
  return null
}

function rememberRetention(state, genKey, error) {
  const kept = state.quota[genKey] ?? { remaining: null, budget: null, retention: null }
  if (Number.isInteger(error.start) && Number.isInteger(error.stop)) kept.retention = [error.start, error.stop]
  state.quota[genKey] = kept
}

function fetchSummary(model, state, run, firstPass, cached) {
  const summary = {}
  const gens = new Set([...Object.keys(run.fetched), ...Object.keys(run.media), ...firstPass.perGen.keys()])
  for (const genKey of gens) {
    const ret = model.retention.get(genKey)
    const entry = firstPass.perGen.get(genKey)
    summary[genKey] = {
      retention: ret ? [ret.from, ret.until] : null,
      budget: ret?.budget ?? null,
      remaining: state.quota[genKey]?.remaining ?? null,
      fetched: (run.fetched[genKey] ?? []).slice().sort((a, b) => a - b),
      media: (run.media[genKey] ?? []).slice().sort((a, b) => a - b),
      reused: (entry?.cached ?? []).map(i => i.second),
      gaps: (run.gaps[genKey] ?? []).slice().sort((a, b) => a.second - b.second),
      lost: (run.lost[genKey] ?? []).slice().sort((a, b) => a.second - b.second),
      heldOutsideRetention: [...(cached.get(genKey) ?? [])]
        .filter(s => ret && (s < ret.from || s >= ret.until))
        .sort((a, b) => a - b),
    }
  }
  return summary
}

function demandSummary(demand) {
  const shared = []
  for (const [genKey, bySecond] of demand) {
    for (const [second, info] of bySecond) {
      if (info.plans.size > 1) shared.push({ packet: packetKey(genKey, second), plans: [...info.plans].sort() })
    }
  }
  return { shared: shared.sort((a, b) => a.packet.localeCompare(b.packet)) }
}

function buildHandover(state, model, run, cached, demand, issued, maintained, overturned, consumedReports) {
  // 已实际拿到的包
  const held = {}
  for (const [genKey, seconds] of cached) {
    const ret = model.retention.get(genKey)
    held[genKey] = [...seconds].sort((a, b) => a - b).map(second => {
      const meta = state.packets[packetKey(genKey, second)] ?? {}
      return {
        second,
        origin: meta.origin ?? 'fetch',
        mediaId: meta.mediaId ?? null,
        outsideRetention: ret ? second < ret.from || second >= ret.until : false,
      }
    })
  }
  // 取消/未确认动作的原件保留说明（不因取消或工况未确认删除原件）
  const preserved = []
  for (const action of model.actions.values()) {
    if (action.status !== 'cancelled') continue
    const plan = model.plans.get(action.plan)
    if (!plan) continue
    const heads = headsFor(action, plan, model)
    const kept = []
    for (const h of [...heads['+'], ...heads['-']]) {
      for (const s of localSecondsForFieldWindow(model, h.genKey, action.from, action.until)) {
        if (cached.get(h.genKey)?.has(s)) kept.push(packetKey(h.genKey, s))
      }
    }
    preserved.push({ action: action.id, kept: [...new Set(kept)].sort(), note: '已取消：在库原件保留，不删除、不作测计' })
  }
  return {
    seq: run.seq, edition: run.edition,
    held,
    gaps: run.gaps,
    lost: run.lost,
    quota: state.quota,
    acceptances: Object.values(state.acceptances),
    issued: issued.map(c => c.id),
    maintained,
    overturned,
    consumed: consumedReports,
    preserved,
    sharedDemand: demandSummary(demand).shared,
  }
}

function addCached(cached, genKey, second) {
  if (!cached.has(genKey)) cached.set(genKey, new Set())
  cached.get(genKey).add(second)
}

function push(map, key, value) {
  if (!map[key]) map[key] = []
  map[key].push(value)
}

function pushGap(run, genKey, second, reason) {
  push(run.gaps, genKey, { second, reason })
}

function pushLost(run, genKey, second) {
  push(run.lost, genKey, { second })
}
