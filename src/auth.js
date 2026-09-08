/**
 * 凭据模块：读取 CodeBuddy/WorkBuddy 桌面 App 的登录态（只读），
 * token 临近过期时自动调上游刷新，并把刷新结果保存在本程序自己的
 * 缓存文件中 —— 绝不回写桌面 App 的 auth 文件（避免并发写冲突）。
 *
 * 设计对齐 dsh-workbuddy-connect 的 auth.ts：
 *  - 桌面文件与本地缓存双源，谁的 accessToken 过期更晚用谁；
 *  - 刷新单飞（并发请求共享一次刷新）。
 */

import { readFile, writeFile, rename, stat, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { CHAT } from './upstream.js'
import { expiryToMs, regionOf } from './util.js'

/** 平台默认桌面 auth 目录候选（按优先级） */
export function desktopAuthCandidates() {
  const home = homedir()
  const list = []
  const platform = process.platform
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    list.push(join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
    // dsh 源码写的是 Roaming，实测桌面端实际写 Local，这里两个都兜底
    list.push(join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
  } else if (platform === 'darwin') {
    list.push(join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
  } else {
    const xdg = process.env.XDG_DATA_HOME || join(home, '.local', 'share')
    list.push(join(xdg, 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
    list.push(join(home, '.config', 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
  }
  return list
}

/** 在候选目录里找 *.info（优先 workbuddy-desktop.info） */
export async function findDesktopAuthFile(extraPath) {
  if (extraPath) return (await stat(extraPath).catch(() => null))?.isFile() ? extraPath : null
  for (const dir of desktopAuthCandidates()) {
    const entries = await readdirSafe(dir)
    if (!entries) continue
    const infoFiles = entries.filter((f) => f.endsWith('.info')).sort()
    if (infoFiles.length === 0) continue
    const preferred = infoFiles.find((f) => f.startsWith('workbuddy-desktop'))
    return join(dir, preferred || infoFiles[0])
  }
  return null
}

async function readdirSafe(dir) {
  try {
    const { readdir } = await import('node:fs/promises')
    return await readdir(dir)
  } catch {
    return null
  }
}

/** 本地刷新缓存（默认 ~/.claude-codebuddy/credential.json） */
export function defaultOwnAuthPath() {
  return join(homedir(), '.claude-codebuddy', 'credential.json')
}

const OWN_FORMAT_VERSION = 1

/**
 * 解析桌面 auth 文档。兼容两种形态：
 *  - 嵌套：{"auth":{...},"account":{...}}
 *  - 扁平：{accessToken, refreshToken, uid, ...}
 * 返回规范凭据或 undefined。
 */
export function parseWorkBuddyAuth(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined

  let auth, identity
  if (typeof parsed.auth === 'object' && parsed.auth !== null) {
    auth = parsed.auth
    identity = typeof parsed.account === 'object' && parsed.account !== null ? parsed.account : {}
  } else {
    auth = parsed
    identity = parsed
  }
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
  if (accessToken === '') return undefined

  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    expiresAtMs: expiryToMs(auth.expiresAt),
    refreshExpiresAtMs: expiryToMs(auth.refreshExpiresAt) || undefined,
    domain: typeof auth.domain === 'string' && auth.domain !== '' ? auth.domain : '',
    uid: typeof identity.uid === 'string' ? identity.uid : '',
    enterpriseId: typeof identity.enterpriseId === 'string' && identity.enterpriseId !== '' ? identity.enterpriseId : undefined,
    nickname: typeof identity.nickname === 'string' && identity.nickname !== '' ? identity.nickname : undefined,
    source: 'desktop',
  }
}

/** 解析本地缓存文档 */
function parseOwnDocument(text) {
  try {
    const doc = JSON.parse(text)
    if (typeof doc !== 'object' || doc === null) return undefined
    if (doc.version !== OWN_FORMAT_VERSION) return undefined
    const credential = parseWorkBuddyAuth(JSON.stringify({ auth: doc.credential }))
    return credential === undefined ? undefined : { ...credential, source: 'cache' }
  } catch {
    return undefined
  }
}

function ownDocument(credential) {
  return { version: OWN_FORMAT_VERSION, credential }
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000 // 提前 5 分钟刷新

export class CredentialStore {
  constructor(options = {}) {
    this.desktopPathOverride = options.desktopPath
    this.ownPath = options.ownPath ?? defaultOwnAuthPath()
    this.marginMs = options.refreshMarginMs ?? REFRESH_MARGIN_MS
    this.inflight = undefined
  }

  desktopPath() {
    return this.desktopPathOverride
  }

  async desktopFile() {
    return findDesktopAuthFile(this.desktopPathOverride)
  }

  async readDesktop() {
    const file = await this.desktopFile()
    if (!file) return undefined
    try {
      return parseWorkBuddyAuth(await readFile(file, 'utf8'))
    } catch {
      return undefined
    }
  }

  async readOwn() {
    try {
      return parseOwnDocument(await readFile(this.ownPath, 'utf8'))
    } catch {
      return undefined
    }
  }

  /** 双源取过期更晚者 */
  async current() {
    const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()])
    if (desktop === undefined) return own
    if (own === undefined) return desktop
    return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
  }

  async needsRefresh(credential) {
    if (!credential || credential.accessToken === '') return true
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.marginMs >= credential.expiresAtMs
  }

  /** 取可用凭据，必要时刷新（单飞） */
  async resolve() {
    const credential = await this.current()
    if (credential === undefined) {
      const where = this.desktopPathOverride || '(自动扫描)'
      throw new Error(`未找到已登录的 CodeBuddy/WorkBuddy 账号：请先在本机桌面端登录一次 (auth: ${where})`)
    }
    if (!(await this.needsRefresh(credential))) return credential
    this.inflight ??= this.refreshNow(credential).finally(() => { this.inflight = undefined })
    return this.inflight
  }

  async refreshNow(credential) {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('access token 已过期且没有 refresh token，请重新打开 CodeBuddy/WorkBuddy 桌面端登录')
    }
    try {
      const outcome = await CHAT.refreshToken(credential)
      const refreshed = {
        ...credential,
        accessToken: outcome.accessToken,
        ...(outcome.refreshToken ? { refreshToken: outcome.refreshToken } : {}),
        expiresAtMs: outcome.expiresInSec ? Date.now() + outcome.expiresInSec * 1000 : credential.expiresAtMs,
        ...(outcome.domain ? { domain: outcome.domain } : {}),
        source: 'cache',
      }
      await this.saveOwn(refreshed)
      return refreshed
    } catch (error) {
      // 刷新失败但当前 token 还能用 → 放行，别让偶发网络问题打挂会话
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(`token 刷新失败且已过期，请打开桌面端重新登录 (${error.message})`)
    }
  }

  async saveOwn(credential) {
    await mkdir(dirname(this.ownPath), { recursive: true })
    const tmp = `${this.ownPath}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.ownPath)
  }

  async status() {
    try {
      const credential = await this.current()
      if (credential === undefined) return { state: 'signed-out' }
      return {
        state: 'signed-in',
        nickname: credential.nickname,
        domain: credential.domain,
        uid: credential.uid,
        expiresAtMs: credential.expiresAtMs,
        refreshExpiresAtMs: credential.refreshExpiresAtMs,
        source: credential.source,
      }
    } catch {
      return { state: 'signed-out' }
    }
  }
}
