/**
 * 热重载测试：不 dispose 上一个实例，直接再 apply 一次。
 * 验证：
 *   1. 路由不撞 duplicate prefix；
 *   2. 端口靠 EADDRINUSE 重试接管成功；
 *   3. 第二次实例接管后接口仍可用。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-control-reload-'))
process.env.DSH_HOME = home

const { apply } = await import('../lib/index.js')

const routes = []
let dispose = null
const ctx = {
  webServer: {
    port: 3456,
    register: (route) => {
      if (routes.some((existing) => existing.path === route.path)) {
        // 模拟宿主对同名 prefix 的拒绝
        throw new Error(`duplicate prefix route "${route.path}"`)
      }
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  },
  connection: { authenticatedUrl: (base) => `${base}/?token=fake` },
  effect: (fn) => { dispose = fn() },
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 第一次装载
apply(ctx, { port: 3456 })
await sleep(400)
assert.equal(routes.length, 1, '第一次装载应注册一条路由')

const state1 = await getState()
assert.equal(state1.listening, 3456)

// 不 dispose，直接模拟热重载再装载一次
apply(ctx, { port: 3456 })
await sleep(1200)
assert.equal(routes.length, 1, '热重载后仍应只有一条路由（不能重复）')

const state2 = await getState()
assert.equal(state2.listening, 3456, '新实例应接管同一端口')

if (typeof dispose === 'function') dispose()

function getState() {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage()
    req.method = 'GET'
    req.url = '/mobile-control/api/state'
    req.socket = { remoteAddress: '127.0.0.1', encrypted: false }
    req.headers = { host: '127.0.0.1' }
    req.push(null)
    const chunks = []
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name] = value },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers ?? {}) },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk))
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch (error) {
          reject(error)
        }
      },
      on() {},
    }
    routes[0].handler(req, res).catch(reject)
  })
}

console.log('热重载测试通过：3 项')
