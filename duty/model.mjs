// 资料建模与读数认定。
// 时域：原包记录按“本地秒”（网关/启动代各自的时间域）索引；动作/计划按“现场秒”。
// sync 段把本地段线性映到现场毫秒；calibration 按现场毫秒区间生效。
// 每条读数认定为：valid（有效，含真零）/ dropped（掉样）/ pending（尚未收到适用校准）/ unattributed（对时标段未覆盖）。
const num = Number

export function parseModel(streams) {
  const plans = new Map()
  for (const r of streams.plans ?? []) {
    plans.set(r[0], { id: r[0], lane: r[1], from: num(r[2]), until: num(r[3]), priority: num(r[4]) })
  }
  const actions = new Map()
  for (const r of streams.actions ?? []) {
    actions.set(r[0], { id: r[0], plan: r[1], condition: r[2], from: num(r[3]), until: num(r[4]), status: r[5] })
  }
  const lanes = (streams.lanes ?? []).map(r => ({
    gateway: r[0], generation: r[1], head: r[2], lane: r[3], direction: r[4], condition: r[5],
    genKey: r[0] + '/' + r[1],
  }))
  const retention = new Map()
  for (const r of streams.retention ?? []) {
    retention.set(r[0] + '/' + r[1], { from: num(r[2]), until: num(r[3]), budget: num(r[4]) })
  }
  const sync = new Map()
  for (const r of streams.sync ?? []) {
    push(sync, r[0] + '/' + r[1], { from: num(r[2]), until: num(r[3]), fieldMsStart: num(r[4]), rate: num(r[5]) })
  }
  const calibration = new Map()
  for (const r of streams.calibration ?? []) {
    push(calibration, r[0] + '/' + r[1], {
      from: num(r[2]), until: num(r[3]), id: r[4],
      flowScale: num(r[5]), flowOffset: num(r[6]), tempScale: num(r[7]), tempOffset: num(r[8]),
    })
  }
  const saved = new Map()
  for (const r of streams.saved ?? []) {
    const key = r[0] + '/' + r[1]
    if (!saved.has(key)) saved.set(key, new Map())
    saved.get(key).set(num(r[2]), r[3])
  }
  const consumed = (streams.consumed ?? []).map(r => ({ action: r[0], handover: r[1], media: r[2] ? r[2].split(',') : [] }))
  return { plans, actions, lanes, retention, sync, calibration, saved, consumed }
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, [])
  map.get(key).push(value)
}

// 认定一条原包记录：样本在原包内均匀分布，第一个样本在记录起点。
// 本地时刻 = second + i/n；用分子/分母做精确有理数运算，避免浮点误判边界。
export function attributeRecord(genKey, record, model) {
  const segments = model.sync.get(genKey) ?? []
  const calibrations = model.calibration.get(genKey) ?? []
  const seg = segments.find(s => s.from <= record.second && record.second < s.until)
  const n = record.samples.length
  return record.samples.map((sample, i) => {
    const reading = {
      genKey, second: record.second, index: i,
      flow: sample.flow, temperature: sample.temperature, maskValid: sample.valid,
    }
    if (!seg) {
      reading.status = 'unattributed' // 对时标段未覆盖：暂不能认到动作，原包照旧保留
      return reading
    }
    const den = n
    const numValue = seg.fieldMsStart * den + (record.second - seg.from) * seg.rate * den + i * seg.rate
    reading.fieldMsNum = numValue
    reading.fieldMsDen = den
    reading.fieldSecond = Math.floor(numValue / (den * 1000))
    if (!sample.valid) {
      reading.status = 'dropped' // 掉样：对应掩码位为 0
      return reading
    }
    const cal = calibrations.find(c => c.from * den <= numValue && numValue < c.until * den)
    if (!cal) {
      reading.status = 'pending' // 尚未收到适用校准：读数待验，校准补交后同一原包即可转正
      return reading
    }
    reading.status = 'valid'
    reading.calibrationId = cal.id
    reading.calibratedFlow = sample.flow * cal.flowScale + cal.flowOffset
    reading.calibratedTemperature = sample.temperature * cal.tempScale + cal.tempOffset
    reading.trueZero = sample.flow === 0 || sample.temperature === 0 // 真正读到零值：有效
    return reading
  })
}

// 读数按 设备代 → 现场秒 索引，供逐动作汇总。
export function indexReadings(readings) {
  const byGen = new Map()
  for (const r of readings) {
    if (r.fieldSecond === undefined) continue
    if (!byGen.has(r.genKey)) byGen.set(r.genKey, new Map())
    const bySecond = byGen.get(r.genKey)
    if (!bySecond.has(r.fieldSecond)) bySecond.set(r.fieldSecond, [])
    bySecond.get(r.fieldSecond).push(r)
  }
  return byGen
}

// 动作可用的采样头：同流道、同工况。
export function headsFor(action, plan, model) {
  const heads = model.lanes.filter(l => l.lane === plan.lane && l.condition === action.condition)
  return { '+': heads.filter(h => h.direction === '+'), '-': heads.filter(h => h.direction === '-') }
}

// 逐现场秒评估：两个方向各自至少两个“有效且有适用校准”的读数，才出这一段的测计依据。
export function evaluateAction(action, plan, model, readingIndex) {
  const directions = headsFor(action, plan, model)
  const measurable = directions['+'].length > 0 && directions['-'].length > 0
  const result = {
    action, plan, directions, measurable,
    seconds: new Map(), coveredSeconds: [], gapSeconds: [],
  }
  for (let fs = action.from; fs < action.until; fs++) {
    const sec = {
      '+': { valid: [], dropped: [], pending: [] },
      '-': { valid: [], dropped: [], pending: [] },
      covered: false,
    }
    for (const dir of ['+', '-']) {
      for (const head of directions[dir]) {
        for (const r of readingIndex.get(head.genKey)?.get(fs) ?? []) {
          if (r.status === 'valid') sec[dir].valid.push(r)
          else if (r.status === 'dropped') sec[dir].dropped.push(r)
          else if (r.status === 'pending') sec[dir].pending.push(r)
        }
      }
    }
    sec.covered = sec['+'].valid.length >= 2 && sec['-'].valid.length >= 2
    result.seconds.set(fs, sec)
    ;(sec.covered ? result.coveredSeconds : result.gapSeconds).push(fs)
  }
  result.covered = result.measurable && action.from < action.until && result.gapSeconds.length === 0
  result.eligible = action.status === 'signed' && result.covered
  return result
}
