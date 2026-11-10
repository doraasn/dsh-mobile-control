/**
 * dsh-mobile-control — 宿主侧。
 *
 * 只做四件事：
 *   1. 在 127.0.0.1:<port> 起一个反向代理，把手机请求转发给 DSH 本机 Web；
 *   2. 设备级认证：一次性短码 → 每设备独立 token → 长期 cookie（400 天滑动续期）；
 *   3. 移动页 boot manifest 裁剪（按模块 id 排除，减首屏体积）；
 *   4. 设置页管理接口（开关 / 端口 / 设备 / 模块），只对回环开放。
 *
 * 隧道（cloudflared / cpolar）不归本插件管：外部进程把公网域名指向 127.0.0.1:<port> 即可。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { execFile, execFileSync, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export const name = 'mobile-control'
export const inject = ['webServer']

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STORAGE = path.join(DSH_HOME, 'storages', 'mobile-control.json')
const LEGACY_STORAGE = path.join(DSH_HOME, 'storages', 'mobile-access.json')
const DEVICE_COOKIE = 'dsh_ma_device'
const TOKEN_PREFIX = 'sha256:'
/** 长期不活跃的设备自动失效（90 天）：失窃 cookie 不再永久有效。 */
const DEVICE_MAX_IDLE_MS = 90 * 24 * 60 * 60 * 1000

/** 设备 token 只存哈希：文件被读走也不能直接拿去冒充设备。 */
function hashToken(token) {
  return TOKEN_PREFIX + crypto.createHash('sha256').update(String(token)).digest('hex')
}

function tokenMatches(stored, candidate) {
  if (typeof stored !== 'string' || typeof candidate !== 'string') return false
  if (stored.startsWith(TOKEN_PREFIX)) {
    const left = Buffer.from(stored.slice(TOKEN_PREFIX.length), 'hex')
    const right = Buffer.from(hashToken(candidate).slice(TOKEN_PREFIX.length), 'hex')
    return left.length === right.length && crypto.timingSafeEqual(left, right)
  }
  return stored === candidate
}
const ADMIN_PREFIX = '/mobile-control/api'
const PUBLIC_PREFIX = '/mobile-control/pair'
/** 浏览器对 Max-Age 的实际上限是 400 天；每次请求滑动续期，等价于永久。 */
const COOKIE_MAX_AGE = 34560000
const PAIR_CODE_TTL_MS = 5 * 60 * 1000
const PAIR_MAX_ATTEMPTS = 5
const PAIR_LOCK_MS = 10 * 60 * 1000
const UPSTREAM_COOKIE_MARGIN_MS = 60 * 1000

// ── 持久化 ────────────────────────────────────────────────────────────────

/** 从旧 dsh-mobile 的配置里推断公网地址，避免让用户重填。 */
function inferLegacyPublicUrl() {
  const legacy = path.join(DSH_HOME, 'mobile-control', 'remote')
  try {
    const tunnel = JSON.parse(fs.readFileSync(path.join(legacy, 'cloudflared', 'tunnel.json'), 'utf8'))
    if (typeof tunnel.hostname === 'string' && tunnel.hostname.trim() !== '') return `https://${tunnel.hostname.trim()}`
  } catch {}
  try {
    const origin = JSON.parse(fs.readFileSync(path.join(legacy, 'origin', 'config', 'settings.json'), 'utf8'))
    if (typeof origin.publicOrigin === 'string' && origin.publicOrigin.trim() !== '') return origin.publicOrigin.trim()
  } catch {}
  return ''
}

/** 从旧包名迁移一次状态（设备、端口、公网地址、模块排除项）。 */
function migrateLegacyStorage() {
  try {
    if (!fs.existsSync(STORAGE) && fs.existsSync(LEGACY_STORAGE)) fs.copyFileSync(LEGACY_STORAGE, STORAGE)
  } catch {}
}

export function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORAGE, 'utf8'))
    const storedUrl = typeof parsed.publicUrl === 'string' ? parsed.publicUrl : ''
    const devices = Array.isArray(parsed.devices) ? parsed.devices : []
    // 旧版本把设备 token 明文存在这里：加载时一次性改存哈希，落盘文件里不再有可直接使用的凭据。
    let migrated = false
    const now = Date.now()
    const safeDevices = devices
      .filter((device) => device && typeof device === 'object')
      .filter((device) => {
        // 长期不活跃的设备自动失效：失窃的 cookie 不会永久有效。
        const lastSeen = Number(device.lastSeenAt) || Number(device.createdAt) || 0
        if (lastSeen > 0 && now - lastSeen > DEVICE_MAX_IDLE_MS) {
          migrated = true
          return false
        }
        return true
      })
      .map((device) => {
        if (typeof device.token === 'string' && device.token !== '' && !device.token.startsWith(TOKEN_PREFIX)) {
          migrated = true
          return { ...device, token: hashToken(device.token) }
        }
        return device
      })
    const state = {
      enabled: parsed.enabled !== false,
      port: Number.isSafeInteger(parsed.port) ? parsed.port : 3444,
      publicUrl: storedUrl !== '' ? storedUrl : inferLegacyPublicUrl(),
      tunnelAutostart: parsed.tunnelAutostart === true,
      devices: safeDevices,
      excludedClientModules: Array.isArray(parsed.excludedClientModules) ? parsed.excludedClientModules : [],
    }
    if (migrated) {
      try {
        writeState(state)
      } catch {
        /* 迁移失败不影响本次启动，下次再试 */
      }
    }
    return state
  } catch {
    return { enabled: true, port: 3444, publicUrl: inferLegacyPublicUrl(), tunnelAutostart: false, devices: [], excludedClientModules: [] }
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STORAGE), { recursive: true })
  const tmp = `${STORAGE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, STORAGE)
  tightenAcl()
}

/**
 * 状态文件里有设备 token 哈希与会话配置：Windows 上把继承的 ACL 收掉，只留当前用户。
 * 失败不致命（例如 FAT32 或没有 icacls），下次写盘再试。
 */
let aclTightened = false
function tightenAcl() {
  if (process.platform !== 'win32' || aclTightened) return
  const user = process.env.USERNAME
  if (!user) return
  try {
    execFileSync('icacls', [STORAGE, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
    aclTightened = true
  } catch {
    /* 收权失败不影响功能 */
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function parseCookies(header) {
  const out = Object.create(null)
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return out
}

function isLoopback(address) {
  if (typeof address !== 'string') return false
  const value = address.startsWith('::ffff:') ? address.slice(7) : address
  return value === '::1' || value.startsWith('127.')
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function deviceCookie(token, req) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted === true
  const parts = [
    `${DEVICE_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * 从 index HTML 解析 boot manifest，返回可裁剪性信息。
 * bootstrap 批次的模块是启动必需项，界面里置灰不可选。
 */
/** 本地常见插件的中文名兜底；包自带的 displayName / locale 优先。 */
const MODULE_TITLE_ALIASES = {
  'dsh-mobile-control': '移动控制',
  'dsh-quota-board': '额度看板',
  'dsh-quota-panel': '额度看板',
  'dsh-cloud-sync': '云同步',
  'dsh-web-chat': '网页聊天',
  'dsh-session-messaging': '跨会话消息',
  'dsh-session-meta': '会话概览',
  'dsh-sidebar-compact': '侧栏收纳',
  'dsh-speed-monitor': '速度监控',
  'dsh-mcp-lazy': 'MCP 网关',
  'dsh-superagent': '超级代理',
  'dsh-side-chat': '侧边会话',
  'dsh-pet-garden': '宠物助手',
}

const titleCache = new Map()

function findPackageDir(id) {
  const roots = []
  try {
    for (const name of fs.readdirSync(path.join(DSH_HOME, 'profiles'))) {
      roots.push(path.join(DSH_HOME, 'profiles', name, 'node_modules'))
    }
  } catch {}
  for (const root of roots) {
    const dir = path.join(root, id)
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
  }
  return null
}

/** 模块 id → 中文显示名；找不到时返回空串，由前端回退到 id。 */
function resolveModuleTitle(id) {
  if (titleCache.has(id)) return titleCache.get(id)
  const bare = id.replace(/^@[^/]+\//, '')
  let title = MODULE_TITLE_ALIASES[id] ?? MODULE_TITLE_ALIASES[bare] ?? ''
  if (title === '') {
    const dir = findPackageDir(id)
    if (dir !== null) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
        title = pkg.displayName || pkg.dsh?.title || pkg.title || ''
        if (title === '' && fs.existsSync(path.join(dir, 'locale', 'zh.json'))) {
          const locale = JSON.parse(fs.readFileSync(path.join(dir, 'locale', 'zh.json'), 'utf8'))
          title = locale?.meta?.title || ''
        }
      } catch {}
    }
  }
  titleCache.set(id, title)
  return title
}

function parseBootEntries(html) {
  const marker = /(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\])\s*=\s*/u.exec(html)
  if (marker === null || marker.index === undefined) return []
  const valueStart = marker.index + marker[0].length
  const scriptEnd = html.indexOf('</script>', valueStart)
  if (scriptEnd < 0) return []
  try {
    const parsed = JSON.parse(html.slice(valueStart, scriptEnd).trim().replace(/;$/u, ''))
    const batches = Array.isArray(parsed.batches) ? parsed.batches : []
    const bootstrap = new Set()
    for (const batch of batches) {
      if (batch?.phase === 'bootstrap' && Array.isArray(batch.entries)) for (const id of batch.entries) bootstrap.add(id)
    }
    const entries = Array.isArray(parsed.entries) ? parsed.entries : []
    const dependents = new Map()
    for (const entry of entries) {
      for (const dep of Array.isArray(entry.inject) ? entry.inject : []) {
        if (!dependents.has(dep)) dependents.set(dep, [])
        dependents.get(dep).push(entry.id)
      }
    }
    return entries.map((entry) => {
      const users = dependents.get(entry.id) ?? []
      return {
        id: entry.id,
        official: entry.id.startsWith('@deepseek-ai/'),
        title: resolveModuleTitle(entry.id),
        bootstrap: bootstrap.has(entry.id),
        // 被其他模块依赖的不能单独裁，否则整条依赖链断掉。
        locked: bootstrap.has(entry.id) || users.length > 0,
        dependents: users,
        dependencies: Array.isArray(entry.inject) ? entry.inject : [],
      }
    })
  } catch {
    return []
  }
}

const LEGACY_REMOTE = path.join(DSH_HOME, 'mobile-access', 'remote')

/** 找 cloudflared 可执行文件：先旧组件目录，再 PATH。 */
function findCloudflaredBin() {
  const root = path.join(DSH_HOME, 'mobile-access', 'components', 'cloudflared')
  try {
    const versions = fs.readdirSync(root).sort().reverse()
    for (const version of versions) {
      const candidate = path.join(root, version, 'cloudflared.exe')
      if (fs.existsSync(candidate)) return candidate
      const plain = path.join(root, version, 'cloudflared')
      if (fs.existsSync(plain)) return plain
    }
  } catch {}
  return 'cloudflared'
}

/** 读旧的命名隧道 token（本插件不保存 token，只借用外部配置）。 */
function readTunnelToken() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(LEGACY_REMOTE, 'cloudflared', 'tunnel.json'), 'utf8'))
    return typeof parsed.token === 'string' && parsed.token !== '' ? parsed.token : null
  } catch {
    return null
  }
}

/**
 * 随 DSH 启动隧道：只在「已在运行」为假时拉起一次，detached 运行，
 * DSH 重启或崩溃都不会把它带走，避免端口反复断连。
 */
function ensureTunnel(log) {
  const exists = (callback) => {
    if (process.platform !== 'win32') {
      execFile('sh', ['-c', 'command -v cloudflared >/dev/null && pgrep -x cloudflared >/dev/null'], (error) => callback(error === null))
      return
    }
    execFile('tasklist', ['/FI', 'IMAGENAME eq cloudflared.exe', '/NH'], { windowsHide: true }, (error, stdout) => {
      callback(!error && typeof stdout === 'string' && stdout.includes('cloudflared.exe'))
    })
  }
  exists((running) => {
    if (running) {
      log('tunnel already running')
      return
    }
    const token = readTunnelToken()
    if (token === null) {
      log('tunnel skip: no token')
      return
    }
    try {
      const bin = findCloudflaredBin()
      // token 走环境变量而不是 argv：进程列表对同机任何进程可见，argv 里的 token
      // 等于把整条隧道（含 ingress）交给对方。
      const env = { ...process.env, TUNNEL_TOKEN: token }
      // 用 cmd start 启动：cloudflared 不再挂在 DSH 的进程树里，DSH 退出/重启不会把它带走。
      const child = process.platform === 'win32'
        ? spawn('cmd.exe', ['/c', 'start', '', bin, 'tunnel', 'run'], { detached: true, stdio: 'ignore', windowsHide: true, env })
        : spawn(bin, ['tunnel', 'run'], { detached: true, stdio: 'ignore', env })
      child.unref()
      log('tunnel spawned')
    } catch (error) {
      log('tunnel spawn failed: ' + String(error && error.message))
    }
  })
}

/** 从 UA 推断设备名，拿不到时退回配对码，保证设备名永不为空。 */
function defaultDeviceName(ua, code) {
  const text = typeof ua === 'string' ? ua : ''
  if (/iPhone/i.test(text)) return 'iPhone'
  if (/iPad/i.test(text)) return 'iPad'
  if (/HarmonyOS/i.test(text)) return 'HarmonyOS 设备'
  const android = /Android[^;]*;\s*([^;)]+?)(?:\s+Build|\s*;|\s*\))/i.exec(text)
  if (android?.[1]) return android[1].trim().slice(0, 32)
  if (/Android/i.test(text)) return 'Android 设备'
  if (/Windows/i.test(text)) return 'Windows 电脑'
  if (/Macintosh|Mac OS X/i.test(text)) return 'Mac'
  return code ? `设备 ${code}` : '手机'
}

/** 移动端 UA 判定：只在手机上改写 boot manifest，桌面不受影响。 */
function isMobileUa(ua) {
  return typeof ua === 'string' && /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua)
}

// ── 移动页 boot manifest 裁剪 ─────────────────────────────────────────────

/**
 * 过滤 `window.__DSH_BOOT__` 里的 application 条目。
 * 规则：
 *   - bootstrap 批次的条目一律不动（启动必需）；
 *   - 被排除的模块若仍被保留模块依赖，拒绝裁剪并返回原因；
 *   - 同时过滤 entries 与 batches[].entries。
 */
function rewriteBootManifest(html, excludedIds) {
  if (!Array.isArray(excludedIds) || excludedIds.length === 0) return { html, removed: 0 }
  const marker = /(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\])\s*=\s*/u.exec(html)
  if (marker === null || marker.index === undefined) return { html, removed: 0, error: 'no_boot_manifest' }
  const valueStart = marker.index + marker[0].length
  const scriptEnd = html.indexOf('</script>', valueStart)
  if (scriptEnd < 0) return { html, removed: 0, error: 'boot_incomplete' }
  const source = html.slice(valueStart, scriptEnd).trim().replace(/;$/u, '')
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    return { html, removed: 0, error: 'boot_unparsable' }
  }
  if (!Array.isArray(parsed.entries)) return { html, removed: 0, error: 'boot_malformed' }
  const batches = Array.isArray(parsed.batches) ? parsed.batches : []
  const bootstrapIds = new Set()
  for (const batch of batches) {
    if (batch?.phase === 'bootstrap' && Array.isArray(batch.entries)) for (const id of batch.entries) bootstrapIds.add(id)
  }
  const excluded = new Set(excludedIds.filter((id) => typeof id === 'string' && !bootstrapIds.has(id)))
  if (excluded.size === 0) return { html, removed: 0 }
  const byId = new Map(parsed.entries.map((entry) => [entry.id, entry]))
  // 依赖闭包检查：保留的模块不能依赖被排除的模块。
  for (const entry of parsed.entries) {
    if (excluded.has(entry.id)) continue
    const deps = Array.isArray(entry.inject) ? entry.inject : []
    for (const dep of deps) {
      if (excluded.has(dep)) {
        return { html, removed: 0, error: `dependent:${entry.id}->${dep}` }
      }
    }
  }
  let removed = 0
  parsed.entries = parsed.entries.filter((entry) => {
    if (excluded.has(entry.id)) {
      removed += 1
      return false
    }
    return true
  })
  for (const batch of batches) {
    if (!Array.isArray(batch.entries)) continue
    batch.entries = batch.entries.filter((id) => !excluded.has(id))
  }
  parsed.batches = batches.filter((batch) => Array.isArray(batch.entries) ? batch.entries.length > 0 : true)
  let rebuilt = `${html.slice(0, marker.index)}${marker[0]}${JSON.stringify(parsed)}${html.slice(scriptEnd)}`
  // index 里还有预加载批次（plugins/??a/client.js,b/client.js…），必须同源过滤，
  // 否则浏览器仍会预取被排除的模块，裁剪等于没做。
  rebuilt = rebuilt.replace(/plugins\/\?\?([^"']+)/gu, (full, list) => {
    const kept = list.split(',').filter((item) => !excludedIds.some((id) => item.includes(id)))
    return `plugins/??${kept.join(',')}`
  })
  return { html: rebuilt, removed }
}

// ── 插件主体 ──────────────────────────────────────────────────────────────

const ROUTE_SLOT = Symbol.for('dsh-mobile-control.route')
const SERVER_SLOT = Symbol.for('dsh-mobile-control.server')
const LEGACY_ROUTE_SLOT = Symbol.for('dsh-mobile-control.legacy-route')

export function apply(ctx, config) {
  const bootLog = (message) => {
    try {
      fs.mkdirSync(path.join(DSH_HOME, 'storages'), { recursive: true })
      fs.appendFileSync(path.join(DSH_HOME, 'storages', 'mobile-control.boot.log'), `${new Date().toISOString()} ${message}\n`)
    } catch {}
  }
  bootLog('apply')
  migrateLegacyStorage()
  // 热重载：先释放上一个实例按名字唯一注册的资源，否则新实例会撞 duplicate prefix route。
  for (const slot of [ROUTE_SLOT, SERVER_SLOT]) {
    const previous = globalThis[slot]
    if (previous === undefined) continue
    try {
      if (slot === ROUTE_SLOT) previous()
      else previous.close()
    } catch {}
    delete globalThis[slot]
  }
  bootLog('release done')
  const settings = config ?? {}
  try {
    const ws = ctx.webServer
    bootLog('webServer keys: ' + Object.keys(ws).join(','))
    bootLog('webServer probe: address=' + (typeof ws.address === 'function' ? JSON.stringify(ws.address()) : 'n/a') + ' port=' + String(ws.port) + ' origin=' + String(ws.origin))
  } catch (error) {
    bootLog('webServer probe failed: ' + String(error && error.message))
  }
  bootLog('config ok')
  let state = readState()
  bootLog('state ok')
  if (typeof settings.port === 'number' && Number.isSafeInteger(settings.port) && settings.port > 1024) state.port = settings.port
  if (state.tunnelAutostart) ensureTunnel(bootLog)

  let server = null
  let listeningPort = null
  let startError = null
  let upstreamCookie = null
  let upstreamCookieAt = 0
  let upstreamUrl = null
  const pairCodes = new Map()
  const pairFailures = new Map()

  // connection 服务是可选的：缺它时管理接口照常工作，仅代理会返回 upstream_unavailable。
  const connection = () => {
    try {
      return ctx.get?.('connection') ?? ctx.connection ?? null
    } catch {
      return null
    }
  }

  /** 上游就是本进程的 DSH Web；端口从 webServer 服务读，不硬编码。 */
  const upstreamBase = () => {
    const port = ctx.webServer?.port
    return Number.isSafeInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : null
  }

  const upstreamOrigin = () => {
    try {
      const base = upstreamBase()
      if (base === null) return null
      const authenticated = connection()?.authenticatedUrl?.(base)
      const url = new URL(typeof authenticated === 'string' ? authenticated : base)
      return `${url.protocol}//${url.host}`
    } catch {
      return null
    }
  }

  /** 用 DSH 进程的 launch token 换一份长期 cookie，代理时带上。 */
  async function upstreamCookieHeader() {
    if (upstreamCookie !== null && Date.now() - upstreamCookieAt < COOKIE_MAX_AGE - UPSTREAM_COOKIE_MARGIN_MS) return upstreamCookie
    let authenticated
    try {
      authenticated = connection()?.authenticatedUrl?.(upstreamOrigin() ?? 'http://127.0.0.1')
    } catch {
      return null
    }
    if (typeof authenticated !== 'string') return null
    upstreamUrl = authenticated
    const target = new URL(authenticated)
    const cookie = await new Promise((resolve) => {
      const request = http.request({
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { host: target.host, accept: 'text/html', 'accept-encoding': 'identity' },
        agent: false,
      }, (response) => {
        const setCookie = response.headers['set-cookie']?.[0]
        response.resume()
        response.on('end', () => resolve(typeof setCookie === 'string' ? setCookie.split(';', 1)[0] : null))
      })
      request.on('error', () => resolve(null))
      request.setTimeout(15000, () => {
        request.destroy()
        resolve(null)
      })
      request.end()
    })
    if (cookie === null) return null
    upstreamCookie = cookie
    upstreamCookieAt = Date.now()
    return cookie
  }

  function findDevice(token) {
    if (typeof token !== 'string' || token.length < 32) return null
    return state.devices.find((device) => tokenMatches(device.token, token)) ?? null
  }

  // ── 代理 ────────────────────────────────────────────────────────────────

  async function authorizedDevice(req) {
    const token = parseCookies(req.headers.cookie)[DEVICE_COOKIE]
    const device = findDevice(token)
    if (device === null) return null
    device.lastSeenAt = Date.now()
    return device
  }

  /** 上游会话失效（DSH 重启、换 launch token）时缓存必须作废，否则手机端会一直 401。 */
  function invalidateUpstreamCookie() {
    upstreamCookie = null
    upstreamCookieAt = 0
  }

  function proxyRequest(req, res, device) {
    return upstreamCookieHeader().then((cookie) => {
      const target = new URL(upstreamOrigin())
      const headers = { ...req.headers }
      headers.host = target.host
      headers.origin = target.origin
      if (typeof headers.referer === 'string') headers.referer = `${target.origin}/`
      if (cookie !== null) headers.cookie = cookie
      else delete headers.cookie
      delete headers['x-forwarded-for']
      const upstream = http.request({
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: Number(target.port),
        path: req.url,
        method: req.method,
        headers,
        agent: false,
      }, (response) => {
        // 上游 401 = 我们缓存的 cookie 过期：作废，下一个请求重新换。
        if (response.statusCode === 401) invalidateUpstreamCookie()
        const outHeaders = { ...response.headers }
        delete outHeaders['set-cookie']
        res.writeHead(response.statusCode ?? 502, outHeaders)
        response.pipe(res)
      })
      upstream.on('error', () => {
        if (!res.headersSent) sendJson(res, 502, { error: 'upstream_unavailable' })
        else res.destroy()
      })
      upstream.setTimeout(120000, () => upstream.destroy())
      req.pipe(upstream)
      res.on('close', () => upstream.destroy())
      // 滑动续期
      if (device !== null) res.setHeader('set-cookie', deviceCookie(device.token, req))
    })
  }

  /** 改写 index：只对移动 UA 生效。 */
  function proxyIndex(req, res, device) {
    return upstreamCookieHeader().then((cookie) => {
      const target = new URL(upstreamOrigin())
      const headers = { ...req.headers, host: target.host, origin: target.origin }
      // 设备 cookie 只属于本插件，不透给上游；上游只认 launch token 换来的 cookie。
      if (cookie !== null) headers.cookie = cookie
      else delete headers.cookie
      delete headers['accept-encoding']
      const upstream = http.request({
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: Number(target.port),
        path: req.url,
        method: 'GET',
        headers,
        agent: false,
      }, (response) => {
        if (response.statusCode === 401) invalidateUpstreamCookie()
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf8')
          const contentType = String(response.headers['content-type'] ?? '')
          if (contentType.includes('text/html') && isMobileUa(req.headers['user-agent'])) {
            const result = rewriteBootManifest(body, state.excludedClientModules)
            if (result.html !== body) {
              body = result.html
              res.setHeader('x-mobile-control-removed', String(result.removed))
            }
          }
          const outHeaders = { ...response.headers }
          delete outHeaders['content-length']
          delete outHeaders['set-cookie']
          // 裁剪是按 UA 动态生成的，绝不能被浏览器缓存，否则手机上永远看到旧清单。
          outHeaders['cache-control'] = 'no-store, must-revalidate'
          res.writeHead(response.statusCode ?? 200, outHeaders)
          res.end(body)
        })
      })
      upstream.on('error', () => {
        if (!res.headersSent) sendJson(res, 502, { error: 'upstream_unavailable' })
      })
      upstream.end()
      if (device !== null) res.setHeader('set-cookie', deviceCookie(device.token, req))
    })
  }

  function handleProxy(req, res) {
    const pathname = new URL(req.url, 'http://localhost').pathname
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return proxyIndex(req, res, res.__mobileDevice ?? null)
    }
    return proxyRequest(req, res, res.__mobileDevice ?? null)
  }

  function handleSocketUpgrade(req, socket, head) {
    try {
      const token = parseCookies(req.headers.cookie)[DEVICE_COOKIE]
      const device = findDevice(token)
      if (device === null) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      device.lastSeenAt = Date.now()
      const target = new URL(upstreamOrigin())
      // 冷启动第一个请求就是 WS 时缓存还是空的：先取一次上游 cookie，
      // 不要拿空 cookie 去连（上游会 401，手机首屏白屏）。
      const proceed = (cookie) => {
        const upstream = net.connect(Number(target.port), target.hostname.replace(/^\[|\]$/g, ''), () => {
          const headers = { ...req.headers }
          headers.host = target.host
          headers.origin = target.origin
          // 设备 cookie 只属于本插件：不透给上游。
          if (typeof cookie === 'string' && cookie !== '') headers.cookie = cookie
          else delete headers.cookie
          const lines = [`${req.method} ${req.url} HTTP/1.1`]
          for (const [key, value] of Object.entries(headers)) {
            if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
            else if (value !== undefined) lines.push(`${key}: ${value}`)
          }
          upstream.write(lines.join('\r\n') + '\r\n\r\n')
          if (head?.length) upstream.write(head)
          upstream.pipe(socket)
          socket.pipe(upstream)
        })
        upstream.on('error', () => socket.destroy())
        socket.on('error', () => upstream.destroy())
      }
      if (upstreamCookie !== null) {
        proceed(upstreamCookie)
        return
      }
      upstreamCookieHeader()
        .then((cookie) => proceed(cookie))
        .catch(() => socket.destroy())
    } catch {
      try { socket.destroy() } catch {}
    }
  }

  // ── 公网入口：配对页 ─────────────────────────────────────────────────────

  function prunePairState() {
    const now = Date.now()
    for (const [code, record] of pairCodes) if (record.expiresAt <= now) pairCodes.delete(code)
    for (const [key, record] of pairFailures) if (record.resetAt <= now) pairFailures.delete(key)
  }

  function pairFailureKey(req) {
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string') {
      // 首个 XFF 由客户端自带、可随便伪造；cloudflared 会在末尾追加真实来源。
      const parts = forwarded.split(',').map((part) => part.trim()).filter(Boolean)
      if (parts.length > 0) return parts[parts.length - 1]
    }
    return String(req.socket.remoteAddress ?? 'unknown')
  }

  function pairingLocked(req) {
    const global = pairFailures.get('*')
    if (global !== undefined && global.count >= PAIR_MAX_ATTEMPTS * 4 && global.resetAt > Date.now()) return true
    const record = pairFailures.get(pairFailureKey(req))
    return record !== undefined && record.count >= PAIR_MAX_ATTEMPTS && record.resetAt > Date.now()
  }

  function bumpPairFailure(key) {
    const record = pairFailures.get(key)
    if (record === undefined || record.resetAt <= Date.now()) pairFailures.set(key, { count: 1, resetAt: Date.now() + PAIR_LOCK_MS })
    else record.count += 1
  }

  function notePairFailure(req) {
    bumpPairFailure(pairFailureKey(req))
    // 全局计数兜底：换 IP 绕过单 IP 限制时，仍然只能试这么多轮。
    bumpPairFailure('*')
  }

  function tryPair(req, res, code, deviceName) {
    if (pairingLocked(req)) {
      sendJson(res, 429, { error: 'too_many_attempts' })
      return
    }
    prunePairState()
    const record = pairCodes.get(code)
    if (record === undefined || record.expiresAt <= Date.now() || record.used) {
      notePairFailure(req)
      sendJson(res, 401, { error: 'invalid_or_expired_code' })
      return
    }
    record.used = true
    pairCodes.delete(code)
    // 明文 token 只进 cookie，落盘的永远是哈希。
    const deviceToken = crypto.randomBytes(32).toString('hex')
    const device = {
      id: crypto.randomBytes(8).toString('hex'),
      name: typeof deviceName === 'string' && deviceName.trim() !== '' ? deviceName.trim().slice(0, 40) : defaultDeviceName(req.headers['user-agent'], code),
      token: hashToken(deviceToken),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    }
    state.devices.push(device)
    writeState(state)
    res.statusCode = 302
    res.setHeader('set-cookie', deviceCookie(deviceToken, req))
    res.setHeader('location', '/')
    res.end()
  }

  /** 配对页把 code / UA 直接拼进属性：必须转义，否则公网未授权就能反射 XSS。 */
  function escapeAttr(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  }

  /** 配对码本来就只该是 6 位数字；其它形态一律当空值。 */
  function safePairCode(code) {
    const text = String(code ?? '').trim()
    return /^[0-9]{0,6}$/.test(text) ? text : ''
  }

  function pairPage(req, res, code) {
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>移动控制 · 配对</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  font:15px/1.6 -apple-system,system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#16181d}
@media (prefers-color-scheme:dark){body{background:#0f1115;color:#e8ebf0}}
form{width:100%;max-width:360px;padding:24px;border-radius:18px;background:#fff;
  border:1px solid #e6e8ec;box-shadow:0 12px 32px rgb(15 23 42 / 8%)}
@media (prefers-color-scheme:dark){form{background:#171a21;border-color:#262b36;box-shadow:0 12px 32px rgb(0 0 0 / 35%)}}
h1{margin:0 0 6px;font-size:20px;line-height:28px;font-weight:600}
p.hint{margin:0 0 18px;font-size:13px;line-height:20px;color:#7b8494}
@media (prefers-color-scheme:dark){p.hint{color:#8b93a1}}
label{display:block;margin:0 0 6px;font-size:12px;line-height:16px;color:#7b8494}
.field{margin-bottom:16px}
.field:last-of-type{margin-bottom:4px}
@media (prefers-color-scheme:dark){label{color:#8b93a1}}
input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid #d7dbe2;background:transparent;
  color:inherit;font:inherit;outline:none}
input:focus{border-color:#2563eb}
@media (prefers-color-scheme:dark){input{border-color:#2c313c}}
input#code{font-size:22px;letter-spacing:6px;text-align:center;font-variant-numeric:tabular-nums}
button{margin-top:20px;width:100%;height:44px;border:0;border-radius:10px;background:#2563eb;color:#fff;
  font:600 15px/44px inherit;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
p.err{min-height:18px;margin:10px 0 0;font-size:13px;line-height:18px;color:#dc2626}
</style>
<main><form id="f">
<h1>移动控制配对</h1>
<p class="hint">配对码由电脑端「移动控制」生成，5 分钟内有效。配对成功后这台设备会长期保持登录。</p>
<div class="field"><label for="code">6 位配对码</label>
<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" value="${escapeAttr(safePairCode(code))}"></div>
<div class="field"><label for="name">设备名称</label>
<input id="name" maxlength="40" value="${escapeAttr(defaultDeviceName(req.headers['user-agent'], code))}"></div>
<button id="go" type="submit">配对</button>
<p class="err" id="err"></p>
</form></main>
<script>
const form = document.getElementById('f')
const err = document.getElementById('err')
const go = document.getElementById('go')
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  err.textContent = ''
  go.disabled = true
  go.textContent = '配对中…'
  try {
    const response = await fetch('/mobile-control/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: document.getElementById('code').value.trim(),
        name: document.getElementById('name').value.trim(),
      }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      err.textContent = body.error === 'invalid_or_expired_code'
        ? '配对码无效或已过期，请在电脑端重新生成'
        : (body.error === 'too_many_attempts' ? '尝试次数过多，请 10 分钟后再试' : '配对失败，请重试')
      return
    }
    location.href = '/'
  } catch {
    err.textContent = '网络错误，请确认手机与电脑的连接'
  } finally {
    go.disabled = false
    go.textContent = '配对'
  }
})
</script>
</html>`
    res.statusCode = 200
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    // 这页是公网可访问的：禁掉外链与框架，压掉点击劫持与注入后的横向利用面。
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'")
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-content-type-options', 'nosniff')
    res.end(html)
  }

  // ── 管理接口（只对回环开放） ────────────────────────────────────────────

  function adminAllowed(req) {
    if (!isLoopback(req.socket.remoteAddress)) return false
    // Host 也必须是回环：DNS rebinding 页面不带 Origin，只靠 remoteAddress 会把 /state 读走。
    // 隧道代理会把上游 Host 改写成 127.0.0.1，所以手机端不受影响。
    const host = String(req.headers.host || '')
    const hostname = (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '')).toLowerCase()
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) return false
    const hostPort = (host.match(/:(\d+)$/) ?? [])[1] ?? ''
    const origin = req.headers.origin
    if (typeof origin !== 'string') return true
    try {
      const url = new URL(origin)
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname.toLowerCase())) return false
      // 端口也要对上：本机别的端口上的页面同样不该能调管理接口。
      const originPort = url.port || (url.protocol === 'https:' ? '443' : '80')
      if (hostPort && originPort !== hostPort) return false
      return true
    } catch {
      return false
    }
  }

  async function adminHandler(req, res) {
    if (!adminAllowed(req)) return sendJson(res, 403, { error: 'forbidden' })
    const url = new URL(req.url, 'http://localhost')
    const method = (req.method || 'GET').toUpperCase()
    // 同时兼容改名前的 /mobile-access/api，缓存里的旧客户端也能正常拿到数据。
    const route = url.pathname.replace(/^\/(?:mobile-control|mobile-access)\/api/u, '')
    try {
      if (route === '/state' && method === 'GET') {
        return sendJson(res, 200, {
          enabled: state.enabled,
          port: state.port,
          publicUrl: state.publicUrl,
          tunnelAutostart: state.tunnelAutostart,
          listening: listeningPort,
          error: startError,
          origin: upstreamOrigin(),
          devices: state.devices.map(({ token, ...rest }) => rest),
          excludedClientModules: state.excludedClientModules,
        })
      }
      if (route === '/enable' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        state.enabled = body.enabled === true
        writeState(state)
        await restart()
        return sendJson(res, 200, { enabled: state.enabled, listening: listeningPort, error: startError })
      }
      if (route === '/port' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const port = Number(body.port)
        if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) return sendJson(res, 400, { error: 'invalid_port' })
        state.port = port
        writeState(state)
        await restart()
        return sendJson(res, 200, { port: state.port, listening: listeningPort, error: startError })
      }
      if (route === '/pair/start' && method === 'POST') {
        if (!state.enabled || listeningPort === null) return sendJson(res, 409, { error: 'not_running' })
        prunePairState()
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
        const record = { code, expiresAt: Date.now() + PAIR_CODE_TTL_MS, used: false }
        pairCodes.set(code, record)
        return sendJson(res, 200, { code, expiresAt: record.expiresAt, path: PUBLIC_PREFIX })
      }
      if (route === '/devices/revoke' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const before = state.devices.length
        state.devices = state.devices.filter((device) => device.id !== body.id)
        writeState(state)
        return sendJson(res, 200, { removed: before - state.devices.length })
      }
      if (route === '/tunnel/autostart' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        state.tunnelAutostart = body.enabled === true
        writeState(state)
        if (state.tunnelAutostart) ensureTunnel(bootLog)
        return sendJson(res, 200, { tunnelAutostart: state.tunnelAutostart })
      }
      if (route === '/public-url' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const value = typeof body.publicUrl === 'string' ? body.publicUrl.trim().replace(/\/+$/u, '') : ''
        if (value !== '' && !/^https?:\/\/[^\s]+$/u.test(value)) return sendJson(res, 400, { error: 'invalid_url' })
        state.publicUrl = value
        writeState(state)
        return sendJson(res, 200, { publicUrl: state.publicUrl })
      }
      if (route === '/modules/list' && method === 'GET') {
        const cookie = await upstreamCookieHeader()
        const target = new URL(upstreamOrigin())
        const html = await new Promise((resolve) => {
          const request = http.request({
            hostname: target.hostname.replace(/^\[|\]$/g, ''),
            port: Number(target.port),
            path: '/',
            method: 'GET',
            headers: {
              host: target.host,
              accept: 'text/html',
              'accept-encoding': 'identity',
              ...(cookie === null ? {} : { cookie }),
            },
            agent: false,
          }, (response) => {
            const chunks = []
            response.on('data', (chunk) => chunks.push(chunk))
            response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          })
          request.on('error', () => resolve(''))
          request.setTimeout(20000, () => {
            request.destroy()
            resolve('')
          })
          request.end()
        })
        const parsed = parseBootEntries(html)
        return sendJson(res, 200, { excluded: state.excludedClientModules, entries: parsed })
      }
      if (route === '/modules' && method === 'GET') {
        return sendJson(res, 200, { excluded: state.excludedClientModules })
      }
      if (route === '/modules' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const excluded = Array.isArray(body.excluded) ? body.excluded.filter((id) => typeof id === 'string') : []
        state.excludedClientModules = [...new Set(excluded)]
        writeState(state)
        return sendJson(res, 200, { excluded: state.excludedClientModules })
      }
      return sendJson(res, 404, { error: 'not_found' })
    } catch (error) {
      return sendJson(res, 500, { error: String(error?.message || error) })
    }
  }

  // ── 代理服务生命周期 ────────────────────────────────────────────────────

  async function restart() {
    // 关闭时必须主动断开 keep-alive 连接：server.close() 只等存量连接结束，
    // 手机/浏览器的长连接会让它一直挂起，表现为「开关点了但端口还在监听」。
    if (server !== null) {
      const closing = server
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { closing.closeAllConnections?.() } catch {}
          resolve()
        }, 1000)
        try { closing.closeAllConnections?.() } catch {}
        closing.close(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      if (globalThis[SERVER_SLOT] === closing) delete globalThis[SERVER_SLOT]
      server = null
    }
    listeningPort = null
    startError = null
    if (!state.enabled) return
    // 热重载时旧监听的 close 是异步的，新实例可能先撞 EADDRINUSE，短延迟重试即可。
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const outcome = await new Promise((resolve) => {
        const next = http.createServer((req, res) => {
          const url = new URL(req.url, 'http://localhost')
          // 健康检查对隧道/监控公开，不走设备认证。
          if (url.pathname === '/mobile-control/health') return sendJson(res, 200, { ok: true })
          // 管理接口只给本机：隧道侧已配对设备等价于管理员，能铸新配对码、踢设备、改端口，
          // 这里只放行只读的 /state，写操作一律要求走 59681。
          if (url.pathname.startsWith('/mobile-control/api') || url.pathname.startsWith('/mobile-access/api')) {
            const adminPath = url.pathname.replace(/^\/(?:mobile-control|mobile-access)\/api/, '') || '/'
            const readOnly = (req.method === 'GET') && (adminPath === '/' || adminPath === '/state')
            if (!readOnly) return sendJson(res, 403, { error: 'admin_local_only' })
          }
          // 配对码不放进 URL：query 会留在浏览器历史与边缘日志里，页面只接受手动输入。
          if (url.pathname === '/mobile-control/pair' && req.method === 'GET') return pairPage(req, res, '')
          if (url.pathname === '/mobile-control/pair' && req.method === 'POST') {
            return readBody(req)
              .catch(() => null)
              .then((text) => {
                if (text === null) return sendJson(res, 413, { error: 'body_too_large' })
                let body = {}
                try {
                  body = JSON.parse(text || '{}')
                } catch {}
                tryPair(req, res, String(body.code ?? ''), body.name)
              })
          }
          authorizedDevice(req).then((device) => {
            if (device === null) {
              res.statusCode = 401
              res.setHeader('content-type', 'text/html; charset=utf-8')
              res.end('<meta charset="utf-8"><p>未配对。<a href="/mobile-control/pair">点此配对</a></p>')
              return
            }
            res.__mobileDevice = device
            handleProxy(req, res).catch(() => {
              if (!res.headersSent) sendJson(res, 502, { error: 'proxy_failed' })
            })
          }).catch(() => sendJson(res, 500, { error: 'auth_failed' }))
        })
        next.on('upgrade', handleSocketUpgrade)
        next.once('error', (error) => {
          if (error.code === 'EADDRINUSE' && attempt < 5) {
            try { next.close() } catch {}
            resolve('retry')
            return
          }
          startError = error.code === 'EADDRINUSE' ? 'port_in_use' : String(error.code ?? error.message)
          resolve('fail')
        })
        next.listen(state.port, '127.0.0.1', () => {
          listeningPort = next.address().port
          server = next
          globalThis[SERVER_SLOT] = next
          resolve('ok')
        })
      })
      if (outcome === 'ok' || outcome === 'fail') return
      await new Promise((r) => setTimeout(r, 250))
    }
    startError = 'port_in_use'
  }

  bootLog('before register')
  let unregister = null
  try {
    unregister = ctx.webServer.register({ kind: 'prefix', path: ADMIN_PREFIX, handler: adminHandler })
  } catch (error) {
    // 重复注册等错误不吞：吞掉会变成「插件活着但路由全 404」，比直接失败更难查。
    bootLog(`register failed: ${String(error?.message ?? error)}`)
    throw error
  }
  globalThis[ROUTE_SLOT] = unregister
  // 兼容改名前的客户端缓存：旧 bundle 仍在请求 /mobile-access/api，给个别名免得用户看到 404。
  try {
    const legacy = ctx.webServer.register({ kind: 'prefix', path: '/mobile-access/api', handler: adminHandler })
    if (typeof globalThis[LEGACY_ROUTE_SLOT] === 'function') globalThis[LEGACY_ROUTE_SLOT]()
    globalThis[LEGACY_ROUTE_SLOT] = legacy
  } catch (error) {
    bootLog('legacy route skipped: ' + String(error?.message ?? error))
  }
  bootLog(`registered ${ADMIN_PREFIX}`)

  let tunnelTimer = null
  if (state.tunnelAutostart) {
    tunnelTimer = setInterval(() => {
      if (!state.tunnelAutostart) return
      ensureTunnel(bootLog)
    }, 60000)
    if (typeof tunnelTimer.unref === 'function') tunnelTimer.unref()
  }

  restart().then(() => {
    bootLog(`restart done listening=${String(listeningPort)} error=${String(startError)} enabled=${String(state.enabled)} port=${String(state.port)}`)
  }).catch((error) => {
    startError = String(error?.message ?? error)
    bootLog(`restart failed: ${startError}`)
  })

  ctx.effect(() => () => {
    if (tunnelTimer !== null) clearInterval(tunnelTimer)
    unregister?.()
    if (globalThis[ROUTE_SLOT] === unregister) delete globalThis[ROUTE_SLOT]
    if (server !== null) {
      try {
        server.close()
      } catch {}
      if (globalThis[SERVER_SLOT] === server) delete globalThis[SERVER_SLOT]
    }
    server = null
  })
}
