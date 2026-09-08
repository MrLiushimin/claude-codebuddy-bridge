#!/usr/bin/env node
/**
 * claude-codebuddy-bridge —— Claude Code 使用 CodeBuddy/WorkBuddy 积分的本地协议桥
 *
 * 配置来源（优先级低→高）：
 *   config.json（项目根目录，可用 --config 指定）→ CLI 参数 → 环境变量
 * 日志开关、安全开关、上游参数等都在 config.json 里管理；CLI 显式传参会覆盖。
 *
 * 用法：
 *   node src/index.js                    默认监听 http://127.0.0.1:8788
 *   node src/index.js --doctor           预检（账号/积分/模型）后退出
 *   node src/index.js --port 9000 --effort off --api-key mykey
 *   node src/index.js --config my.config.json
 *
 * CLI 参数（仅列覆盖项，完整默认值见 config.json）：
 *   --port N               监听端口
 *   --host H               监听地址
 *   --config PATH          配置文件路径（默认 <项目根>/config.json）
 *   --auth-file PATH       指定桌面端 auth 文件（或用环境变量 WORKBUDDY_AUTH_FILE）
 *   --api-key KEY          要求 Claude Code 携带同样的 key（cc-switch 里填）
 *   --effort off|low|medium|high  是否向下游发送扁平 reasoning_effort
 *   --keep-reasoning-as-text       把上游思考内容(reasoning_content)并入正文输出
 *   --max-tokens N         无目录信息时钳制 max_tokens 的默认上限
 *   --log PATH             开启日志并写入 PATH（覆盖 config.json 的 log 段）
 *   --no-log               强制关闭日志（覆盖 config.json 的 log.enabled）
 *   --doctor               预检模式：打印账号/积分/模型并退出
 */

import { appendFile } from 'node:fs/promises'
import { CredentialStore, findDesktopAuthFile, desktopAuthCandidates } from './auth.js'
import { createBridgeApp } from './server.js'
import { CHAT } from './upstream.js'
import { fmtExpiry, nowIso, maskSecret } from './util.js'
import { resolveConfig } from './config.js'

const DEFAULT_PORT = 8788

/** 只记录「显式传入」的覆盖项；没传的键保持 undefined，交给配置/默认值决定 */
function parseArgs(argv) {
  const cli = {}
  const fail = (msg) => {
    console.error(`参数错误: ${msg}\n${usage()}`)
    process.exit(2)
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[i + 1]
    switch (arg) {
      case '--port': {
        const n = Number(next())
        if (!Number.isInteger(n)) fail('--port 需为整数')
        cli.port = n
        i += 1
        break
      }
      case '--host': cli.host = next(); i += 1; break
      case '--config': cli.config = next(); i += 1; break
      case '--auth-file': cli.authFile = next(); i += 1; break
      case '--api-key': cli.apiKey = next(); i += 1; break
      case '--effort': {
        cli.effort = next()
        if (!['off', 'low', 'medium', 'high'].includes(cli.effort)) {
          fail(`--effort 只接受 off/low/medium/high，收到: ${cli.effort}`)
        }
        i += 1
        break
      }
      case '--keep-reasoning-as-text': cli.keepReasoningAsText = true; break
      case '--no-desensitize': cli.desensitize = false; break
      case '--no-sanitize-identity': cli.sanitizeIdentity = false; break
      case '--max-tokens': {
        const n = Number(next())
        if (!Number.isInteger(n) || n <= 0) fail('--max-tokens 需为正整数')
        cli.maxTokensDefault = n
        i += 1
        break
      }
      case '--log': cli.logPath = next(); i += 1; break
      case '--no-log': cli.noLog = true; break
      case '--doctor': cli.doctor = true; break
      case '--help': case '-h':
        console.log(usage())
        process.exit(0)
        break
      default:
        fail(`未知参数: ${arg}`)
    }
  }
  if (cli.noLog && cli.logPath) fail('--log 与 --no-log 互斥，只能二选一')
  return cli
}

function usage() {
  return [
    'claude-codebuddy-bridge — 把 CodeBuddy/WorkBuddy 积分暴露成 Anthropic API，供 Claude Code 使用',
    '',
    '用法: node src/index.js [options]',
    '  --port N               监听端口 (默认 8788)',
    '  --host H               监听地址 (默认 127.0.0.1)',
    '  --config PATH          配置文件 (默认 <项目根>/config.json，不存在则用内置默认)',
    '  --auth-file PATH       桌面端 auth 文件 (默认取配置/自动扫描；可用环境变量 WORKBUDDY_AUTH_FILE)',
    '  --api-key KEY          要求客户端携带相同 key (cc-switch 填这个)',
    '  --effort off|low|medium|high   透传扁平 reasoning_effort (默认不设置)',
    '  --keep-reasoning-as-text       思考内容并入正文 (默认丢弃)',
    '  --no-desensitize               关闭 system 安全词脱敏 (默认开启，缓解上游 11128 误拦)',
    '  --no-sanitize-identity         关闭 system 身份指纹清洗 (默认开启，根除 11128 渠道识别)',
    '  --max-tokens N         无目录时 max_tokens 上限 (默认 16000)',
    '  --log PATH             开启请求日志到文件（覆盖配置文件 log 段）',
    '  --no-log               强制关闭日志（覆盖配置文件 log.enabled）',
    '  --doctor               预检并退出',
    '',
    '其余开关（日志/鉴权/脱敏/指纹清洗/上游 effort 等）都在 config.json 里管理，详见 README。',
  ].join('\n')
}

/** 简单文件日志 */
function makeLogger(path) {
  if (!path) return () => {}
  return (line) => {
    appendFile(path, `[${nowIso()}] ${line}\n`).catch(() => {})
  }
}

async function runDoctor(cfg) {
  const authFile = cfg.auth.file || undefined
  const store = new CredentialStore({ desktopPath: authFile })
  const out = []
  const say = (s) => out.push(s)

  say('==== 预检 ====')
  say(`平台    : ${process.platform}`)
  say(`Node    : ${process.version}`)
  const file = await findDesktopAuthFile(authFile)
  say(`auth文件: ${file || '(未找到)'}`)
  if (!file) {
    say('已扫描目录:')
    for (const d of desktopAuthCandidates()) say(`  - ${d}`)
    say('请在 CodeBuddy/WorkBuddy 桌面端完成登录后再运行。')
    console.log(out.join('\n'))
    process.exit(1)
  }

  const status = await store.status()
  if (status.state !== 'signed-in') {
    say('状态    : 未登录')
    console.log(out.join('\n'))
    process.exit(1)
  }
  say(`账号    : ${status.nickname || '(无昵称)'}${status.domain ? ` @ ${status.domain}` : ''}`)
  say(`token过期: ${fmtExpiry(status.expiresAtMs)} (${status.source})`)

  try {
    const credential = await store.resolve()
    const credits = await CHAT.fetchCredits(credential).catch((e) => ({ error: e.message }))
    if (credits.error) say(`积分    : 查询失败 (${credits.error})`)
    else {
      say(`积分    : 剩余 ${credits.total}`)
      for (const a of credits.accounts) say(`         - ${a.packageName}: ${a.remain}/${a.size}`)
    }
    const models = await CHAT.fetchModels(credential).catch((e) => ({ error: e.message }))
    if (models.error) say(`模型    : 拉取失败 (${models.error})`)
    else {
      say(`模型(${models.length}):`)
      for (const m of models) {
        say(`         - ${m.id}${m.credits ? ` (${m.credits})` : ''}${m.reasoningEffort ? ` [effort ${m.reasoningEffort}]` : ''}`)
      }
    }
  } catch (error) {
    say(`凭据异常: ${error.message}`)
  }
  say('================')
  console.log(out.join('\n'))
  process.exit(0)
}

async function main() {
  const cli = parseArgs(process.argv.slice(2))

  let cfg
  let configSource
  try {
    ;({ cfg, source: configSource } = await resolveConfig(cli))
  } catch (error) {
    console.error(`配置错误: ${error.message}`)
    process.exit(1)
  }
  if (cli.doctor) return runDoctor(cfg)

  const authFile = cfg.auth.file || undefined
  const store = new CredentialStore({ desktopPath: authFile })
  const logEnabled = cfg.log.enabled && Boolean(cfg.log.path)
  const log = logEnabled ? makeLogger(cfg.log.path) : () => {}

  const app = createBridgeApp({
    store,
    effort: cfg.upstream.effort || undefined,
    keepReasoningAsText: Boolean(cfg.upstream.keepReasoningAsText),
    maxTokensDefault: cfg.upstream.maxTokensDefault,
    apiKey: cfg.security.apiKey || '',
    desensitize: cfg.security.desensitize !== false,
    sanitizeIdentity: cfg.security.sanitizeIdentity !== false,
    log,
  })

  // 启动预检（失败仅提示，不阻塞启动——登录态可能稍后才就绪）
  try {
    const file = await findDesktopAuthFile(authFile)
    console.log(`auth 文件: ${file || '(未找到，请确认桌面端已登录)'}`)
    const status = await store.status()
    if (status.state === 'signed-in') {
      console.log(`账号: ${status.nickname || '?'}${status.domain ? ` @ ${status.domain}` : ''} | token 过期: ${fmtExpiry(status.expiresAtMs)}`)
    } else {
      console.log('账号: 未登录 —— 启动后所有 /v1/messages 将返回 503')
    }
  } catch (error) {
    console.log(`预检异常: ${error.message}`)
  }

  app.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${cfg.server.port} 已被占用，换一个端口试试（--port N 或改 config.json 的 server.port），或先关掉旧实例。`)
      process.exit(1)
    }
    throw error
  })

  app.listen(cfg.server.port, cfg.server.host, () => {
    const effortText = cfg.upstream.effort ? ` | reasoning_effort=${cfg.upstream.effort}` : ' | effort 未设置(用后端默认)'
    console.log('')
    console.log(`✅ claude-codebuddy-bridge 已启动`)
    console.log(`   配置   : ${configSource || '(内置默认，未找到 config.json)'}`)
    console.log(`   监听   : http://${cfg.server.host}:${cfg.server.port}`)
    console.log(`   协议   : Anthropic /v1/messages（Claude Code 原生协议）`)
    console.log(`   上游   : CodeBuddy/WorkBuddy (copilot.tencent.com) 积分${effortText}`)
    if (cfg.security.desensitize) console.log('   脱敏   : 开启（system 安全合规词插零宽空格，缓解上游 11128 误拦；config.json 关闭）')
    if (cfg.security.sanitizeIdentity) console.log('   指纹清洗: 开启（system 身份指纹改写，根除 11128 渠道识别；config.json 关闭）')
    console.log(`   模型   : GET /v1/models 查看可用列表`)
    console.log(`   状态   : GET /health`)
    if (cfg.security.apiKey) console.log(`   鉴权   : 已启用（API key 已设置）`)
    console.log(`   日志   : ${logEnabled ? cfg.log.path : '关闭（config.json 的 log.enabled）'}`)
    console.log('')
    console.log('Claude Code / cc-switch 配置:')
    console.log(`   Base URL : http://${cfg.server.host}:${cfg.server.port}`)
    console.log(`   API Key  : ${cfg.security.apiKey ? maskSecret(cfg.security.apiKey) : '(留空)'}`)
    console.log(`   模型     : 见 /v1/models（如 deepseek-v4-flash / glm-5.2）`)
    console.log('')
  })
}

main().catch((error) => {
  console.error(`启动失败: ${error.stack || error.message}`)
  process.exit(1)
})
