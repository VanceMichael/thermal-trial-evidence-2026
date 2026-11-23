import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// 值班台账：原包按“设备代@本地秒”存盘，状态进 state.json。
// 已到的数据随取随存，不随某轮领取失败消失；换班/换版后在库原包继续复用。
const EMPTY = () => ({
  edition: null,
  etags: {},       // 数据流 → { etag, rows }（条件请求复用）
  packets: {},     // 包键 → { origin: 'fetch'|'media', mediaId?, run }
  quota: {},       // 设备代 → { remaining, budget, retention: [from, until] }
  acceptances: {}, // 动作 → 已发验收领取凭据
  credentialSeq: 0,
  runSeq: 0,
  runs: [],
})

export function packetKey(genKey, second) {
  return `${genKey}@${second}`
}

export function parsePacketKey(key) {
  const at = key.lastIndexOf('@')
  return { genKey: key.slice(0, at), second: Number(key.slice(at + 1)) }
}

export class Store {
  constructor(dir) {
    this.dir = dir
    this.state = EMPTY()
  }

  async load() {
    await mkdir(join(this.dir, 'packets'), { recursive: true })
    await mkdir(join(this.dir, 'reports'), { recursive: true })
    try {
      this.state = { ...EMPTY(), ...JSON.parse(await readFile(join(this.dir, 'state.json'), 'utf8')) }
    } catch { /* 首次值班：空台账 */ }
    return this.state
  }

  async save() {
    await writeFile(join(this.dir, 'state.json'), JSON.stringify(this.state, null, 2) + '\n')
  }

  packetFile(key) {
    const { genKey, second } = parsePacketKey(key)
    return join(this.dir, 'packets', genKey.replace('/', '-') + '-' + second + '.gw')
  }

  async putPacket(key, buffer, meta) {
    await writeFile(this.packetFile(key), buffer)
    this.state.packets[key] = meta
  }

  async getPacket(key) {
    try {
      return await readFile(this.packetFile(key))
    } catch {
      return null
    }
  }

  async writeReport(name, report) {
    await writeFile(join(this.dir, 'reports', name), JSON.stringify(report, null, 2) + '\n')
  }
}
