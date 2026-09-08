/**
 * 上游客户端：CodeBuddy/WorkBuddy (copilot.tencent.com) 的 chat 流式、
 * token 刷新、模型目录与积分查询。协议细节对齐
 * Sliverkiss/workbuddy2api (Go, 久经实战) 与 dsh-workbuddy-connect。
 */

import { CLIENT_UA, chatBase, billingBase, originReferer } from './util.js'

const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/** 会话失效标记（需重新登录） */
const SESSION_DEAD_MARKERS = ['Offline user session not found', '12153']

const HARD_CREDIT_MARKERS = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

export function classifyUpstreamError(status, body) {
  if (status === 402) return 'hard_credit'
  const lower = String(body).toLowerCase()
  for (const m of HARD_CREDIT_MARKERS) {
    if (lower.includes(m.toLowerCase()) || String(body).includes(m)) return 'hard_credit'
  }
  for (const m of SESSION_DEAD_MARKERS) {
    if (String(body).includes(m)) return 'session_dead'
  }
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

export function friendlyError(kind, message) {
  switch (kind) {
    case 'hard_credit':
      return `CodeBuddy 积分不足/额度用完，请到桌面端查看积分套餐。原始返回：${message}`
    case 'session_dead':
      return 'CodeBuddy 登录会话已失效，请打开桌面端重新登录一次。'
    case 'soft_rate':
      return `CodeBuddy 上游限流(429)，请稍后重试。原始返回：${message}`
    case 'server':
      return `CodeBuddy 上游服务异常(5xx)：${message}`
    case 'not_found':
      return `CodeBuddy 上游 404，模型 ID 可能不在你的订阅里：${message}`
    default:
      return `CodeBuddy 上游错误：${message}`
  }
}

function commonHeaders(credential) {
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: originReferer(credential),
    Referer: `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

function chatHeaders(credential) {
  const headers = {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    // 安全红线：chat 请求绝不携带 refresh token
    ...(credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid }),
    ...(!credential.enterpriseId ? { 'X-No-Enterprise-Id': '1' } : { 'X-Enterprise-Id': credential.enterpriseId }),
    ...(credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain }),
    'X-Product': 'SaaS',
    Authorization: `Bearer ${credential.accessToken}`,
  }
  return headers
}

function refreshHeaders(credential) {
  const headers = {
    ...commonHeaders(credential),
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId) headers['X-Enterprise-Id'] = credential.enterpriseId
  return headers
}

function billingHeaders(credential) {
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId) {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/** 规整发给上游的 OpenAI chat body（兜底防呆，双保险） */
export function prepareChatBody(body) {
  const obj = { ...body }
  obj.stream = true // 上游只接受流式
  if (!obj.stream_options) obj.stream_options = { include_usage: true }

  // developer 角色 → system（否则上游报 code 11128 渠道校验失败）
  if (Array.isArray(obj.messages)) {
    for (const m of obj.messages) {
      if (m && typeof m === 'object' && m.role === 'developer') m.role = 'system'
    }
  }
  // 移除嵌套 reasoning（上游忽略它并压制思考）
  delete obj.reasoning

  // tool_choice 规整为字符串形式
  if (obj.tool_choice !== undefined) {
    const choice = obj.tool_choice
    if (typeof choice === 'string') {
      if (choice.trim().toLowerCase() === 'none') {
        delete obj.tool_choice
        delete obj.tools
        delete obj.functions
      }
    } else if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
      const type = String(choice.type || '').trim().toLowerCase()
      if (type === 'none') {
        delete obj.tool_choice
        delete obj.tools
        delete obj.functions
      } else if (type === 'auto' || type === 'required') {
        obj.tool_choice = type
      } else if (type === 'function') {
        const fn = choice.function || {}
        const name = String(fn.name || choice.name || 'auto').trim() || 'auto'
        obj.tool_choice = name
      } else {
        delete obj.tool_choice
      }
    } else {
      delete obj.tool_choice
    }
  }
  return obj
}

async function readEnvelope(response) {
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { code: 0, msg: `上游返回非 JSON (http ${response.status}): ${text.slice(0, 200)}`, data: undefined }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { code: 0, msg: `上游返回意外文档 (http ${response.status})`, data: undefined }
  }
  return {
    code: typeof parsed.code === 'number' ? parsed.code : 0,
    msg: typeof parsed.msg === 'string' ? parsed.msg : '',
    data: 'data' in parsed ? parsed.data : undefined,
  }
}

function envelopeError(status, envelope) {
  return new Error(`workbuddy upstream ${classifyUpstreamError(status, envelope.msg)} (http ${status}): ${String(envelope.msg).slice(0, 200)}`)
}

export const CHAT = {
  /** POST chat 端点；成功返回原始 SSE Response */
  async chatStream(credential, bodyJson, signal) {
    let response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: chatHeaders(credential),
        body: bodyJson,
        signal,
      })
    } catch (error) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return { ok: false, status: response.status, kind: classifyUpstreamError(response.status, text), message: text }
  },

  /** POST token 刷新端点 */
  async refreshToken(credential) {
    let response
    try {
      response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
        method: 'POST',
        headers: refreshHeaders(credential),
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      })
    } catch (error) {
      throw new Error(`刷新 token 网络失败: ${String(error)}`)
    }
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
    const accessToken = typeof data.accessToken === 'string' ? data.accessToken : ''
    if (accessToken === '') throw new Error('刷新接口未返回 accessToken，请打开桌面端重新登录')
    const outcome = { accessToken }
    if (typeof data.refreshToken === 'string' && data.refreshToken !== '') outcome.refreshToken = data.refreshToken
    if (typeof data.expiresIn === 'number' && data.expiresIn > 0) outcome.expiresInSec = data.expiresIn
    if (typeof data.domain === 'string' && data.domain !== '') outcome.domain = data.domain
    return outcome
  },

  /** GET 个人模型目录，只保留 cli agent 的模型 */
  async fetchModels(credential) {
    const response = await fetch(`${chatBase(credential)}/console/enterprises/personal/models`, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: 'application/json',
        Origin: originReferer(credential),
        Referer: `${originReferer(credential)}/`,
        'User-Agent': CLIENT_UA,
      },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
    const rawModels = Array.isArray(data.models) ? data.models : []
    const agents = Array.isArray(data.agents) ? data.agents : []
    let cliIds
    for (const agent of agents) {
      if (typeof agent === 'object' && agent !== null && agent.name === 'cli' && Array.isArray(agent.models)) {
        cliIds = agent.models.filter((id) => typeof id === 'string')
        break
      }
    }
    if (!cliIds || cliIds.length === 0) throw new Error('模型目录里没有 cli agent 模型列表')

    const byId = new Map()
    for (const model of rawModels) {
      if (typeof model !== 'object' || model === null) continue
      const id = typeof model.id === 'string' ? model.id : ''
      if (id === '' || model.disabled === true) continue
      const contextWindow = typeof model.maxInputTokens === 'number' ? model.maxInputTokens : 0
      const maxTokens = typeof model.maxOutputTokens === 'number' ? model.maxOutputTokens : 0
      if (contextWindow <= 0 || maxTokens <= 0) continue
      const reasoningObj = typeof model.reasoning === 'object' && model.reasoning !== null ? model.reasoning : undefined
      const descriptionRaw =
        (typeof model.descriptionZh === 'string' && model.descriptionZh !== '' ? model.descriptionZh
          : typeof model.descriptionEn === 'string' && model.descriptionEn !== '' ? model.descriptionEn : undefined)
      const visionFlag =
        model.supportsVision === true || model.vision === true || model.multimodal === true ||
        (typeof model.modalities === 'string' && /image/i.test(model.modalities)) ||
        (Array.isArray(model.modalities) && model.modalities.some((m) => typeof m === 'string' && /image/i.test(m)))
      byId.set(id, {
        id,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : id,
        contextWindow,
        maxTokens,
        ...(typeof model.credits === 'string' && model.credits !== '' ? { credits: model.credits } : {}),
        ...(descriptionRaw ? { descriptionZh: descriptionRaw } : {}),
        ...(reasoningObj && typeof reasoningObj.effort === 'string' ? { reasoningEffort: reasoningObj.effort } : {}),
        ...(model.supportsReasoning === true ? { supportsReasoning: true } : {}),
        ...(Array.isArray(reasoningObj?.supportedEfforts)
          ? { supportedEfforts: reasoningObj.supportedEfforts.filter((v) => typeof v === 'string') } : {}),
        supportsVision: visionFlag,
      })
    }
    const models = cliIds.map((id) => byId.get(id)).filter(Boolean)
    if (models.length === 0) throw new Error('模型目录解析为空')
    return models
  },

  /** 查询剩余积分 */
  async fetchCredits(credential) {
    const now = new Date()
    const fmt = (d) =>
      `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: fmt(now),
        PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const wrapper = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
    const data = typeof wrapper.Response === 'object' && wrapper.Response !== null ? wrapper.Response : {}
    const inner = typeof data.Data === 'object' && data.Data !== null ? data.Data : {}
    const rawAccounts = Array.isArray(inner.Accounts) ? inner.Accounts : []
    const accounts = []
    let total = 0
    for (const raw of rawAccounts) {
      if (typeof raw !== 'object' || raw === null) continue
      const num = (k) => (typeof raw[k] === 'number' ? raw[k] : 0)
      const size = num('CycleCapacitySize')
      const cycleRemain = num('CycleCapacityRemain')
      const cycleUsed = num('CycleCapacityUsed')
      const capacityRemain = num('CapacityRemain')
      let remain
      if (size > 0) remain = cycleRemain
      else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain
      else remain = capacityRemain
      if (remain < 0) remain = 0
      total += remain
      accounts.push({
        packageName: typeof raw.PackageName === 'string' ? raw.PackageName : '(unnamed)',
        remain,
        size: size > 0 ? size : num('CapacitySize'),
      })
    }
    return { total, accounts }
  },
}
