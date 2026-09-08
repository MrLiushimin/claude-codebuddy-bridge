/**
 * 端到端测试：模拟 Claude Code 调用本地桥（Anthropic /v1/messages）。
 * 覆盖：health / models / 非流式 / 流式 / 工具调用两轮回传。
 * 用法：node scripts/e2e.mjs [baseUrl]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8789'
const MODEL = process.env.E2E_MODEL || 'deepseek-v4-flash'

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 300) } }
  return { status: res.status, json }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 等服务就绪
  for (let i = 0; i < 20; i += 1) {
    try { await fetch(`${BASE}/health`); break } catch { await sleep(300) }
  }

  // 1. health
  const health = await (await fetch(`${BASE}/health`)).json()
  check('health 状态 ok', health.status === 'ok', JSON.stringify(health.credential))
  check('凭据已登录', health.credential?.state === 'signed-in', `nickname=${health.credential?.nickname}`)
  check('积分可查', typeof health.credits?.total === 'number', `total=${health.credits?.total}`)
  check('模型来自上游目录', health.models?.source === 'upstream', `count=${health.models?.count}`)

  // 2. models
  const models = await (await fetch(`${BASE}/v1/models`)).json()
  check('models 是 Anthropic 格式', Array.isArray(models.data) && models.data[0]?.type === 'model',
    `${models.data?.length} 个`)

  // 3. 非流式纯文本
  const plain = await post('/v1/messages', {
    model: MODEL, max_tokens: 200, stream: false,
    messages: [{ role: 'user', content: '用一句话回答：1+1等于几？' }],
  })
  const plainText = plain.json?.content?.map((c) => c.text || '').join('')
  check('非流式 200 且是 message', plain.status === 200 && plain.json?.type === 'message', plain.status === 200 ? `stop=${plain.json?.stop_reason}` : `status=${plain.status}`)
  check('非流式有文本正文', Boolean(plainText), plainText?.slice(0, 60))

  // 4. 流式
  const streamRes = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 200, stream: true,
      messages: [{ role: 'user', content: '用一句话回答：2+2等于几？' }],
    }),
  })
  let sawStart = false, sawStop = false, sawTextDelta = false, sawMessageDelta = false
  const reader = streamRes.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine) continue
      try {
        const evt = JSON.parse(dataLine.slice(5))
        if (evt.type === 'message_start') sawStart = true
        if (evt.type === 'message_stop') sawStop = true
        if (evt.type === 'message_delta') sawMessageDelta = true
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') sawTextDelta = true
      } catch { /* ignore */ }
    }
  }
  check('流式: message_start', sawStart)
  check('流式: text_delta', sawTextDelta)
  check('流式: message_delta + message_stop', sawMessageDelta && sawStop)

  // 5. 工具调用往返（两轮）
  const weatherTool = [{
    name: 'get_weather',
    description: '查询指定城市的天气',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名' } },
      required: ['city'],
    },
  }]
  const turn1 = await post('/v1/messages', {
    model: MODEL, max_tokens: 400, stream: false,
    tools: weatherTool,
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: '请必须调用 get_weather 工具查询深圳的天气，拿到结果后再用一句话总结。不要跳过工具。' }],
  })
  const toolUses = turn1.json?.content?.filter((c) => c.type === 'tool_use') || []
  const text1 = (turn1.json?.content || []).map((c) => c.text || '').join('')
  check('工具轮1: 返回 tool_use', toolUses.length >= 1,
    toolUses.length ? `tool=${toolUses[0].name} id=${(toolUses[0].id || '').slice(0, 20)}` : `text=${text1.slice(0, 80)}`)

  if (toolUses.length) {
    const tu = toolUses[0]
    const turn2 = await post('/v1/messages', {
      model: MODEL, max_tokens: 200, stream: false,
      tools: weatherTool,
      messages: [
        { role: 'user', content: '请必须调用 get_weather 工具查询深圳的天气，拿到结果后再用一句话总结。不要跳过工具。' },
        { role: 'assistant', content: [{ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: '{"city":"深圳","weather":"晴 28℃","humidity":60}' }] },
      ],
    })
    const finalText = (turn2.json?.content || []).map((c) => c.text || '').join('')
    check('工具轮2: 拿到结果后正常收尾', turn2.status === 200 && finalText.trim().length > 0,
      turn2.status === 200 ? finalText.slice(0, 80) : `status=${turn2.status}`)
  }

  console.log(failures === 0 ? '\n🎉 全部通过' : `\n💥 ${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error('e2e error:', e); process.exit(1) })
