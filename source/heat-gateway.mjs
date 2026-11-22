function quantities(rows, gateway, generation) {
  const row = rows.find(row => row[0] === gateway && row[1] === generation)
  return row ? row.slice(2).map(Number) : null
}

export function newGateway() {
  const issued = new Map()
  return function canRead(url, release, page) {
    const key = url.searchParams.get('key')
    const gen = url.searchParams.get('generation')
    const from = url.searchParams.get('from')
    const until = url.searchParams.get('until')
    if (!key || !gen || from === null || until === null || Number(until) <= Number(from)) {
      return { code: 422, message: '网关明细需要设备代和非空区间' }
    }
    const interval = quantities(release.streams.retention, key, gen)
    if (!interval) return { code: 404, message: '未找到该设备代' }
    const [start, stop, budget] = interval
    if (Number(from) < start || Number(until) > stop) {
      return { code: 410, message: '请求超出当前留存区间', start, stop }
    }
    const usageKey = JSON.stringify([release.edition, key, gen])
    const used = issued.get(usageKey) ?? new Set()
    const demands = new Set(page.rows.map(row => Number(row[2])))
    const net = [...demands].filter(second => !used.has(second))
    if (used.size + net.length > budget) {
      return { code: 429, message: '当班取数额度不足', remaining: budget - used.size }
    }
    for (const second of net) used.add(second)
    issued.set(usageKey, used)
    return { code: 200, remaining: budget - used.size }
  }
}
