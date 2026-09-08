/**
 * 共享常量与工具
 */

/** 区域基址 */
export const CN_CHAT_BASE = 'https://copilot.tencent.com'
export const CN_BILLING_BASE = 'https://www.codebuddy.cn'
export const GLOBAL_BASE = 'https://www.workbuddy.ai'

export const DEFAULT_DOMAIN = 'www.codebuddy.cn'
/** 与官方 CLI 一致的 UA */
export const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** 凭据里 domain 对应的区域 */
export function regionOf(domain) {
  const d = String(domain || '').trim().toLowerCase()
  if (d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai')) return 'global'
  return 'cn'
}

export function chatBase(credential) {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
}

export function billingBase(credential) {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

export function originReferer(credential) {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

/** 脱敏输出 token */
export function maskSecret(value) {
  if (typeof value !== 'string' || value === '') return ''
  if (value.length <= 8) return '***'
  return `${value.slice(0, 6)}…(${value.length} chars)`
}

/** 兼容秒/毫秒时间戳 → 毫秒 */
export function expiryToMs(value) {
  if (typeof value !== 'number' || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

export function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

/** 人类可读的过期时间 */
export function fmtExpiry(ms) {
  if (!ms) return '(未知)'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}
