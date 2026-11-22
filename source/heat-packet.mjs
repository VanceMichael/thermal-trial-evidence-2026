function encodeRecord(record) {
  const [, , second, flow, temperature, mask] = record
  const channels = flow.split(',').map(Number)
  const temp = temperature.split(',').map(Number)
  const binary = Buffer.alloc(7 + channels.length * 4)
  binary.writeUInt32LE(Number(second),0)
  binary.writeUInt8(channels.length,4)
  binary.writeUInt16LE(Number(mask),5)
  for (const [index, value] of channels.entries()) {
    binary.writeInt16LE(value,7+index*4)
    binary.writeInt16LE(temp[index],9+index*4)
  }
  return binary
}

export function samplePage(rows) {
  return Buffer.concat([Buffer.from('GWPK'), Buffer.from([1, rows.length]), ...rows.map(encodeRecord)])
}
