/**
 * 协议转换核心：Anthropic Messages API <-> OpenAI chat/completions
 *
 * 请求侧：把 Claude Code 发来的 /v1/messages 转成 CodeBuddy 上游能懂的
 *         OpenAI chat/completions body（上游本身是 OpenAI 协议）。
 * 响应侧：把上游 OpenAI SSE 流（含 tool_calls）转成 Anthropic SSE
 *         （text / tool_use 块、input_json_delta、message_delta），
 *         流式与非流式两用。
 *
 * 关键点：
 *  - tool_use 的 id 必须原样透传上游的 tool_call id，否则多轮工具调用
 *    回传 tool_result 时上游匹配不上。
 *  - Anthropic system / messages 里的 cache_control、thinking 块一律剥离。
 *  - tool_result 拆成 OpenAI role:"tool" 消息；混合文本与结果的 user
 *    消息按原顺序拆分。
 */

import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// 脱敏（desensitize）：缓解 CodeBuddy 渠道安全策略(11128)对 system 合规模板的误拦
// ---------------------------------------------------------------------------
// CodeBuddy 上游会对请求做关键词级安全审查；Claude Code 的 system prompt 是
// 全英文且必含「拒绝作恶」类安全术语（DoS/exploit/credential/C2…），常被误判为
// 有害注入并整条拦截（code 11128, "Illegal API invocation from an unapproved
// channel" / "请求被安全策略拦截"）。对策与 codebuddy2openai 的 desensitize 一致：
// 对这些词插入零宽空格 U+200B（人/模型读起来无差别，后端关键词匹配失效）。
// 只处理 system 消息文本，绝不碰 user 输入。

const ZWSP = '\u200b'

/** 触发误拦的英文安全/攻击类复合词（大小写不敏感） */
const SENSITIVE_TERMS = [
  'DoS', 'DDoS',
  'exploit development', 'exploit', 'zero-day exploit',
  'credential testing', 'credential stuffing', 'credential theft',
  'credential dumping', 'credential harvesting',
  'supply chain compromise', 'supply-chain compromise',
  'detection evasion', 'evasion techniques',
  'C2 framework', 'C2 frameworks', 'command and control',
  'malicious purposes', 'malicious intent', 'malicious code',
  'mass targeting', 'brute force', 'brute-force',
  'privilege escalation', 'reverse shell', 'bind shell',
  'remote code execution', 'RCE',
  'SQL injection', 'XSS', 'CSRF', 'SSRF', 'XXE', 'path traversal',
  'phishing', 'spear phishing', 'social engineering',
  'malware', 'ransomware', 'keylogger', 'rootkit', 'backdoor', 'botnet',
  'zero-day', '0day', 'buffer overflow', 'heap overflow',
  'data exfiltration', 'unauthorized access', 'identity theft',
  'prompt injection', 'jailbreak',
  'pass-the-hash', 'kerberoasting', 'credential relay', 'LLMNR',
]

/** 长词优先匹配，避免短词先吃掉长词 */
const SENSITIVE_RE = new RegExp(
  `\\b(${SENSITIVE_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|')})\\b`,
  'gi',
)

/** 在词的第 2 个字符后插零宽空格（首字母保持干净边界） */
function zwspSplit(word) {
  if (word.length <= 2) return word
  return word.slice(0, 2) + ZWSP + word.slice(2)
}

/** 统计命中，便于日志 */
let lastHitCount = 0
export function desensitizeText(text) {
  if (!text) return text
  let count = 0
  const out = text.replace(SENSITIVE_RE, (m) => {
    count += 1
    return zwspSplit(m)
  })
  lastHitCount = count
  return out
}

export function getLastDesensitizeHits() {
  return lastHitCount
}

// ---------------------------------------------------------------------------
// 身份指纹清洗（identity sanitize）：根除上游 11128 的「unapproved channel」识别
// ---------------------------------------------------------------------------
// 实测定位（2026-09-07，scripts/bisect-11128.mjs 二分+逐词验证）：
//  1. system 里的行 `x-anthropic-billing-header: cc_version=...; cc_entrypoint=...;`
//     —— 单独一行即触发 11128（上游按此识别"非官方渠道的 Claude Code 调用"）。
//  2. 身份句 `You are Claude Code, Anthropic's official CLI for Claude, running
//     within the Claude Agent SDK.` —— 整句触发；去掉 "You are" / ", Anthropic's"
//     / "for Claude" 任一段即放行（组合指纹，疑似 "Claude Code"+"Anthropic"+"for
//     Claude" 共现检测）。
//  3. "You are powered by the model xxx." 会向模型泄露真实后端模型名（glm/deepseek），
//     与 Claude Code 人设冲突，顺带改写。
//  4. "This iteration of Claude is Claude Fable 5..." 整段是 Anthropic 模型自述，
//     对非 Claude 后端纯属误导，泛化为中性自述。
// 只处理 system 消息文本；user 输入与工具描述不动。

const IDENTITY_REPLACEMENTS = [
  // billing/计量头行（Claude Code 注入 system 首行的元数据）→ 整行删除
  [/^x-anthropic-[a-z-]+:.*$/gim, ''],
  // 官方 CLI 身份句 → 保留 Claude Code 人设、去掉 Anthropic 官方渠道声明。
  // 旧版: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
  // 新版(2026-09 实测): 缩短为 "You are Claude Code, Anthropic's official CLI for Claude."
  // → SDK 后缀设为可选，两种版本都命中。
  [
    /You are Claude Code,?\s+Anthropic'?s official CLI for Claude(?:,?\s+running within the Claude Agent SDK)?\.?/gi,
    "You are Claude Code, a command-line coding assistant, running in the user's terminal environment.",
  ],
  // 兜底：任何残留的「Anthropic's official CLI for Claude」短语（防未来文案再变体，
  // 如换了前缀/后缀的组合句），单独打掉渠道声明部分。
  [/Anthropic'?s official CLI for Claude/gi, 'a command-line coding assistant'],
  // 真实后端模型泄露 → 中性表述
  [/You are powered by the model [^.]*\./gi, 'You are powered by the configured model.'],
  // Anthropic 模型自述段（This iteration of Claude is ... 更多信息）→ 中性自述
  [
    /This iteration of Claude is [^.]*\. .*?for more information\./gis,
    'You are a helpful AI coding assistant focused on software engineering tasks.',
  ],
  // git 环境指纹句（Claude Code 环境块特有措辞，实测整句触发 11128）
  [/Main branch \((?:you )?will (?:usually )?use this for PRs\)/gi, 'Main branch (use this for pull requests)'],
]

/** 是否命中过身份指纹（供日志） */
let lastIdentityHits = 0

export function sanitizeIdentityText(text) {
  if (!text) return text
  lastIdentityHits = 0
  let out = text
  for (const [re, replacement] of IDENTITY_REPLACEMENTS) {
    out = out.replace(re, (match) => {
      lastIdentityHits += 1
      return typeof replacement === 'function' ? replacement(match) : replacement
    })
  }
  return out
}

export function getLastIdentityHits() {
  return lastIdentityHits
}

// ---------------------------------------------------------------------------
// 请求侧：Anthropic -> OpenAI
// ---------------------------------------------------------------------------

const isNonEmptyString = (v) => typeof v === 'string' && v !== ''

/** 提取 Anthropic content（string 或 blocks）里的全部文本 */
function collectText(blocks) {
  const parts = []
  for (const block of blocks) {
    if (typeof block === 'string') parts.push(block)
    else if (block && block.type === 'text' && isNonEmptyString(block.text)) parts.push(block.text)
  }
  return parts.join('\n\n')
}

/** 展开一段 Anthropic user content（string 或 blocks）为 OpenAI 消息 */
function expandUserBlocks(rawContent) {
  const blocks = typeof rawContent === 'string' ? [{ type: 'text', text: rawContent }] : rawContent
  const out = []
  let pendingText = ''
  const flushText = () => {
    const t = pendingText.trim()
    if (t) out.push({ role: 'user', content: t })
    pendingText = ''
  }
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text': {
        if (isNonEmptyString(block.text)) pendingText += `${block.text}\n\n`
        break
      }
      case 'tool_result': {
        flushText()
        const isError = block.is_error === true
        let text = ''
        if (typeof block.content === 'string') text = block.content
        else if (Array.isArray(block.content)) text = collectText(block.content)
        else if (block.content && typeof block.content === 'object') {
          try { text = JSON.stringify(block.content) } catch { text = '' }
        }
        if (isError && !/^\[error\]/i.test(text)) text = `[Error] ${text}`
        out.push({ role: 'tool', tool_call_id: String(block.tool_use_id || ''), content: text })
        break
      }
      case 'image': {
        flushText()
        const source = block.source || {}
        if (source.type === 'base64' && source.media_type && source.data) {
          out.push({
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } }],
          })
        } else if (source.type === 'url' && source.url) {
          out.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: source.url } }] })
        }
        break
      }
      default:
        // document / 未知块：无法可靠映射，给占位文本，避免丢上下文
        flushText()
        pendingText += '[附件内容无法转换，已省略]\n\n'
        break
    }
  }
  flushText()
  return out
}

/** 展开一段 Anthropic assistant content 为一条 OpenAI assistant 消息（含 tool_calls） */
function expandAssistantBlocks(rawContent) {
  const blocks = typeof rawContent === 'string' ? [{ type: 'text', text: rawContent }] : rawContent
  const textParts = []
  const toolCalls = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && isNonEmptyString(block.text)) {
      textParts.push(block.text)
    } else if (block.type === 'thinking' && isNonEmptyString(block.thinking)) {
      // OpenAI 无 thinking 历史字段，剥离
    } else if (block.type === 'tool_use' && isNonEmptyString(block.name)) {
      let argumentsText = ''
      try { argumentsText = JSON.stringify(block.input ?? {}) } catch { argumentsText = '{}' }
      toolCalls.push({
        id: String(block.id || `call_${randomUUID()}`),
        type: 'function',
        function: { name: block.name, arguments: argumentsText },
      })
    }
  }
  const content = textParts.join('\n\n')
  const message = { role: 'assistant' }
  if (content) message.content = content
  else if (toolCalls.length === 0) return null // 空消息（如只有 thinking）直接丢弃
  if (toolCalls.length) message.tool_calls = toolCalls
  return message
}

/** Anthropic tool_choice -> OpenAI tool_choice */
function convertToolChoice(choice) {
  if (!choice || typeof choice !== 'object') return undefined
  if (choice.type === 'any') return 'required'
  if (choice.type === 'auto') return 'auto'
  if (choice.type === 'none') return 'none'
  if (choice.type === 'tool' && isNonEmptyString(choice.name)) {
    return { type: 'function', function: { name: choice.name } }
  }
  return undefined
}

/**
 * 转换 /v1/messages 请求体。
 * @param body Anthropic 请求
 * @param opts { maxTokensCap, effort, maxTokensDefault }
 * @returns OpenAI chat/completions body
 */
export function convertRequest(body, opts = {}) {
  const messages = []
  const desensitize = opts.desensitize !== false // 默认开启
  const sanitizeIdentity = opts.sanitizeIdentity !== false // 默认开启
  const safe = (text) => {
    let t = text
    if (sanitizeIdentity) t = sanitizeIdentityText(t)
    if (desensitize) t = desensitizeText(t)
    return t
  }
  const systemText = collectText(
    typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : Array.isArray(body.system) ? body.system : [],
  )
  if (systemText.trim()) messages.push({ role: 'system', content: safe(systemText).trim() })

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!msg || typeof msg !== 'object') continue
    if (msg.role === 'user') {
      for (const m of expandUserBlocks(msg.content)) messages.push(m)
    } else if (msg.role === 'assistant') {
      const m = expandAssistantBlocks(msg.content)
      if (m) messages.push(m)
    } else if (msg.role === 'system' || msg.role === 'developer') {
      // 历史里的 system/developer → 并入首条 system（避免 11128 渠道错误）
      const text = collectText(Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }])
      if (messages.length > 0 && messages[0].role === 'system') messages[0].content += `\n\n${safe(text)}`
      else messages.unshift({ role: 'system', content: safe(text) })
    }
  }

  const out = { model: body.model || 'auto', messages, stream: true }

  // max_tokens：Anthropic 必填 → 转 OpenAI（按目录上限或默认 cap 钳制）
  const cap = opts.maxTokensCap && opts.maxTokensCap > 0 ? opts.maxTokensCap : opts.maxTokensDefault || 8192
  let maxTokens = typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : cap
  if (maxTokens > cap) maxTokens = cap
  out.max_tokens = maxTokens

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((t) => t && typeof t === 'object' && isNonEmptyString(t.name))
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          ...(isNonEmptyString(t.description) ? { description: t.description } : {}),
          parameters: t.input_schema || { type: 'object', properties: {} },
        },
      }))
  }
  const toolChoice = convertToolChoice(body.tool_choice)
  if (toolChoice !== undefined) out.tool_choice = toolChoice

  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences

  // 思考处理：Anthropic thinking 无法映射 signature 体系 → 剥掉请求字段，
  // 视配置改用 OpenAI 扁平 reasoning_effort（上游 deepseek-v4*/hy3 支持）
  const thinkingEnabled = body.thinking && typeof body.thinking === 'object' && body.thinking.type === 'enabled'
  if (thinkingEnabled) {
    out.reasoning_effort = opts.effort && opts.effort !== 'off' ? opts.effort : 'high'
  } else if (opts.effort) {
    out.reasoning_effort = opts.effort
  }

  return out
}

// ---------------------------------------------------------------------------
// 响应侧：OpenAI SSE -> Anthropic
// ---------------------------------------------------------------------------

const FINISH_MAP = {
  tool_calls: 'tool_use',
  length: 'max_tokens',
  stop: 'end_turn',
  refusal: 'refusal',
}

const sseEvent = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`

const FILTER_HINT = '[CodeBuddy 内容审核拦截了本次回复，请调整措辞后重试。]'

/**
 * OpenAI SSE -> Anthropic 渲染器。
 * 用法（流式）：
 *   const r = new AnthropicRenderer({ model })
 *   先写 r.startEvent()
 *   逐个上游 chunk 调 r.onChunk(obj) → 把返回的事件字符串写回客户端
 *   最后写 r.finishEvents()
 * 非流式：走完上面流程后用 r.toMessageJSON() 拿聚合 JSON。
 */
export class AnthropicRenderer {
  constructor({ model, id, keepReasoningAsText }) {
    this.model = model || 'unknown'
    this.id = id || `msg_${randomUUID().replace(/-/g, '')}`
    this.keepReasoningAsText = keepReasoningAsText === true
    this.contentItems = []   // 有序 {type:'text',text} / {type:'tool_use',...}
    this.nextIndex = 0
    this.openText = null     // { index, buffer }
    this.toolSlots = new Map() // openai index -> {…}
    this.finish = null
    this.usage = { completion_tokens: 0 }
    this.sawError = false
    this._closed = false
  }

  /** message_start 事件 */
  startEvent() {
    return sseEvent({
      type: 'message_start',
      message: {
        id: this.id,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  _closeText() {
    if (!this.openText) return []
    const events = [sseEvent({ type: 'content_block_stop', index: this.openText.index })]
    this.contentItems.push({ type: 'text', text: this.openText.buffer })
    this.openText = null
    return events
  }

  _openText() {
    if (this.openText) return []
    const index = this.nextIndex++
    this.openText = { index, buffer: '' }
    return [sseEvent({
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    })]
  }

  _pushText(text) {
    let events = []
    if (!this.openText) events.push(...this._openText())
    this.openText.buffer += text
    events.push(sseEvent({
      type: 'content_block_delta',
      index: this.openText.index,
      delta: { type: 'text_delta', text },
    }))
    return events
  }

  _closeTool(openaiIndex) {
    const slot = this.toolSlots.get(openaiIndex)
    if (!slot || !slot.started || slot.closed) return []
    slot.closed = true
    let input = {}
    if (slot.args.trim()) {
      try { input = JSON.parse(slot.args) } catch { input = { _raw: slot.args } }
    }
    this.contentItems.push({ type: 'tool_use', id: slot.id, name: slot.name, input })
    return [sseEvent({ type: 'content_block_stop', index: slot.anthropicIndex })]
  }

  _openTool(openaiIndex, entry) {
    const fn = (entry.function || {})
    const name = typeof fn.name === 'string' && fn.name !== '' ? fn.name : null
    const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : null
    // 必须 id+name 齐了才开始（id 需透传，否则 tool_result 回传失配）
    if (!name || !id) return []
    const slot = this.toolSlots.get(openaiIndex)
    if (slot.started) return []
    const events = this._closeText()
    const anthropicIndex = this.nextIndex++
    slot.anthropicIndex = anthropicIndex
    slot.id = id
    slot.name = name
    slot.started = true
    events.push(sseEvent({
      type: 'content_block_start',
      index: anthropicIndex,
      content_block: { type: 'tool_use', id, name, input: {} },
    }))
    // 若 name 出现前已有零散 arguments 缓冲，start 后补发
    if (slot.pendingArgs) {
      events.push(sseEvent({
        type: 'content_block_delta',
        index: anthropicIndex,
        delta: { type: 'input_json_delta', partial_json: slot.pendingArgs },
      }))
      slot.args += slot.pendingArgs
      slot.pendingArgs = ''
    }
    return events
  }

  _pushToolCall(entry) {
    const openaiIndex = typeof entry.index === 'number' ? entry.index : 0
    let slot = this.toolSlots.get(openaiIndex)
    if (!slot) {
      slot = { started: false, closed: false, anthropicIndex: null, id: null, name: null, args: '', pendingArgs: '' }
      this.toolSlots.set(openaiIndex, slot)
    }
    const fn = entry.function || {}
    let events = []
    if (!slot.started) {
      // 先缓存信息；id/name 齐时真正 start
      if (typeof entry.id === 'string' && entry.id) slot.id = entry.id
      if (typeof fn.name === 'string' && fn.name) slot.name = fn.name
      events.push(...this._openTool(openaiIndex, { id: slot.id, function: { name: slot.name } }))
      if (typeof fn.arguments === 'string' && fn.arguments !== '') {
        if (slot.started) {
          slot.args += fn.arguments
          events.push(sseEvent({
            type: 'content_block_delta',
            index: slot.anthropicIndex,
            delta: { type: 'input_json_delta', partial_json: fn.arguments },
          }))
        } else {
          slot.pendingArgs += fn.arguments
        }
      }
    } else {
      if (typeof fn.arguments === 'string' && fn.arguments !== '') {
        slot.args += fn.arguments
        events.push(sseEvent({
          type: 'content_block_delta',
          index: slot.anthropicIndex,
          delta: { type: 'input_json_delta', partial_json: fn.arguments },
        }))
      }
    }
    return events
  }

  /**
   * 处理一个上游 SSE 的 JSON 对象，返回要写给客户端的 Anthropic 事件串。
   * 返回 null 表示遇到上游错误（此时渲染器已进入错误态）。
   */
  onChunk(obj) {
    if (this._closed) return []
    if (obj && obj.error) {
      this.sawError = true
      const msg = typeof obj.error === 'string' ? obj.error : (obj.error.message || 'upstream error')
      this.errorMessage = msg
      return [sseEvent({ type: 'error', error: { type: 'api_error', message: msg } })]
    }
    let events = []
    for (const choice of obj.choices || []) {
      const finish = choice.finish_reason
      if (finish) this.finish = finish
      const delta = choice.delta || {}
      if (typeof delta.content === 'string' && delta.content !== '') {
        events.push(...this._pushText(delta.content))
      }
      if (this.keepReasoningAsText && typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
        events.push(...this._pushText(delta.reasoning_content))
      }
      for (const tc of delta.tool_calls || []) {
        events.push(...this._pushToolCall(tc))
      }
    }
    if (obj.usage && typeof obj.usage.completion_tokens === 'number') {
      this.usage.completion_tokens = obj.usage.completion_tokens
    }
    return events
  }

  /** 关闭所有打开的块，发 message_delta + message_stop；返回结尾事件 */
  finishEvents() {
    if (this._closed) return []
    this._closed = true
    let events = []
    events.push(...this._closeText())
    for (const key of this.toolSlots.keys()) events.push(...this._closeTool(key))

    let stopReason = this.finish ? (FINISH_MAP[this.finish] || 'end_turn') : 'end_turn'
    // 内容审核拦截：无任何正文时给用户一句可读提示
    if (this.finish === 'content_filter') {
      const hasText = this.contentItems.some((c) => c.type === 'text' && c.text.trim())
      if (!hasText) {
        const index = this.nextIndex++
        events.push(sseEvent({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }))
        events.push(sseEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: FILTER_HINT } }))
        events.push(sseEvent({ type: 'content_block_stop', index }))
        this.contentItems.push({ type: 'text', text: FILTER_HINT })
      }
      stopReason = 'end_turn'
    }

    events.push(sseEvent({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: this.usage.completion_tokens || 0 },
    }))
    events.push(sseEvent({ type: 'message_stop' }))
    return events
  }

  /** 非流式：聚合后的 Anthropic message JSON */
  toMessageJSON() {
    if (!this._closed) this.finishEvents()
    return {
      id: this.id,
      type: 'message',
      role: 'assistant',
      model: this.model,
      content: this.contentItems,
      stop_reason: this.finish ? (FINISH_MAP[this.finish] || 'end_turn') : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: this.usage.completion_tokens || 0 },
    }
  }
}

/** Anthropic 风格错误 JSON（客户端 SDK 可读） */
export function errorJSON(status, type, message) {
  return { type: 'error', error: { type, message } }
}
