/**
 * 配置系统：config.json + CLI 参数 + 环境变量，三级来源合并。
 *
 * 优先级（低 → 高）：
 *   1. 内置默认值（下方 DEFAULTS，删掉 config.json 即回到这些值）
 *   2. config.json（默认读项目根目录的 config.json，可用 --config PATH 指定其它位置）
 *   3. CLI 参数（显式传参时覆盖配置文件对应项）
 *   4. 环境变量（目前仅 WORKBUDDY_AUTH_FILE，个别项支持）
 *
 * 配置分组（后续要加开关，就在对应分组里加键，并在 DEFAULTS 补默认值即可）：
 *   server   监听地址/端口
 *   auth     桌面端 auth 文件
 *   log      请求日志开关与路径（用户最常改的开关）
 *   security 鉴权 key / system 脱敏 / 身份指纹清洗
 *   upstream 上游 effort / 思考并入正文 / max_tokens 上限
 *
 * 约定：配置文件里的相对路径（log.path、auth.file）一律相对「配置文件所在目录」解析。
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_DIR = dirname(fileURLToPath(import.meta.url))
/** 项目根目录（src/ 的上一级） */
export const PROJECT_ROOT = join(SRC_DIR, '..')

/** 内置默认值：没有 config.json（或没写某键）时生效 */
export const DEFAULTS = {
  server: { host: '127.0.0.1', port: 8788 },
  auth: { file: '' }, // 留空 = 自动扫描桌面端
  log: { enabled: false, path: '' }, // 项目内已附 config.json（enabled:true），此处兜底关日志
  security: { apiKey: '', desensitize: true, sanitizeIdentity: true },
  upstream: { effort: '', keepReasoningAsText: false, maxTokensDefault: 16000 },
}

const EFFORT_LEVELS = ['', 'off', 'low', 'medium', 'high']

function isObj(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

export function defaultConfigPath() {
  return join(PROJECT_ROOT, 'config.json')
}

/** 读取配置文件；文件不存在返回 null，解析失败抛错 */
export async function readConfigFile(path) {
  if (!existsSync(path)) return null
  const raw = await readFile(path, 'utf8')
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    throw new Error(`配置文件解析失败 ${path}: ${error.message}`)
  }
  if (!isObj(data)) throw new Error(`配置文件格式错误: ${path} 顶层必须是 JSON 对象`)
  return data
}

/** 把文件里的分组覆盖到 defaults 上（只认 defaults 里已有的键，多余键忽略） */
export function applyOverrides(base, over) {
  const out = JSON.parse(JSON.stringify(base))
  if (!isObj(over)) return out
  for (const group of Object.keys(out)) {
    const g = over[group]
    if (!isObj(g)) continue
    for (const key of Object.keys(out[group])) {
      if (g[key] !== undefined) out[group][key] = g[key]
    }
  }
  return out
}

/** 值域校验，非法直接抛错（调用方负责转成友好退出） */
export function validateConfig(cfg) {
  const { port, host } = cfg.server
  if (typeof host !== 'string' || host === '') throw new Error('server.host 不能为空')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`server.port 非法: ${port}（需 1-65535 的整数）`)
  }
  if (!EFFORT_LEVELS.includes(String(cfg.upstream.effort))) {
    throw new Error(`upstream.effort 只接受 off/low/medium/high 或留空，收到: ${cfg.upstream.effort}`)
  }
  const maxT = cfg.upstream.maxTokensDefault
  if (typeof maxT !== 'number' || !Number.isInteger(maxT) || maxT <= 0) {
    throw new Error(`upstream.maxTokensDefault 需为正整数: ${maxT}`)
  }
}

/**
 * 汇总三层来源，返回最终配置。
 * @param {object} cli  parseArgs 解析出的 CLI 覆盖项（undefined = 未显式指定）
 * @returns {Promise<{cfg: object, source: string|null}>}
 *   cfg   合并+校验+路径解析后的最终配置
 *   source 实际生效的配置文件路径；null 表示用内置默认
 */
export async function resolveConfig(cli = {}) {
  const filePath = cli.config || defaultConfigPath()
  const file = await readConfigFile(filePath).catch((error) => {
    // --config 指定了文件但读不了 → 必须报错；默认路径读不了 → 退回内置默认
    if (cli.config) throw error
    console.warn(`[config] 读取默认配置失败，退回内置默认: ${error.message}`)
    return null
  })

  let cfg = applyOverrides(DEFAULTS, file || {})

  // --- CLI 覆盖（显式传参才覆盖，未传保持配置值） ---
  if (cli.host !== undefined) cfg.server.host = cli.host
  if (cli.port !== undefined) cfg.server.port = cli.port
  if (cli.authFile !== undefined) cfg.auth.file = cli.authFile
  if (cli.apiKey !== undefined) cfg.security.apiKey = cli.apiKey
  if (cli.effort !== undefined) cfg.upstream.effort = cli.effort
  if (cli.keepReasoningAsText !== undefined) cfg.upstream.keepReasoningAsText = cli.keepReasoningAsText
  if (cli.desensitize !== undefined) cfg.security.desensitize = cli.desensitize
  if (cli.sanitizeIdentity !== undefined) cfg.security.sanitizeIdentity = cli.sanitizeIdentity
  if (cli.maxTokensDefault !== undefined) cfg.upstream.maxTokensDefault = cli.maxTokensDefault
  // 日志：--no-log 硬关；--log PATH 开启并改路径
  if (cli.logPath !== undefined) {
    cfg.log.enabled = true
    cfg.log.path = cli.logPath
  }
  if (cli.noLog) cfg.log.enabled = false

  // --- 环境变量（最高优先，仅个别项） ---
  if (process.env.WORKBUDDY_AUTH_FILE) cfg.auth.file = process.env.WORKBUDDY_AUTH_FILE

  validateConfig(cfg)

  // 相对路径统一按「配置文件所在目录」解析（无配置文件则按项目根目录）
  const baseDir = file ? dirname(filePath) : PROJECT_ROOT
  const toAbs = (p) => (p && !isAbsolute(p) ? join(baseDir, p) : p)
  if (cfg.log.path) cfg.log.path = toAbs(cfg.log.path)
  if (cfg.auth.file) cfg.auth.file = toAbs(cfg.auth.file)

  return { cfg, source: file ? filePath : null }
}
