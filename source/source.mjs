import http from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const source = JSON.parse(await readFile(new URL('../records/source.json', import.meta.url), 'utf8'))
const pageRows = 2
const id = value => createHash('sha256').update(value).digest('hex').slice(0, 16)

function send(response, code, type, body, headers = {}) {
  response.writeHead(code, { 'Content-Type': type, ...headers })
  response.end(body)
}

function json(response, code, data, headers) {
  send(response, code, 'application/json; charset=utf-8', JSON.stringify(data), headers)
}

function pageLink(url, cursor) {
  const output = new URL(url)
  output.searchParams.set('cursor', cursor)
  return output.pathname + output.search
}

function editionData(name) {
  return source.editions.find(release => release.edition === name)
}

function pageOf(url, name, edition) {
  const allRows = edition.streams[name]
  if (!allRows) return { code: 404 }
  const key = url.searchParams.get('key')
  const from = url.searchParams.get('from')
  const until = url.searchParams.get('until')
  const filter = source.filters[name]
  if (((from !== null || until !== null) && filter?.clock === undefined) || (key !== null && !filter)) {
    return { code: 422 }
  }
  if ((from !== null && !/^-?\d+$/.test(from)) || (until !== null && !/^-?\d+$/.test(until))) {
    return { code: 422 }
  }
  const visible = allRows.filter(row =>
    (key === null || row[filter.key] === key) &&
    (from === null || Number(row[filter.clock]) >= Number(from)) &&
    (until === null || Number(row[filter.clock]) < Number(until))
  )
  const fingerprint = id(JSON.stringify([edition.edition, name, key, from, until]))
  const cursors = visible.map((_, i) => id(fingerprint + ':' + i))
  const cursor = url.searchParams.get('cursor')
  const offset = cursor === null ? 0 : cursors.indexOf(cursor)
  if (offset < 0) return { code: 409 }
  const next = offset + pageRows
  return {
    code: 200,
    rows: visible.slice(offset, next),
    headers: next < visible.length ? { Link: '<' + pageLink(url, cursors[next]) + '>; rel="next"' } : {},
    fingerprint: id(JSON.stringify([fingerprint, visible, offset]))
  }
}

export function createSource() {
  let selected = source.editions[0]
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost')
      if (url.pathname === '/health') return json(response, 200, { edition: selected.edition })
      if (url.pathname === '/control' && request.method === 'POST') {
        const release = editionData(url.searchParams.get('edition'))
        if (!release) return json(response, 404, { error: '没有该资料版' })
        selected = release
        return json(response, 200, { edition: selected.edition })
      }
      if (request.method !== 'GET') return json(response, 405, { error: '不支持该操作' })
      if (url.pathname === '/catalog') {
        return json(response, 200, { edition: selected.edition, streams: Object.keys(selected.streams) })
      }
      const match = /^\/records\/([a-z]+)$/.exec(url.pathname)
      if (match) {
        const edition = editionData(url.searchParams.get('edition') || selected.edition)
        if (!edition) return json(response, 404, { error: '没有该资料版' })
        const page = pageOf(url, match[1], edition)
        if (page.code !== 200) return json(response, page.code, { error: '资料、筛选范围或继续标记无效' })
        const headers = { ...page.headers, 'X-Edition': edition.edition, ETag: '"' + page.fingerprint + '"' }
        if (request.headers['if-none-match'] === headers.ETag) {
          return send(response, 304, 'text/tab-separated-values; charset=utf-8', '', headers)
        }
        return send(response, 200, 'text/tab-separated-values; charset=utf-8',
          page.rows.map(row => row.join('\t')).join('\n') + (page.rows.length ? '\n' : ''), headers)
      }
      return json(response, 404, { error: '没有该资料' })
    } catch (error) {
      return json(response, 500, { error: error.message })
    }
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createSource().listen(Number(process.env.PORT || 8700), '127.0.0.1', () => {
    console.log('资料来源已启动')
  })
}
