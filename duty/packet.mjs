// GWPK 原包编解码。页头：ASCII GWPK + 版本1 + 记录数。
// 每条记录：4字节本地秒 + 1字节样本数 + 2字节有效掩码，随后每样本 2字节流量 + 2字节温度（小端带符号）。
// 掩码自低位起对应各样本；0 值可以有效，对应位为 0 时读数无效（掉样）。
const MAGIC = Buffer.from('GWPK')

export function decodePacket(buffer) {
  if (buffer.length < 6 || !buffer.subarray(0, 4).equals(MAGIC)) throw new Error('不是 GWPK 原包')
  const version = buffer.readUInt8(4)
  const count = buffer.readUInt8(5)
  let offset = 6
  const records = []
  for (let r = 0; r < count; r++) {
    if (offset + 7 > buffer.length) throw new Error('原包记录截断')
    const second = buffer.readUInt32LE(offset)
    const n = buffer.readUInt8(offset + 4)
    const mask = buffer.readUInt16LE(offset + 5)
    offset += 7
    if (offset + n * 4 > buffer.length) throw new Error('原包样本截断')
    const samples = []
    for (let i = 0; i < n; i++) {
      samples.push({
        flow: buffer.readInt16LE(offset),
        temperature: buffer.readInt16LE(offset + 2),
        valid: (mask & (1 << i)) !== 0,
      })
      offset += 4
    }
    records.push({ second, samples })
  }
  if (offset !== buffer.length) throw new Error('原包长度不符')
  return { version, records }
}

export function encodePacket(records) {
  const parts = [Buffer.from('GWPK'), Buffer.from([1, records.length])]
  for (const record of records) {
    const n = record.samples.length
    let mask = 0
    record.samples.forEach((sample, i) => { if (sample.valid) mask |= 1 << i })
    const body = Buffer.alloc(7 + n * 4)
    body.writeUInt32LE(record.second >>> 0, 0)
    body.writeUInt8(n, 4)
    body.writeUInt16LE(mask, 5)
    record.samples.forEach((sample, i) => {
      body.writeInt16LE(sample.flow, 7 + i * 4)
      body.writeInt16LE(sample.temperature, 9 + i * 4)
    })
    parts.push(body)
  }
  return Buffer.concat(parts)
}
