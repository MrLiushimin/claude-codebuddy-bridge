/**
 * HTTP 服务：对 Claude Code 暴露 Anthropic Messages API。
 *
 * 路由：
 *   POST /v1/messages   聊天主入口（流式/非流式、工具调用）
 *   GET  /v1/models     模型列表（Anthropic 风格）
 *   GET  /health        状态：账号 / token 过期 / 剩余积分 / 模型数
 *   GET  /              欢迎页
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { CHAT, prepareChatBody, friendlyError } from './upstream.js'
import { convertRequest, AnthropicRenderer, errorJSON, getLastDesensitizeHits, getLastIdentityHits } from './convert.js'
import { fmtExpiry } from './util.js'

const VERSION = '1.0.0'
const CATALOG_TTL_MS = 15 * 60 * 1000
const CREDITS_TTL_MS = 30 * 1000

/** 目录拉取失败时的兜底模型（真实目录以 /console/enterprises/personal/models 为准） */
const FALLBACK_MODELS = [
  { id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 200000, maxTokens: 16384 },
  { id: 'glm-5.2', name: 'GLM 5.2', contextWindow: 200000, maxTokens: 16384 },
  { id: 'glm-5v-turbo', name: 'GLM 5V Turbo', contextWindow: 128000, maxTokens: 8192 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 128000, maxTokens: 8192 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 128000, maxTokens: 8192 },
  { id: 'kimi-k2.7', name: 'Kimi K2.7', contextWindow: 200000, maxTokens: 8192 },
  { id: 'minimax-m3-pay', name: 'MiniMax M3', contextWindow: 128000, maxTokens: 8192 },
  { id: 'hy3-preview-agent', name: 'Hy3 Preview', contextWindow: 128000, maxTokens: 8192 },
]

/** 上游错误 kind -> Anthropic error type / HTTP 状态 */
const ERROR_KIND_STATUS = {
  hard_credit: 402,
  session_dead: 401,
  soft_rate: 429,
  not_found: 404,
  server: 502,
  client: 400,
}
const ERROR_KIND_TYPE = {
  hard_credit: 'permission_error',
  session_dead: 'authentication_error',
  soft_rate: 'rate_limit_error',
  not_found: 'not_found_error',
  server: 'api_error',
  client: 'api_error',
}

/**
 * 模型名规范化：cc-switch / cc-gui 等客户端的模型列表常用「展示名」，
 * 例如 `hy4-preview[1m]`、`codebuddy/hy4-preview`。这些带上下文后缀/前缀的
 * 名字不是 CodeBuddy 上游的真实 model id，直接转发会被上游渠道安全策略
 * 拦成 11128 / 11102。这里把它清洗回目录里的真实 id。
 */
function normalizeModelName(raw, catalogModels) {
  if (typeof raw !== 'string') return { model: raw || '', normalized: false }
  const cleaned = raw.trim()
  const ids = new Set(catalogModels.map((m) => String(m.id).toLowerCase()))
  const tryMatch = (candidate) => {
    if (!candidate) return undefined
    if (ids.has(candidate.toLowerCase())) return candidate
    return undefined
  }
  // 1) 原样
  if (tryMatch(cleaned)) return { model: cleaned, normalized: false }
  // 2) 去掉 [xxx] 上下文后缀（如 hy4-preview[1m] -> hy4-preview）
  const noSuffix = cleaned.replace(/\[[^\]]*\]/g, '').trim()
  if (noSuffix !== cleaned) {
    if (tryMatch(noSuffix)) return { model: noSuffix, normalized: true }
  }
  // 3) 去掉 provider 前缀（如 codebuddy/hy4-preview -> hy4-preview）
  const slashIdx = noSuffix.lastIndexOf('/')
  if (slashIdx !== -1) {
    const afterSlash = noSuffix.slice(slashIdx + 1).trim()
    if (afterSlash && tryMatch(afterSlash)) return { model: afterSlash, normalized: true }
  }
  // 4) 都匹配不上：至少去掉 [..] 后缀再透传，尽量贴近上游真实 id
  if (noSuffix !== cleaned) return { model: noSuffix, normalized: true }
  return { model: cleaned, normalized: false }
}

export function createBridgeApp(options) {
  const { store, effort, keepReasoningAsText, maxTokensDefault, apiKey, desensitize, sanitizeIdentity } = options
  const log = options.log || (() => {})
  const state = {
    catalog: { at: 0, models: null, error: null, inflight: null },
    credits: { at: 0, data: null, error: null },
  }

  async function loadCatalog(force = false) {
    if (!force && state.catalog.models && Date.now() - state.catalog.at < CATALOG_TTL_MS) {
      return state.catalog
    }
    if (state.catalog.inflight) return state.catalog.inflight
    state.catalog.inflight = (async () => {
      try {
        const credential = await store.resolve()
        const models = await CHAT.fetchModels(credential)
        state.catalog = { at: Date.now(), models, error: null, inflight: null }
      } catch (error) {
        state.catalog = { at: Date.now(), models: state.catalog.models, error: error.message, inflight: null }
      }
      return state.catalog
    })()
    return state.catalog.inflight
  }

  async function loadCredits(force = false) {
    if (!force && state.credits.data && Date.now() - state.credits.at < CREDITS_TTL_MS) {
      return state.credits
    }
    try {
      const credential = await store.resolve()
      const data = await CHAT.fetchCredits(credential)
      state.credits = { at: Date.now(), data, error: null }
    } catch (error) {
      state.credits = { at: Date.now(), data: state.credits.data, error: error.message }
    }
    return state.credits
  }

  /** 客户端本地鉴权（可选） */
  function checkLocalAuth(req) {
    if (!apiKey) return true
    const xk = req.headers['x-api-key']
    const authz = req.headers.authorization || ''
    const token = xk || (authz.startsWith('Bearer ') ? authz.slice(7) : '')
    return token === apiKey
  }

  function modelsList() {
    const models = state.catalog.models || FALLBACK_MODELS
    return models.map((m) => ({
      type: 'model',
      id: m.id,
      display_name: m.name || m.id,
      created_at: '2026-01-01T00:00:00Z',
    }))
  }

  async function handleMessages(req, res) {
    if (!checkLocalAuth(req)) {
      return sendJSON(res, 401, errorJSON(401, 'authentication_error', 'invalid api key'))
    }
    const rid = `req_${randomUUID().slice(0, 8)}`
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (error) {
      return sendJSON(res, 400, errorJSON(400, 'invalid_request_error', `bad json: ${error.message}`))
    }
    // 日志：请求摘要（角色/块类型分布，不落完整对话正文，避免日志过大）
    logSummary(log, rid, body)

    // 模型名规范化：cc-switch/cc-gui 列表常带 [1m] 等展示后缀，直接转发会被上游渠道策略拦 11128
    const catalog = await loadCatalog()
    const catalogModels = catalog.models || FALLBACK_MODELS
    const { model, normalized } = normalizeModelName(body.model, catalogModels)
    if (normalized) log(`${rid} ▶ 模型名规范化: '${body.model}' -> '${model}' (去除展示后缀/前缀)`)

    // 目录里的模型输出上限 → 钳制 max_tokens
    const modelInfo = catalogModels.find((m) => m.id === model)
    const maxTokensCap = modelInfo ? modelInfo.maxTokens : 0
    let openaiBody
    try {
      openaiBody = convertRequest({ ...body, model }, {
        maxTokensCap,
        maxTokensDefault,
        effort,
        keepReasoningAsText,
        desensitize,
        sanitizeIdentity,
      })
    } catch (error) {
      return sendJSON(res, 400, errorJSON(400, 'invalid_request_error', `convert request: ${error.message}`))
    }
    const idHits = getLastIdentityHits()
    if (idHits > 0) log(`${rid} ▶ system 身份指纹清洗 ${idHits} 处(billing头/Claude Code官方声明等,根除11128渠道识别)`)
    const dsHits = getLastDesensitizeHits()
    if (dsHits > 0) log(`${rid} ▶ system 脱敏命中 ${dsHits} 处安全词(插零宽空格)`)

    let credential
    try {
      credential = await store.resolve()
    } catch (error) {
      return sendJSON(res, 503, errorJSON(503, 'authentication_error', error.message))
    }

    const wantStream = body.stream === true
    const abort = new AbortController()
    const onClientClose = () => { abort.abort() }
    req.on('close', onClientClose)

    const upstreamBodyJson = JSON.stringify(prepareChatBody(openaiBody))
    const upstream = await CHAT.chatStream(credential, upstreamBodyJson, abort.signal)
    if (!upstream.ok) {
      req.off('close', onClientClose)
      log(`${rid} ✗ upstream http=${upstream.status} kind=${upstream.kind} body=${upstream.message.slice(0, 400)}`)
      // 11128 内容风控：把被拒请求的特征落盘，便于定位触发词（本地排障用）
      if (upstream.message.includes('11128')) {
        logFailBody(log, rid, openaiBody)
      }
      const status = ERROR_KIND_STATUS[upstream.kind] || 502
      const type = ERROR_KIND_TYPE[upstream.kind] || 'api_error'
      const message = friendlyError(upstream.kind, upstream.message)
      // 11128 渠道安全策略拦截 → 给一条可操作的中文提示
      const hint = upstream.message.includes('11128')
        ? '。上游把请求判为「未批准渠道/模型」(安全策略)。常见原因：模型名带了 [1m] 等展示后缀或非目录里的名字（桥已自动清洗一次，请确认配置用的是 GET /v1/models 返回的纯 id，如 hy4-preview 而不是 hy4-preview[1m]）。仍复现请用 --log bridge.log 抓日志'
        : ''
      return sendJSON(res, status, errorJSON(status, type, `${message}${hint}`))
    }

    const renderer = new AnthropicRenderer({
      model: model || openaiBody.model || 'unknown',
      keepReasoningAsText,
    })

    if (wantStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(renderer.startEvent())
      try {
        await pipeUpstreamToAnthropic(upstream.response, renderer, (events) => res.write(events))
        if (!renderer.sawError) res.write(renderer.finishEvents().join(''))
      } catch (error) {
        const msg = error?.name === 'AbortError' ? 'client aborted' : String(error?.message || error)
        if (!res.writableEnded) {
          res.write(sseEvent('error', errorJSON(502, 'api_error', `上游流中断: ${msg}`)))
        }
      } finally {
        req.off('close', onClientClose)
        log(`${rid} ◀ stream end (sawError=${renderer.sawError})`)
        res.end()
      }
      return
    }

    // 非流式：聚合上游 SSE → Anthropic message JSON
    try {
      await pipeUpstreamToAnthropic(upstream.response, renderer, () => {})
      if (renderer.sawError) {
        return sendJSON(res, 502, errorJSON(502, 'api_error', renderer.errorMessage || 'upstream stream error'))
      }
      renderer.finishEvents()
      const message = renderer.toMessageJSON()
      log(`${rid} ◀ done stop=${message.stop_reason}`)
      sendJSON(res, 200, message)
    } catch (error) {
      sendJSON(res, 502, errorJSON(502, 'api_error', `上游聚合失败: ${error.message}`))
    } finally {
      req.off('close', onClientClose)
    }
  }

  async function handleModels(res) {
    await loadCatalog().catch(() => {})
    sendJSON(res, 200, {
      data: modelsList(),
      has_more: false,
      first_id: null,
      last_id: null,
    })
  }

  async function handleHealth(res) {
    const [authStatus, credits] = await Promise.all([
      store.status(),
      loadCredits().catch(() => state.credits),
    ])
    await loadCatalog().catch(() => {})
    const catalog = state.catalog
    const payload = {
      status: 'ok',
      service: 'claude-codebuddy-bridge',
      version: VERSION,
      apiKeyRequired: Boolean(apiKey),
      credential: {
        state: authStatus.state,
        nickname: authStatus.nickname,
        domain: authStatus.domain,
        expires_at: authStatus.expiresAtMs ? fmtExpiry(authStatus.expiresAtMs) : null,
        source: authStatus.source,
      },
      credits: credits.data
        ? { total: credits.data.total, packages: credits.data.accounts }
        : { error: credits.error || 'signed-out' },
      models: {
        count: (catalog.models || FALLBACK_MODELS).length,
        list: (catalog.models || FALLBACK_MODELS).map((m) => m.id),
        source: catalog.models ? 'upstream' : 'fallback',
        ...(catalog.error ? { error: catalog.error } : {}),
      },
    }
    sendJSON(res, 200, payload)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    if (req.method === 'POST' && path === '/v1/messages') {
      handleMessages(req, res).catch((error) => {
        if (!res.headersSent) sendJSON(res, 500, errorJSON(500, 'api_error', `internal: ${error.message}`))
        else res.end()
      })
    } else if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      handleModels(res).catch(() => sendJSON(res, 500, errorJSON(500, 'api_error', 'models unavailable')))
    } else if (req.method === 'GET' && (path === '/health' || path === '/status')) {
      handleHealth(res).catch(() => sendJSON(res, 500, errorJSON(500, 'api_error', 'health unavailable')))
    } else if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('claude-codebuddy-bridge\n\nPOST /v1/messages\nGET /v1/models\nGET /health\n')
    } else {
      sendJSON(res, 404, errorJSON(404, 'not_found_error', `unknown path ${path}`))
    }
  })
  return server
}

// ---------------------------------------------------------------------------

/** 请求摘要日志：角色序列 + 内容块类型分布，不落完整正文 */
function logSummary(log, rid, body) {
  const roles = []
  const typeCount = new Map()
  const inc = (k) => typeCount.set(k, (typeCount.get(k) || 0) + 1)
  const scanContent = (content) => {
    if (typeof content === 'string') { inc('text'); return }
    if (Array.isArray(content)) for (const b of content) {
      if (b && typeof b === 'object') inc(b.type || 'unknown')
      else inc('text')
    }
  }
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m) continue
    roles.push(m.role)
    scanContent(m.content)
  }
  const systemText = typeof body.system === 'string' ? body.system
    : Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('') : ''
  const parts = [
    `▶ POST model=${body.model}`, `stream=${body.stream === true}`,
    `msgs=${(body.messages || []).length}`, `roles=[${roles.join(',')}]`,
    `blocks={${[...typeCount.entries()].map(([k, v]) => `${k}:${v}`).join(',')}}`,
    `systemChars=${systemText.length}`, `tools=${(body.tools || []).length}`,
    `max_tokens=${body.max_tokens}`, `thinking=${body.thinking ? body.thinking.type : 'off'}`,
  ]
  log(`${rid} ${parts.join(' | ')}`)
}

/** 11128 被拒时：dump 请求特征（system 全文 + 工具定义），
 *  用于在日志里定位触发渠道风控的词。只在 11128 且 --log 开启时调用。 */
function logFailBody(log, rid, openaiBody) {
  try {
    for (const m of openaiBody.messages || []) {
      if (m.role === 'system') log(`${rid} ── SYSTEM ──\n${m.content}`)
    }
    for (const t of openaiBody.tools || []) {
      const fn = t.function || {}
      log(`${rid} TOOL ${fn.name}: ${String(fn.description || '').slice(0, 300)}`)
    }
  } catch {
    /* dump 失败不影响主流程 */
  }
}

function sseEvent(type, obj) {
  return `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`
}

/** 读上游 SSE 流，逐 chunk 调 renderer，把事件字符串交给 onEvents */
async function pipeUpstreamToAnthropic(response, renderer, onEvents) {
  if (!response || !response.body) throw new Error('上游没有可读的响应体')
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newlineIndex
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let obj
      try {
        obj = JSON.parse(data)
      } catch {
        continue
      }
      const events = renderer.onChunk(obj)
      if (events.length) onEvents(events.join(''))
      if (renderer.sawError) return // 上游在流中报错，结束
    }
  }
  // 剩余残行（无换行结尾）
  if (buffer.trim()) {
    const data = buffer.trim().replace(/^data:\s*/, '')
    if (data && data !== '[DONE]') {
      try {
        const obj = JSON.parse(data)
        const events = renderer.onChunk(obj)
        if (events.length) onEvents(events.join(''))
      } catch {
        /* ignore trailing partial */
      }
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      chunks.push(c)
      size += c.length
      if (size > 50 * 1024 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJSON(res, status, payload) {
  if (res.headersSent) return res.end()
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}
