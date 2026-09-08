/**
 * 11128 渠道拦截二分定位脚本（只读诊断，直连上游，不经桥）
 *
 * 用 bridge.log 里 dump 出的真实 Claude Code system 全文，逐块发给上游，
 * 找出触发 11128 的最小块。失败请求上游不扣积分，成功请求用小 max_tokens 省积分。
 *
 * 用法：node scripts/bisect-11128.mjs <system-dump.txt> [--model deepseek-v4-flash]
 * dump 文件格式：bridge.log 中「── SYSTEM ──」之后的原始行（可带时间戳前缀，自动剥）。
 */

import { CredentialStore } from '../src/auth.js'
import { CHAT, prepareChatBody } from '../src/upstream.js'

const args = process.argv.slice(2)
const dumpFile = args.find((a) => !a.startsWith('--'))
const modelArgIdx = args.indexOf('--model')
const MODEL = modelArgIdx !== -1 ? args[modelArgIdx + 1] : 'deepseek-v4-flash'

if (!dumpFile) {
  console.error('用法: node scripts/bisect-11128.mjs <system-dump.txt> [--model deepseek-v4-flash]')
  process.exit(2)
}

const { readFile } = await import('node:fs/promises')
const raw = await readFile(dumpFile, 'utf8')
// 剥掉日志行前缀 `[2026-09-07 10:32:20] req_xxx `，再去掉首行的「── SYSTEM ──」标记
const lines = raw
  .split('\n')
  .map((l) => l.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] req_[a-f0-9]+ ?/, ''))
  .filter((l) => l.trim() !== '── SYSTEM ──')
const FULL = lines.join('\n').trim()

console.log(`dump 行数=${lines.length} 字符=${FULL.length} 模型=${MODEL}`)
console.log('='.repeat(72))

// --- 上游测试封装 -----------------------------------------------------------
const store = new CredentialStore({})
const credential = await store.resolve()
console.log('凭据 OK\n')

let testCount = 0
async function probe(name, systemText, extra = {}) {
  testCount += 1
  const body = {
    model: MODEL,
    messages: [],
    max_tokens: 20,
    stream: true,
  }
  if (systemText !== null && systemText.trim()) body.messages.push({ role: 'system', content: systemText })
  body.messages.push({ role: 'user', content: '回答 ok 一个字即可' })
  Object.assign(body, extra)
  const payload = JSON.stringify(prepareChatBody(body))
  try {
    const upstream = await CHAT.chatStream(credential, payload)
    if (upstream.ok) {
      // 读一点点流就断开，省积分
      const reader = upstream.response.body.getReader()
      await reader.read().catch(() => {})
      await reader.cancel().catch(() => {})
      console.log(`✅ PASS  ${name}`)
      return true
    }
    const m = /"code":(\d+)/.exec(upstream.message)
    const code = m ? m[1] : `http${upstream.status}`
    console.log(`❌ ${code}  ${name}`)
    return false
  } catch (e) {
    console.log(`⚠️ ERR   ${name} — ${e.message}`)
    return false
  }
}

// --- 从 dump 切出可疑块 ------------------------------------------------------
function findBlock(startMarker, endMarker) {
  const s = FULL.indexOf(startMarker)
  if (s === -1) return null
  const e = endMarker ? FULL.indexOf(endMarker, s) : FULL.length
  return e === -1 ? FULL.slice(s) : FULL.slice(s, e).trim()
}

const BILLING_LINE = lines[0] && lines[0].startsWith('x-anthropic-billing-header') ? lines[0].trim() : null
const IDENTITY_LINE = findBlock('You are Claude Code', 'You are an interactive')
const FABLE_PARA = findBlock("This iteration of Claude is Claude Fable", '\n\n')
const SECURITY_PARA = findBlock('IMPORTANT: Assist with authorized security testing', '\n\n')

// --- 测试序列 ----------------------------------------------------------------
console.log('--- 阶段1: 基线与整体验证 ---')
await probe('基线: 无 system', null)
const fullOk = await probe('完整真实 system (应复现 11128)', FULL)

if (fullOk) {
  console.log('\n⚠️ 完整 system 单独发居然通过了 —— 触发点可能在 tools / messages / 组合。')
} else {
  console.log('\n--- 阶段2: 逐块单独测（找出单独就能触发的块）---')
  if (BILLING_LINE) await probe('仅 billing header 行', BILLING_LINE)
  if (IDENTITY_LINE) await probe('仅 "You are Claude Code" 段', IDENTITY_LINE)
  if (FABLE_PARA) await probe('仅 Claude Fable 身份段', FABLE_PARA)
  if (SECURITY_PARA) await probe('仅安全合规 IMPORTANT 段', SECURITY_PARA)

  console.log('\n--- 阶段3: 减法测试（去掉某块后是否放行）---')
  if (BILLING_LINE) {
    const minus = FULL.replace(BILLING_LINE, '').replace(/^\s*\n/, '')
    await probe('完整 system 去掉 billing header 行', minus)
  }
  if (FABLE_PARA) {
    const minus = FULL.replace(FABLE_PARA, '')
    await probe('完整 system 去掉 Fable 身份段', minus)
  }
  if (IDENTITY_LINE) {
    const minus = FULL.replace(IDENTITY_LINE, '')
    await probe('完整 system 去掉 Claude Code 身份段', minus)
  }
  if (SECURITY_PARA) {
    const minus = FULL.replace(SECURITY_PARA, '')
    await probe('完整 system 去掉安全合规段', minus)
  }

  console.log('\n--- 阶段4: 二分定位（若减法测试没放行）---')
  // 若上面减法没有一个 PASS，就对全文按行二分
  async function bisect(text, depth) {
    if (depth > 6 || text.length < 200) {
      console.log(`   ⏸ 到达叶节点 (${text.length} chars)，手动检查:\n---\n${text.slice(0, 800)}\n---`)
      return
    }
    const mid = Math.floor(text.length / 2)
    // 在 mid 附近找换行，避免切断行
    let cut = text.indexOf('\n', mid)
    if (cut === -1 || cut > mid + 500) cut = mid
    const first = text.slice(0, cut).trim()
    const second = text.slice(cut).trim()
    console.log(`   二分 depth=${depth}: 前半 ${first.length} chars / 后半 ${second.length} chars`)
    const firstOk = await probe(`  前半(${first.length}c)`, first)
    if (!firstOk) return bisect(first, depth + 1)
    const secondOk = await probe(`  后半(${second.length}c)`, second)
    if (!secondOk) return bisect(second, depth + 1)
    console.log('   两半都过——触发可能是组合效应或长度阈值')
    // 长度阈值验证
    await probe(`  全文重复两倍(长度测试 ${text.length * 2}c)`, text + '\n\n' + text)
  }
  // 只在阶段3全 FAIL 时跑二分
  const stage3AllFail = true // 简化：阶段3的 PASS 会打印出来，人工判断也行
  if (process.env.BISECT === '1') await bisect(FULL, 0)
}

console.log('\n' + '='.repeat(72))
console.log(`共 ${testCount} 次请求。BISECT=1 环境变量可开启全文二分。`)
