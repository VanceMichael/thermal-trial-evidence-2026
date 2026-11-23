import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSource } from '../source/source.mjs'
import { runRound } from '../duty/collector.mjs'
import { SourceClient } from '../duty/client.mjs'
import { decodePacket, encodePacket } from '../duty/packet.mjs'

async function listen(t) {
  const server = createSource()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return { root: 'http://127.0.0.1:' + server.address().port }
}

async function stateDir() {
  return mkdtemp(join(tmpdir(), 'duty-'))
}

async function setEdition(root, edition) {
  const res = await fetch(`${root}/control?edition=${edition}`, { method: 'POST' })
  assert.equal(res.status, 200)
}

const actionOf = (report, id) => report.actions.find(a => a.id === id)
const secondsOf = obj => (obj ?? []).map(x => x.second ?? x).sort((a, b) => a - b)

test('原包编解码往返一致，掩码与真零分别保留', () => {
  const records = [
    { second: 1, samples: [
      { flow: 0, temperature: 101, valid: true },   // 真零流量：有效
      { flow: -14, temperature: 96, valid: true },
      { flow: -16, temperature: 94, valid: false }, // 掉样
    ] },
    { second: 2, samples: [{ flow: 7, temperature: 90, valid: true }] },
  ]
  const round = decodePacket(encodePacket(records))
  assert.deepEqual(round.records, records)
  assert.equal(round.records[0].samples[0].flow, 0)
  assert.equal(round.records[0].samples[0].valid, true)
  assert.equal(round.records[0].samples[2].valid, false)
})

test('首轮：多试验一起登记，按需领取、共用额度、保护未签原料', async t => {
  const { root } = await listen(t)
  const dir = await stateDir()
  const requests = []
  const client = new SourceClient(root, { onRequest: p => requests.push(p) })
  const { report, handover } = await runRound({ root, stateDir: dir, client })

  // 领取：各自时域内真正保留的原包；已备份原件免费复用；额度按班共用
  assert.deepEqual(secondsOf(report.fetch['G/a'].fetched), [0, 1, 3, 4])
  assert.deepEqual(secondsOf(report.fetch['G/a'].media), [2])
  assert.deepEqual(secondsOf(report.fetch['H/b'].fetched), [1, 2, 4, 5])
  assert.deepEqual(secondsOf(report.fetch['H/b'].media), [3])
  assert.deepEqual(secondsOf(report.fetch['J/a'].fetched), [0, 1])
  // 额度尽：缺口留给下班再试；网关无记录的秒单独标明
  assert.deepEqual(report.fetch['G/a'].gaps, [{ second: 5, reason: '额度不足' }])
  assert.deepEqual(report.fetch['H/b'].gaps, [{ second: 6, reason: '额度不足' }])
  assert.deepEqual(report.fetch['J/a'].gaps.map(g => g.second), [2, 3])
  assert.equal(report.fetch['G/a'].remaining, 0)
  assert.equal(report.fetch['J/a'].remaining, 2)
  // H/a（旧采样头）时域不在任何登记窗内：一轮都不去碰它的额度
  assert.ok(!requests.some(p => p.includes('key=H&generation=a')))

  // 认定：A 未签只保护不交测计；B 掉样致缺不予验收；Z1 缺方向不能出测计
  assert.equal(actionOf(report, 'A').decision, 'protect')
  assert.equal(actionOf(report, 'B').decision, 'withhold')
  // 现场秒103 掉样致缺；现场秒105 因额度尽、两个方向的包都没领到
  assert.deepEqual(actionOf(report, 'B').gapSeconds, [103, 105])
  assert.equal(actionOf(report, 'B').seconds['105']['+'].valid, 0)
  assert.equal(actionOf(report, 'Z1').decision, 'impossible')
  // 掉样 / 真零 区分：现场秒103 －向 有效1 掉样2；现场秒101 ＋向含真零有效读数
  assert.deepEqual(actionOf(report, 'B').seconds['103']['-'], { valid: 1, dropped: 2, pending: 0, zero: 0 })
  assert.equal(actionOf(report, 'A').seconds['101']['+'].zero, 1)
  assert.equal(actionOf(report, 'A').seconds['101']['+'].valid, 2)

  // 同一个包同时支持多个试验
  assert.ok(report.demand.shared.some(s => s.packet === 'G/a@2' && s.plans.join(',') === 'P,Q'))
  assert.ok(report.demand.shared.some(s => s.packet === 'H/b@4' && s.plans.join(',') === 'P,Q'))

  // 交班：已拿到的包与仍应尝试的缺口都留痕
  assert.deepEqual(handover.held['G/a'].map(i => i.second), [0, 1, 2, 3, 4])
  assert.equal(handover.held['G/a'].find(i => i.second === 2).mediaId, 'g2')
  assert.deepEqual(handover.held['J/a'].map(i => i.second), [0, 1])
  assert.equal(handover.acceptances.length, 0)

  // 原包已落盘，可到岗外重新读取
  const packet = decodePacket(await readFile(join(dir, 'packets', 'G-a-0.gw')))
  assert.equal(packet.records[0].second, 0)
  assert.equal(packet.records[0].samples.length, 2)
})

test('资料版变更：在库原包重新认定不重复领取，校准更正推翻已交结论', async t => {
  const { root } = await listen(t)
  const dir = await stateDir()
  const first = await runRound({ root, stateDir: dir })
  assert.equal(first.report.edition, 'r1')

  await setEdition(root, 'r2')
  const requests = []
  const client = new SourceClient(root, { onRequest: p => requests.push(p) })
  const { report, handover, state } = await runRound({ root, stateDir: dir, client })

  assert.equal(report.transition, true)
  assert.ok(report.changes.some(c => c.includes('校准更正 H/b')))
  assert.ok(report.changes.some(c => c.includes('对时更新 H/b')))
  assert.ok(report.changes.some(c => c.includes('动作A 窗口 [100,104) → [100,102)')))

  // 对时/校准补交：同一批在库原包支持新时段，只补领真正缺的秒
  assert.deepEqual(secondsOf(report.fetch['G/a'].fetched), [5])
  assert.deepEqual(secondsOf(report.fetch['H/b'].fetched), [6])
  assert.deepEqual(report.fetch['G/a'].reused, [0, 1, 2, 3, 4])
  const sampleRequests = requests.filter(p => p.startsWith('/records/samples'))
  assert.ok(!sampleRequests.some(p => p.includes('from=0'))) // 在库秒不再向网关领取
  // 留存已越过的在库包：在库保护，不记失去
  assert.deepEqual(report.fetch['G/a'].heldOutsideRetention, [0])
  assert.deepEqual(report.fetch['H/b'].heldOutsideRetention, [1])

  // 动作 A 签出且窗口收窄：全覆盖 → 验收领取
  const a = actionOf(report, 'A')
  assert.equal(a.decision, 'accept')
  assert.equal(a.credential, 'AC1')
  const ac1 = report.issued.find(c => c.id === 'AC1')
  assert.deepEqual(ac1.evidence, ['G/a@0', 'G/a@1', 'H/b@1', 'H/b@2'])
  // 新工况无对应采样头：不能出测计
  assert.equal(actionOf(report, 'A2').decision, 'impossible')
  // B：校准更正后现场秒102 －向读数待验
  assert.equal(actionOf(report, 'B').decision, 'withhold')
  assert.deepEqual(actionOf(report, 'B').seconds['102']['-'], { valid: 0, dropped: 0, pending: 3, zero: 0 })
  // 已取消动作：原件保留备查
  assert.equal(actionOf(report, 'Z1').decision, 'cancelled')
  assert.deepEqual(handover.preserved.find(p => p.action === 'Z1').kept, ['J/a@0', 'J/a@1'])

  // 已交结论 F14 被校准更正动摇：给出交接凭据与时段处置
  const f14 = report.consumed.find(c => c.handover === 'F14')
  assert.equal(f14.shaken, true)
  assert.ok(f14.causes.some(c => c.includes('校准更正 H/b')))
  assert.equal(f14.periods.find(p => p.second === 102).status, 'pending-calibration')
  assert.equal(f14.periods.find(p => p.second === 103).status, 'confirmed')
  assert.equal(f14.periods.find(p => p.second === 105).status, 'confirmed')
  assert.ok(!f14.periods.some(p => p.status === 'lost')) // 原料全部在库，无已失去时段

  // 已到数据不随轮次消失：首轮在库的包全部仍在
  for (const key of Object.keys(first.state.packets)) assert.ok(state.packets[key], key)

  // 同版再来一轮：条件请求 304 复用，无任何领取
  const again = await runRound({ root, stateDir: dir, client })
  assert.equal(again.report.revalidated.length, 8)
  assert.deepEqual(Object.values(again.report.fetch).flatMap(f => f.fetched), [])
  assert.deepEqual(again.report.maintained, ['AC1'])
})

test('推翻自有验收：动作调整使已发领取退回保护', async t => {
  const { root } = await listen(t)
  const dir = await stateDir()
  await runRound({ root, stateDir: dir })          // r1：保护性领取
  await setEdition(root, 'r2')
  const second = await runRound({ root, stateDir: dir })
  assert.equal(second.report.issued[0].id, 'AC1')  // r2：A 获验收领取

  await setEdition(root, 'r1')                     // 业务方切回初始资料
  const third = await runRound({ root, stateDir: dir })
  assert.equal(third.report.transition, true)
  assert.equal(actionOf(third.report, 'A').decision, 'protect')
  assert.equal(third.report.overturned.length, 1)
  const overturn = third.report.overturned[0]
  assert.equal(overturn.credential.id, 'AC1')
  assert.ok(overturn.causes.some(c => c.includes('动作A 状态 signed → provisional')))
  assert.ok(overturn.causes.some(c => c.includes('动作A 窗口 [100,102) → [100,104)')))
  // 原窗口各时段证据仍确认中（是动作状态回退，不是证据灭失）
  assert.deepEqual(overturn.periods.map(p => p.status), ['confirmed', 'confirmed'])
  // 全部需求仍在库：本轮没有任何在线领取
  assert.deepEqual(Object.values(third.report.fetch).flatMap(f => f.fetched), [])
})

test('迟到的值班：签完才下载，前半段已越过留存窗', async t => {
  const { root } = await listen(t)
  await setEdition(root, 'r2')                     // 直接进入第二班
  const dir = await stateDir()                     // 空台账：此前没有任何保护性领取
  const { report, handover } = await runRound({ root, stateDir: dir })

  // 已失去：A 的前半段原包在上一班被覆盖
  assert.deepEqual(secondsOf(report.fetch['G/a'].lost), [0])
  assert.deepEqual(secondsOf(report.fetch['H/b'].lost), [1])
  assert.deepEqual(handover.lost['G/a'].map(l => l.second), [0])
  assert.deepEqual(handover.lost['H/b'].map(l => l.second), [1])
  // A 因现场秒100 两个方向都无有效读数而不予验收；
  // 现场秒101 也因 H/b@1 灭失（101.17 读数随之失去）只剩 1 个有效读数
  const a = actionOf(report, 'A')
  assert.equal(a.decision, 'withhold')
  assert.deepEqual(a.gapSeconds, [100, 101])
  assert.equal(a.seconds['100']['+'].valid, 0)
  assert.equal(a.seconds['100']['-'].valid, 0)
  assert.equal(a.seconds['101']['-'].valid, 1)
  // 额度仍按班共用：G/a 预算3，先收更早失去的秒，余下记缺口
  assert.deepEqual(secondsOf(report.fetch['G/a'].fetched), [1, 3, 4])
  assert.deepEqual(report.fetch['G/a'].gaps, [{ second: 5, reason: '额度不足' }])
  assert.deepEqual(secondsOf(report.fetch['H/b'].fetched), [2, 4, 5])
  assert.deepEqual(report.fetch['H/b'].gaps, [{ second: 6, reason: '额度不足' }])
})
