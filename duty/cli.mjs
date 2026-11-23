#!/usr/bin/env node
// 值班采集工具：
//   node duty/cli.mjs collect  [--source URL] [--state DIR]   一轮采集（登记·领取·认定·验收·交班）
//   node duty/cli.mjs handover [--state DIR]                  重打最近交班凭据
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runRound } from './collector.mjs'
import { renderRound, renderHandover } from './report.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = rest.indexOf('--' + name)
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : dflt
}
const stateDir = opt('state', process.env.DUTY_STATE ?? join(process.cwd(), 'var', 'duty'))

if (cmd === 'collect') {
  const source = opt('source', process.env.SOURCE ?? 'http://127.0.0.1:8700')
  const { report, handover } = await runRound({ root: source, stateDir })
  console.log(renderRound(report))
  console.log()
  console.log(renderHandover(handover))
} else if (cmd === 'handover') {
  try {
    const handover = JSON.parse(await readFile(join(stateDir, 'reports', 'last-handover.json'), 'utf8'))
    console.log(renderHandover(handover))
  } catch {
    console.error('尚无交班凭据：请先运行 collect')
    process.exitCode = 1
  }
} else {
  console.error('用法：node duty/cli.mjs collect [--source URL] [--state DIR]\n      node duty/cli.mjs handover [--state DIR]')
  process.exitCode = 1
}
