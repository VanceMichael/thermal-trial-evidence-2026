import { decodePacket } from './packet.mjs'

// 来源客户端：目录、数据流（分页 + ETag 条件请求）、网关原包（越期/限额容错）、已备份原件。
export class SourceClient {
  constructor(root, { onRequest } = {}) {
    this.root = root.replace(/\/$/, '')
    this.onRequest = onRequest ?? (() => {})
  }

  async #get(path, headers = {}) {
    this.onRequest(path)
    return fetch(this.root + path, { headers })
  }

  async catalog() {
    const res = await this.#get('/catalog')
    if (res.status !== 200) throw new Error('目录不可用: ' + res.status)
    return res.json()
  }

  // 拉取整个数据流。带 ETag 时服务端 304 表示资料未变，可复用本地行。
  async stream(name, etag) {
    const headers = etag ? { 'If-None-Match': etag } : {}
    let res = await this.#get('/records/' + name, headers)
    if (res.status === 304) return { notModified: true }
    if (res.status !== 200) throw new Error(`数据流 ${name} 读取失败: ${res.status}`)
    const firstEtag = res.headers.get('etag')
    const rows = []
    for (;;) {
      const text = await res.text()
      rows.push(...text.split('\n').filter(Boolean).map(line => line.split('\t')))
      const next = nextLink(res)
      if (!next) break
      res = await this.#get(next)
      if (res.status !== 200) throw new Error(`数据流 ${name} 翻页失败: ${res.status}`)
    }
    return { rows, etag: firstEtag }
  }

  // 领取网关原包。可能先到前几页再报越期(410)或限额(429)：已到的记录照常返回，不丢。
  // 返回 { records, remaining, error }；error 含网关返回的 start/stop/remaining 等细节。
  async samples(key, generation, from, until) {
    const records = []
    let remaining = null
    let path = `/records/samples?key=${encodeURIComponent(key)}&generation=${encodeURIComponent(generation)}&from=${from}&until=${until}`
    for (;;) {
      const res = await this.#get(path)
      if (res.status !== 200) {
        const error = { code: res.status, message: '网关拒绝' }
        try { Object.assign(error, await res.json()) } catch { /* 非 JSON 错误体 */ }
        if (Number.isInteger(error.remaining)) remaining = error.remaining
        return { records, remaining, error }
      }
      const header = res.headers.get('x-remaining-seconds')
      if (header !== null) remaining = Number(header)
      const body = Buffer.from(await res.arrayBuffer())
      records.push(...decodePacket(body).records)
      const next = nextLink(res)
      if (!next) return { records, remaining, error: null }
      path = next
    }
  }

  // 历史已备份的原件：不占采集额。
  async media(id) {
    const res = await this.#get('/media/' + encodeURIComponent(id) + '.gw')
    if (res.status !== 200) throw new Error('原件不可用: ' + id)
    return Buffer.from(await res.arrayBuffer())
  }
}

function nextLink(res) {
  const link = res.headers.get('link')
  const match = link && /^<([^>]+)>;\s*rel="next"/.exec(link)
  return match ? match[1] : null
}
