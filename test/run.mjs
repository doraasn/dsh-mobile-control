/**
 * 宿主侧自测：临时 DSH_HOME，抓 webServer 路由，起真实代理端口。
 * 断言都是可证伪的具体值（状态码、字段、计数）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-control-'))
process.env.DSH_HOME = home

const { apply } = await import('../lib/index.js')

const routes = []
let dispose = null
const ctx = {
  config: { port: 3455 },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  connection: { authenticatedUrl: () => null },
  effect: (fn) => { dispose = fn() },
}

apply(ctx, { port: 3455 })
assert.equal(routes.length, 2, '应注册新路径与改名兼容别名')
assert.deepEqual(routes.map((route) => route.path).sort(), ['/mobile-access/api', '/mobile-control/api'])

const handler = routes[0].handler

function admin(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = new http.IncomingMessage()
    req.method = method
    req.url = pathname
    req.socket = { remoteAddress: '127.0.0.1', encrypted: false }
    req.headers = { host: '127.0.0.1', ...(payload === '' ? {} : { 'content-type': 'application/json' }) }
    req.push(payload)
    req.push(null)
    const chunks = []
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name] = value },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers) },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }) },
      on() {},
    }
    handler(req, res).catch(reject)
  })
}

function publicRequest(method, pathname, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1',
      port: 3455,
      path: pathname,
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
await sleep(300)

// 1. 默认状态
const initial = await admin('GET', '/mobile-control/api/state')
assert.equal(initial.status, 200)
assert.equal(initial.body.enabled, true)
assert.equal(initial.body.port, 3455)
assert.deepEqual(initial.body.devices, [])
assert.equal(initial.body.listening, 3455)

// 1b. 改名前的旧路径也能拿到同一份数据（浏览器缓存兼容）
const legacyState = await admin('GET', '/mobile-access/api/state')
assert.equal(legacyState.status, 200)
assert.equal(legacyState.body.enabled, true)

// 2. 未配对访问首页 → 401
const anonymous = await publicRequest('GET', '/')
assert.equal(anonymous.status, 401)

// 3. 生成配对码 → 6 位数字
const pair = await admin('POST', '/mobile-control/api/pair/start', {})
assert.equal(pair.status, 200)
assert.match(String(pair.body.code), /^\d{6}$/)

// 4. 错误配对码 → 401 且不产生设备
const wrong = await publicRequest('POST', '/mobile-control/pair', { body: { code: '000000' } })
assert.equal(wrong.status, 401)

// 5. 正确配对 → 302 + Set-Cookie
const ok = await publicRequest('POST', '/mobile-control/pair', { body: { code: pair.body.code, name: '测试机' } })
assert.equal(ok.status, 302)
const setCookie = String(ok.headers['set-cookie'] ?? '')
assert.match(setCookie, /dsh_ma_device=[0-9a-f]{64}/)
assert.match(setCookie, /Max-Age=34560000/)

// 6. 设备已入库，且管理接口不回传 token
const afterPair = await admin('GET', '/mobile-control/api/state')
assert.equal(afterPair.body.devices.length, 1)
assert.equal(afterPair.body.devices[0].name, '测试机')
assert.equal(afterPair.body.devices[0].token, undefined)

// 7. 撤销后设备清空
const revoked = await admin('POST', '/mobile-control/api/devices/revoke', { id: afterPair.body.devices[0].id })
assert.equal(revoked.body.removed, 1)
const afterRevoke = await admin('GET', '/mobile-control/api/state')
assert.equal(afterRevoke.body.devices.length, 0)

// 8. 端口校验：越界 → 400
const badPort = await admin('POST', '/mobile-control/api/port', { port: 80 })
assert.equal(badPort.status, 400)

// 9. 公网地址校验
const badUrl = await admin('POST', '/mobile-control/api/public-url', { publicUrl: 'not-a-url' })
assert.equal(badUrl.status, 400)

// 10. 非回环请求 → 403
const foreign = await new Promise((resolve, reject) => {
  const req = new http.IncomingMessage()
  req.method = 'GET'
  req.url = '/mobile-control/api/state'
  req.socket = { remoteAddress: '10.0.0.9', encrypted: false }
  req.headers = { host: '10.0.0.9' }
  req.push(null)
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status) { this.statusCode = status },
    end(chunk) { resolve({ status: this.statusCode, body: JSON.parse(String(chunk ?? '{}')) }) },
    on() {},
  }
  handler(req, res).catch(reject)
})
assert.equal(foreign.status, 403)

console.log('宿主自测通过：10 项')
if (typeof dispose === 'function') dispose()
