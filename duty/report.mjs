// 轮报与交班凭据的中文文本渲染。
const DIR_NAME = { '+': '＋向', '-': '－向' }

export function renderRound(report) {
  const lines = []
  lines.push(`══ 采集轮报 #${report.seq} ｜ 资料版 ${report.edition}${report.transition ? ' ｜ 资料版已变更' : ''} ══`)
  if (report.transition && report.changes.length) {
    lines.push('◆ 资料变更')
    for (const c of report.changes) lines.push(`  · ${c}`)
  }
  if (report.revalidated?.length) {
    lines.push(`◆ 资料未变（条件请求复用）：${report.revalidated.join('、')}`)
  }
  lines.push('◆ 领取（共用额度按班计，更早失去先收）')
  for (const [genKey, f] of Object.entries(report.fetch)) {
    const parts = []
    if (f.retention) parts.push(`留存[${f.retention[0]},${f.retention[1]})`)
    if (f.budget !== null) parts.push(`额度${f.remaining ?? '?'}/${f.budget}`)
    if (f.fetched.length) parts.push(`取回 ${f.fetched.join(',')}`)
    if (f.media.length) parts.push(`原件复用 ${f.media.join(',')}`)
    if (f.reused.length) parts.push(`在库复用 ${f.reused.join(',')}`)
    if (f.heldOutsideRetention.length) parts.push(`留存已越过·在库保护 ${f.heldOutsideRetention.join(',')}`)
    for (const g of f.gaps) parts.push(`缺口 ${g.second}（${g.reason}）`)
    for (const l of f.lost) parts.push(`已失去 ${l.second}`)
    lines.push(`  ${genKey}：${parts.join('；') || '无需求'}`)
  }
  if (report.demand.shared.length) {
    lines.push('◆ 共享原料（同一包支持多个试验）')
    for (const s of report.demand.shared) lines.push(`  · ${s.packet} ← 试验 ${s.plans.join('、')}`)
  }
  lines.push('◆ 认定与测计')
  for (const a of report.actions) {
    lines.push(`  ${a.id} [${a.window[0]},${a.window[1]}) ${a.status} ｜ ${a.reason}${a.credential ? `（凭据 ${a.credential}）` : ''}`)
    if (a.measurable && a.decision !== 'cancelled') {
      for (const [fs, sec] of Object.entries(a.seconds)) {
        lines.push(`    现场秒${fs}：${DIR_NAME['+']} ${tallyText(sec['+'])} ｜ ${DIR_NAME['-']} ${tallyText(sec['-'])} → ${sec.covered ? '✓' : '✗'}`)
      }
    }
  }
  if (report.issued.length || report.maintained.length) {
    lines.push('◆ 验收领取')
    for (const c of report.issued) lines.push(`  · 新发 ${c.id} ← ${c.action} [${c.window[0]},${c.window[1]})，证据 ${c.evidence.join('、')}`)
    if (report.maintained.length) lines.push(`  · 维持 ${report.maintained.join('、')}`)
  }
  if (report.overturned.length || report.consumed.length) {
    lines.push('◆ 推翻与交接')
    for (const o of report.overturned) {
      lines.push(`  · 凭据 ${o.credential.id}（动作 ${o.credential.action}）结论被推翻`)
      for (const c of o.causes) lines.push(`    起因：${c}`)
      for (const p of o.periods) lines.push(`    现场秒${p.second}：${periodText(p)}`)
    }
    for (const c of report.consumed) {
      lines.push(`  · 交接凭据 ${c.handover}（动作 ${c.action}，原件 ${c.media.join('、') || '无'}）${c.shaken ? '证据基础动摇' : '证据仍成立'}`)
      for (const cause of c.causes) lines.push(`    起因：${cause}`)
      for (const p of c.periods) lines.push(`    现场秒${p.second}：${periodText(p)}`)
    }
  }
  return lines.join('\n')
}

export function renderHandover(handover) {
  const lines = []
  lines.push(`══ 交班凭据 ｜ 第 ${handover.seq} 轮后 ｜ 资料版 ${handover.edition} ══`)
  lines.push('◆ 已实际拿到的原包（在库）')
  for (const [genKey, items] of Object.entries(handover.held)) {
    const text = items.map(i => {
      let s = String(i.second)
      if (i.mediaId) s += `(=原件${i.mediaId})`
      if (i.outsideRetention) s += '［留存已越过·在库保护］'
      return s
    }).join('、')
    lines.push(`  ${genKey}：${text || '无'}`)
  }
  lines.push('◆ 仍应尝试的缺口')
  lines.push(gapText(handover.gaps))
  lines.push('◆ 已失去')
  lines.push(lostText(handover.lost))
  lines.push('◆ 额度余量（按班·设备代）')
  for (const [genKey, q] of Object.entries(handover.quota)) {
    lines.push(`  ${genKey}：余 ${q.remaining ?? '?'}${q.budget !== null ? ` / 预算 ${q.budget}` : ''}`)
  }
  lines.push('◆ 已发验收领取')
  if (handover.acceptances.length) {
    for (const c of handover.acceptances) lines.push(`  · ${c.id} ← ${c.action} [${c.window[0]},${c.window[1]})，证据 ${c.evidence.join('、')}`)
  } else lines.push('  无')
  if (handover.overturned.length || handover.consumed.some(c => c.shaken)) {
    lines.push('◆ 交接关注')
    for (const o of handover.overturned) lines.push(`  · ${o.credential.id}（${o.credential.action}）被推翻：${periodSummary(o.periods)}`)
    for (const c of handover.consumed.filter(c => c.shaken)) lines.push(`  · ${c.handover}（${c.action}）：${periodSummary(c.periods)}`)
  }
  if (handover.preserved.length) {
    lines.push('◆ 保留备查（不作测计）')
    for (const p of handover.preserved) lines.push(`  · ${p.action}：${p.kept.join('、') || '无在库原件'} —— ${p.note}`)
  }
  return lines.join('\n')
}

function tallyText(t) {
  const parts = [`有效${t.valid}`]
  if (t.dropped) parts.push(`掉样${t.dropped}`)
  if (t.pending) parts.push(`待验${t.pending}`)
  if (t.zero) parts.push(`含真零${t.zero}`)
  return parts.join(' ')
}

function periodText(p) {
  const map = {
    confirmed: '确认中',
    'pending-calibration': '待校准补交',
    'dropped-short': '掉样不足',
    recollectable: '可补领',
    lost: '已失去',
    'not-yet': '尚未到窗',
    'no-head': '缺方向采样头',
    'out-of-window': '已退出动作窗口',
  }
  return (map[p.status] ?? p.status) + (p.detail ? `（${p.detail}）` : '')
}

function periodSummary(periods) {
  const open = periods.filter(p => p.status !== 'confirmed')
  if (!open.length) return '各时段确认中'
  return open.map(p => `现场秒${p.second} ${periodText(p)}`).join('；')
}

function gapText(gaps) {
  const entries = Object.entries(gaps).filter(([, list]) => list.length)
  if (!entries.length) return '  无'
  return entries.map(([genKey, list]) =>
    `  ${genKey}：${list.map(g => `${g.second}（${g.reason}）`).join('、')}`).join('\n')
}

function lostText(lost) {
  const entries = Object.entries(lost).filter(([, list]) => list.length)
  if (!entries.length) return '  无'
  return entries.map(([genKey, list]) =>
    `  ${genKey}：${list.map(l => l.second).join('、')}`).join('\n')
}
