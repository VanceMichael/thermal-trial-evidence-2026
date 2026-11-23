// 领取计划：几个试验一起登记，需求合并去重（同一个包同时支持多个试验），
// 共用额度按“确实更早失去的有效来源窗先收；消失边界相同依计划优先序”排序。

// 现场秒窗口 [fsFrom, fsUntil) 映射回某设备代需要留存的本地秒。
export function localSecondsForFieldWindow(model, genKey, fsFrom, fsUntil) {
  const out = new Set()
  for (const seg of model.sync.get(genKey) ?? []) {
    for (let s = seg.from; s < seg.until; s++) {
      const ms0 = seg.fieldMsStart + (s - seg.from) * seg.rate
      const ms1 = ms0 + seg.rate
      if (ms0 < fsUntil * 1000 && ms1 > fsFrom * 1000) out.add(s)
    }
  }
  return out
}

// 需求：genKey → second → { plans: Set }。
// 计划全部动作被取消的，不再占用额度（在库原件仍保留）；尚无动作的计划按登记时段保护流道全部采样头。
export function buildDemand(model) {
  const demand = new Map()
  const plans = [...model.plans.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  for (const plan of plans) {
    const acts = [...model.actions.values()].filter(a => a.plan === plan.id)
    const active = acts.filter(a => a.status !== 'cancelled')
    if (acts.length > 0 && active.length === 0) continue
    const conditions = acts.length === 0 ? null : new Set(active.map(a => a.condition))
    const heads = model.lanes.filter(l => l.lane === plan.lane && (conditions === null || conditions.has(l.condition)))
    for (const head of heads) {
      for (const second of localSecondsForFieldWindow(model, head.genKey, plan.from, plan.until)) {
        if (!demand.has(head.genKey)) demand.set(head.genKey, new Map())
        const bySecond = demand.get(head.genKey)
        if (!bySecond.has(second)) bySecond.set(second, { plans: new Set() })
        bySecond.get(second).plans.add(plan.id)
      }
    }
  }
  return demand
}

// 对账：需求 − 在库 − 可复用原件 − 留存窗 ⇒ 领取/缺口的分类。
// cached: Map genKey → Set(second)
export function reconcile(model, demand, cached) {
  const perGen = new Map()
  const order = []
  for (const [genKey, seconds] of demand) {
    const ret = model.retention.get(genKey)
    const savedMap = model.saved.get(genKey)
    const entry = { cached: [], media: [], fetch: [], lost: [], future: [] }
    for (const [second, info] of [...seconds.entries()].sort((a, b) => a[0] - b[0])) {
      const item = { second, plans: [...info.plans] }
      if (cached.get(genKey)?.has(second)) { entry.cached.push(item); continue }
      const mediaId = savedMap?.get(second)
      if (mediaId) { entry.media.push({ ...item, mediaId }); continue }
      if (!ret || second < ret.from) { entry.lost.push(item); continue }
      if (second >= ret.until) { entry.future.push(item); continue }
      entry.fetch.push(item)
      order.push({
        genKey, second, plans: item.plans,
        risk: second - ret.from, // 距留存下沿越近，越早被覆盖
        priority: Math.min(...item.plans.map(p => model.plans.get(p)?.priority ?? 99)),
      })
    }
    perGen.set(genKey, entry)
  }
  // 更早失去先收；消失边界相同依计划优先序
  order.sort((a, b) => a.risk - b.risk || a.priority - b.priority
    || a.genKey.localeCompare(b.genKey) || a.second - b.second)
  return { perGen, order }
}

// 把排序后的领取项按设备代合成连续段（一次领一段，翻页中断时已到数据不丢）。
export function runsInOrder(order) {
  const byGen = new Map()
  order.forEach((item, index) => {
    if (!byGen.has(item.genKey)) byGen.set(item.genKey, [])
    byGen.get(item.genKey).push({ second: item.second, index })
  })
  const runs = []
  for (const [genKey, items] of byGen) {
    let start = null, prev = null, rank = Infinity
    const flush = () => { if (start !== null) runs.push({ genKey, from: start, until: prev + 1, rank }) }
    for (const { second, index } of items) {
      rank = Math.min(rank, index)
      if (start === null) { start = second; prev = second; continue }
      if (second === prev + 1) { prev = second; continue }
      flush()
      start = second; prev = second
    }
    flush()
  }
  return runs.sort((a, b) => a.rank - b.rank)
}
