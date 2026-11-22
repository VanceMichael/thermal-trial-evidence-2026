import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createSource } from '../source/source.mjs'

async function listen(t) {
  const server = createSource()
  server.listen(0, '127.0.0.1')
  await once(server,'listening')
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return { root: 'http://127.0.0.1:' + server.address().port }
}

test('来源资料支持修订隔离与逐页领取', async t => {
  const { root } = await listen(t)
  const update = await fetch(root + '/control?edition=r2', {method:'POST'})
  assert.equal((await update.json()).edition, 'r2')
  let response = await fetch(root + '/records/' + "actions")
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('X-Edition'), 'r2')
  const etag = response.headers.get('ETag')
  const cached = await fetch(root + '/records/' + "actions", {headers:{'If-None-Match':etag}})
  assert.equal(cached.status, 304)
  const rows = []
  for (;;) {
    rows.push(...(await response.text()).trim().split('\n').filter(Boolean))
    const next = response.headers.get('link')
    if (!next) break
    const path = /^<([^>]+)>/.exec(next)[1]
    const incorrect = new URL(path, root)
    incorrect.searchParams.set('edition','r1')
    assert.ok([404,409].includes((await fetch(incorrect)).status))
    response = await fetch(new URL(path,root))
    assert.equal(response.status, 200)
  }
  assert.equal(new Set(rows).size,rows.length)
  assert.ok(rows.some(row => row.split('\t').includes("cancelled")))
})

test('网关对启动代、留存范围和真实读取额度分别校验', async t => {
  const { root } = await listen(t)
  const stream = root + '/records/samples?key=G&generation=a'
  assert.equal((await fetch(stream + '&from=-1&until=1')).status,410)
  assert.equal((await fetch(stream + '&from=0&until=2')).headers.get('x-remaining-seconds'),'2')
  assert.equal((await fetch(stream + '&from=0&until=2')).headers.get('x-remaining-seconds'),'2')
  assert.equal((await fetch(stream + '&from=2&until=4')).headers.get('x-remaining-seconds'),'0')
  assert.equal((await fetch(stream + '&from=4&until=6')).status,429)
})
