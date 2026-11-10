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

function admin(method, pathname, body, headers = { host: '127.0.0.1:3455' }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = new http.IncomingMessage()
    req.method = method
    req.url = pathname
    req.socket = { remoteAddress: '127.0.0.1', encrypted: false }
    req.headers = { ...headers, ...(payload === '' ? {} : { 'content-type': 'application/json' }) }
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

function publicRequest(method, pathname, { cookie, body, headers } = {}) {
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
        ...(headers ?? {}),
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

// 11. 配对页反射 XSS：code 与 UA 都不能原样进入 HTML
const xssCode = await publicRequest('GET', '/mobile-control/pair?code=%22%3E%3Csvg%20onload%3Dalert(1)%3E')
assert.equal(xssCode.status, 200)
assert.ok(!xssCode.body.includes('<svg'), 'code 参数不应反射出标签')
// 配对码不再从 query 预填：链接里的数字也不该出现在页面里
const prefilled = await publicRequest('GET', '/mobile-control/pair?code=123456')
assert.ok(!prefilled.body.includes('123456'), '配对码不应从 query 预填')
const xssUa = await publicRequest('GET', '/mobile-control/pair', {
  headers: { 'user-agent': 'Android 10; "><svg/onload=alert(1)>' },
})
assert.ok(!xssUa.body.includes('<svg'), 'UA 不应反射出标签')
assert.match(String(xssCode.headers['content-security-policy'] ?? ''), /default-src 'none'/)

// 12. 隧道侧不得调用管理写接口（设备=管理员的提权面），只读 /state 放行
const tunnelWrite = await publicRequest('POST', '/mobile-control/api/pair/start', { body: {} })
assert.equal(tunnelWrite.status, 403)
// 只读 /state 仍要走设备认证（这里设备已在第 7 步撤销），所以是 401 而不是 403/200
const tunnelRead = await publicRequest('GET', '/mobile-control/api/state')
assert.equal(tunnelRead.status, 401)

// 12. 设备 token 只以哈希落盘，且旧明文记录会在加载时迁移
const stateFile = path.join(home, 'storages', 'mobile-control.json')
// 第 7 步把设备撤销了，这里重新配一台来检查落盘形态
const pair2 = await admin('POST', '/mobile-control/api/pair/start', {})
const ok2 = await publicRequest('POST', '/mobile-control/pair', { body: { code: pair2.body.code, name: '哈希机' } })
assert.equal(ok2.status, 302)
const persisted = fs.readFileSync(stateFile, 'utf8')
const rawToken = /dsh_ma_device=([0-9a-f]{64})/.exec(String(ok2.headers['set-cookie'] ?? ''))[1]
assert.ok(!persisted.includes(rawToken), '状态文件不应包含设备 token 明文')
assert.match(persisted, /"token": "sha256:[0-9a-f]{64}"/)

// 迁移：写入一条明文旧记录 + 调 readState()，应被改成哈希
const { readState } = await import('../lib/index.js')
const legacy = JSON.parse(persisted)
legacy.devices.push({ id: 'legacy1', name: '旧设备', token: 'a'.repeat(64), createdAt: Date.now(), lastSeenAt: Date.now() })
fs.writeFileSync(stateFile, JSON.stringify(legacy))
const migratedState = readState()
const legacyDevice = migratedState.devices.find((device) => device.id === 'legacy1')
assert.match(legacyDevice.token, /^sha256:[0-9a-f]{64}$/, '旧明文 token 应被迁移为哈希')
assert.match(fs.readFileSync(stateFile, 'utf8'), /sha256:[0-9a-f]{64}/, '迁移结果应落盘')

// 13. 管理接口的 Host 必须是回环（挡 DNS rebinding 的无 Origin GET）
const rebindAdmin = await new Promise((resolve, reject) => {
  const req = new http.IncomingMessage()
  req.method = 'GET'
  req.url = '/mobile-control/api/state'
  req.socket = { remoteAddress: '127.0.0.1', encrypted: false }
  req.headers = { host: 'evil.example' }
  req.push(null)
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status) { this.statusCode = status },
    end(chunk) { resolve({ status: this.statusCode, body: String(chunk ?? '') }) },
    on() {},
  }
  handler(req, res).catch(reject)
})
assert.equal(rebindAdmin.status, 403, '伪造 Host 的管理请求应被拒')

// 14. 90 天不活跃的设备在加载时失效
const withOld = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
withOld.devices.push({ id: 'stale', name: '旧手机', token: 'sha256:' + 'b'.repeat(64), createdAt: Date.now() - 100 * 86400000, lastSeenAt: Date.now() - 100 * 86400000 })
withOld.devices.push({ id: 'fresh', name: '新手机', token: 'sha256:' + 'c'.repeat(64), createdAt: Date.now(), lastSeenAt: Date.now() })
fs.writeFileSync(stateFile, JSON.stringify(withOld))
const pruned = readState()
assert.ok(!pruned.devices.some((device) => device.id === 'stale'), '90 天不活跃设备应被清掉')
assert.ok(pruned.devices.some((device) => device.id === 'fresh'), '活跃设备应保留')
assert.ok(!JSON.parse(fs.readFileSync(stateFile, 'utf8')).devices.some((device) => device.id === 'stale'), '清理结果应落盘')

// 15. 管理接口头部边缘矩阵（回环名单 / 端口 / 畸形 Origin）
const edge = []
const expectAdmin = async (label, headers, wanted) => {
  const res = await admin('GET', '/mobile-control/api/state', undefined, headers)
  edge.push({ label, ok: res.status === wanted, got: res.status, wanted })
}
await expectAdmin('回环带端口', { host: '127.0.0.1:3455' }, 200)
await expectAdmin('大写 localhost', { host: 'LOCALHOST:3455' }, 200)
await expectAdmin('IPv6 回环', { host: '[::1]:3455' }, 200)
await expectAdmin('后缀伪装域', { host: '127.0.0.1.evil.com' }, 403)
await expectAdmin('同端口 Origin', { host: '127.0.0.1:3455', origin: 'http://127.0.0.1:3455' }, 200)
await expectAdmin('localhost 同端口', { host: '127.0.0.1:3455', origin: 'http://localhost:3455' }, 200)
await expectAdmin('异端口 Origin', { host: '127.0.0.1:3455', origin: 'http://127.0.0.1:9999' }, 403)
await expectAdmin('外部 Origin', { host: '127.0.0.1:3455', origin: 'https://evil.example' }, 403)
await expectAdmin('畸形 Origin', { host: '127.0.0.1:3455', origin: 'not-a-url' }, 403)
for (const item of edge) assert.equal(item.got, item.wanted, `${item.label} 期望 ${item.wanted} 实际 ${item.got}`)

// 16. 拒绝原因可区分（forbidden-host / forbidden-origin），便于日志与门禁识别
const denyHost = await admin('GET', '/mobile-control/api/state', undefined, { host: 'evil.example' })
assert.equal(denyHost.body.error, 'forbidden-host', `实际 ${JSON.stringify(denyHost.body)}`)
const denyOrigin = await admin('GET', '/mobile-control/api/state', undefined, { host: '127.0.0.1:3455', origin: 'https://evil.example' })
assert.equal(denyOrigin.body.error, 'forbidden-origin', `实际 ${JSON.stringify(denyOrigin.body)}`)

console.log('宿主自测通过：31 项')
if (typeof dispose === 'function') dispose()
