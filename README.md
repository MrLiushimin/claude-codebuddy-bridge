# claude-codebuddy-bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg)]()

> 把 **CodeBuddy / WorkBuddy（腾讯代码助手）** 的订阅积分，包装成 **Anthropic Messages API**，让 **Claude Code** 直接消费你的 CodeBuddy 积分。
> 零依赖 Node.js 本地协议桥。不碰登录授权、不改桌面端文件、可搭配 [cc-switch](https://github.com/farion1231/cc-switch) 一键切换。

## ✨ 特性

- **零依赖**：纯 Node.js 标准库（≥18），`npm install` 都不需要
- **协议全转换**：Anthropic `/v1/messages` ↔ OpenAI `chat/completions` 双向，流式 / 非流式 / 多轮工具调用均支持
- **11128 渠道拦截免疫**：内置 system 身份指纹清洗 + 安全词脱敏（详见 [FAQ](#已知限制与-faq)），Claude Code 新旧版本身份句都已覆盖
- **模型名容错**：`hy4-preview[1m]`、`codebuddy/hy4-preview` 等展示名自动规整为上游真实 id
- **登录态复用**：只读扫描桌面端 auth 文件，token 过期自动刷新（刷新结果存在自己的目录，绝不回写）
- **配置文件驱动**：`config.json` 集中管理日志开关 / 鉴权 / 脱敏等全部开关，CLI 参数可临时覆盖
- **预检与监控**：`--doctor` 一键自检；`GET /health` 实时查看账号 / 积分 / 模型

## 它是怎么工作的

```
Claude Code  (Anthropic /v1/messages 原生协议)
      │  cc-switch 把 Base URL 指向本地桥
      ▼
┌──────────────────────────────────────────────┐
│  本地桥  node src/index.js  (127.0.0.1:8788)   │
│  · 读取 CodeBuddy 桌面端登录态(只读)            │
│  · Anthropic ↔ OpenAI 双向协议转换             │
│  · system 身份指纹清洗 + 安全词脱敏(防 11128)   │
│  · token 过期自动刷新(缓存到本程序自己文件)      │
│  · 钳制 max_tokens / 规整角色与 tool_choice     │
└──────────────────────────────────────────────┘
      │  POST /v2/chat/completions (OpenAI 协议, 强制流式, 原生 tools)
      ▼
copilot.tencent.com  CodeBuddy 后端 (GLM-5.3 / DeepSeek-V4 / Kimi / Hy3 ...)
```

协议转换沿用了 codebuddy2openai 与 dsh-workbuddy-connect 两个实战项目验证过的上游约定：
`developer` 角色改 `system`（否则 11128 渠道错误）、扁平 `reasoning_effort`、
`tool_choice` 字符串化、`tool_use` id 原样透传（保证多轮工具调用 `tool_result` 能匹配）。

## 前置条件

1. 已安装并**登录** CodeBuddy / WorkBuddy 桌面端（桥自动扫描登录文件，Windows 在
   `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info`，可用
   `WORKBUDDY_AUTH_FILE` 环境变量或 `--auth-file` 指定其它位置）。
2. Node.js 18+。

## 快速开始

```bash
# 1. 预检：账号 / token 过期时间 / 剩余积分 / 可用模型
node src/index.js --doctor

# 2. 启动（默认监听 http://127.0.0.1:8788）
node src/index.js
```

Windows 也可直接双击 `start.bat`（支持追加参数，如 `start.bat --port 8789`）。

验证：

```bash
curl http://127.0.0.1:8788/health     # 账号、积分、模型
curl http://127.0.0.1:8788/v1/models  # Anthropic 格式模型列表
```

## 接入 Claude Code（经 cc-switch）

cc-switch 只是个"配置切换器"，最终它会把下面这些写进 Claude Code 的配置（`~/.claude/settings.json` 的 env / 启动环境）：

| 配置项 | 值 |
|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8788` |
| `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | 留空；若启动桥时加了 `--api-key xxx` 则填 `xxx` |
| `ANTHROPIC_MODEL` / `--model` | 见下方模型清单 |

在 cc-switch 里添加一个 provider（类型选 Claude Code / Anthropic 兼容）：

1. 先启动桥：`node src/index.js`
2. cc-switch → Providers → 新增，填
   - **Name**: `CodeBuddy 积分`
   - **Base URL**: `http://127.0.0.1:8788`
   - **API Key**: 留空（除非桥用了 `--api-key`）
   - **Models**: 填常用模型，例如 `deepseek-v4-flash, glm-5.2, glm-5.3`
3. 保存并在 cc-switch 里**切换到该配置**
4. 打开 Claude Code 直接对话——请求会走桥、扣 CodeBuddy 积分

> 也可以绕过 cc-switch，直接以环境变量启动 Claude Code：
> ```bash
> ANTHROPIC_BASE_URL=http://127.0.0.1:8788 claude
> ```

## 可用模型（实测拉取，2026-09-07）

来自上游个人模型目录（`/console/enterprises/personal/models` 的 cli agent 列表，
启动后以 `GET /v1/models` 实时返回为准）：

| 模型 | 说明 | 积分倍数 |
|---|---|---|
| `auto` | 自动选择 | - |
| `hy4-preview` / `hy3` / `hy3-x` | 混元思考系列 | x0.00~x0.05 |
| `glm-5.3` / `glm-5.3-flash` / `glm-5.2` / `glm-5.1` | GLM 系列 | x0.79 / x0.06 / x0.79 |
| `glm-5v-turbo` | 多模态视觉 | x0.71 |
| `kimi-k3-1` / `kimi-k2.7` / `kimi-k2.6` | Kimi 系列 | x1.62 / x0.57 / x0.52 |
| `minimax-m3` | MiniMax | x0.25 |
| `deepseek-v4-flash` / `deepseek-v4-pro` | DeepSeek V4 | x0.17 / x0.51 |

快速且便宜的推荐：`deepseek-v4-flash`；强推理推荐 `glm-5.3` / `hy3-x`。

## 配置文件 config.json

所有开关集中在 `config.json` 管理——日志、鉴权、脱敏、上游行为，改完**重启**生效。
优先级：内置默认值 < `config.json` < CLI 参数 < 环境变量（`WORKBUDDY_AUTH_FILE`）。

```bash
cp config.example.json config.json   # 从模板创建自己的配置
```

```jsonc
// config.json（JSON 不支持注释，此处说明仅作示例）
{
  "server":   { "host": "127.0.0.1", "port": 8788 },   // 监听地址/端口
  "auth":     { "file": "" },                          // auth 文件路径，留空 = 自动扫描
  "log":      { "enabled": true, "path": "bridge.log" }, // ★ 日志总开关；相对路径按 config.json 所在目录解析
  "security": {                                          // 安全/兼容开关
    "apiKey": "",                                        // 要求客户端带相同 key，留空不校验
    "desensitize": true,                                 // system 安全词脱敏（缓解上游 11128 误拦）
    "sanitizeIdentity": true                             // system 身份指纹清洗（根除 11128 渠道识别）
  },
  "upstream": {                                          // 上游行为开关
    "effort": "",                                        // ""=后端默认；可选 off/low/medium/high
    "keepReasoningAsText": false,                        // 思考内容并入正文（默认丢弃）
    "maxTokensDefault": 16000                            // 无目录信息时 max_tokens 上限
  }
}
```

- 删掉 `config.json`（或删某个键）即回退内置默认——内置默认 **日志关闭**。
- `config.json` 已被 `.gitignore` 排除，本地个性化配置（尤其设了 `apiKey`）不会被误推；
  仓库里只保留 `config.example.json` 模板。
- 想临时覆盖又不想动文件：CLI 显式传参会赢过配置文件，例如
  `node src/index.js --no-log`（本次关日志）、`start.bat --port 8789`。

## CLI 参数

CLI 参数只做「显式覆盖」，不写某参数时以 config.json / 内置默认值为准。

```
node src/index.js [options]
  --config PATH            指定配置文件 (默认 <项目根>/config.json；不存在则用内置默认)
  --port N                 监听端口 (默认 8788)
  --host H                 监听地址 (默认 127.0.0.1，仅本机)
  --auth-file PATH         桌面端 auth 文件 (默认取配置/自动扫描；也可用环境变量 WORKBUDDY_AUTH_FILE)
  --api-key KEY            要求 Claude Code 携带相同 key (默认不校验)
  --effort off|low|medium|high   透传扁平 reasoning_effort (默认不设置，用后端默认档)
  --keep-reasoning-as-text       把上游思考内容(reasoning_content)并入正文 (默认丢弃)
  --max-tokens N           无目录信息时 max_tokens 上限 (默认 16000)
  --log PATH               开启请求日志并写入 PATH（覆盖配置文件 log 段）
  --no-log                 强制关闭日志（覆盖配置文件 log.enabled，与 --log 互斥）
  --no-sanitize-identity   关闭 system 身份指纹清洗 (默认开启，根除 11128 渠道识别)
  --no-desensitize         关闭 system 安全词脱敏 (默认开启)
  --doctor                 预检并退出
```

## 接口

- `POST /v1/messages` — Anthropic Messages API（Claude Code 原生协议），流式/非流式、工具调用均支持
- `GET /v1/models` — 模型列表（Anthropic 格式）
- `GET /health` — 账号 / token 过期 / 剩余积分 / 模型数

## 排障工具

```bash
# 端到端回归：health / models / 非流式 / 流式 / 两轮工具调用
node src/index.js &            # 先起桥
node scripts/e2e.mjs           # 跑用例

# 11128 二分定位：用 bridge.log dump 的 system 全文逐块直连上游复现
node scripts/bisect-11128.mjs <system-dump.txt> [--model deepseek-v4-flash]
```

## 已知限制与 FAQ

- **`11128 Illegal API invocation` / 请求被安全策略拦截**：CodeBuddy 上游的渠道安全审查。
  **已定位根因（2026-09-07，二分复现验证；2026-09-08 补新版短身份句）**：上游按 system 里的**客户端身份指纹**识别
  "非官方渠道的 Claude Code 调用"。实测指纹组合：
  1. `x-anthropic-billing-header:` 计费头行（Claude Code 注入 system 首行）；
  2. 身份句——**两个版本都会拦**：
     - 旧版：`You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`
     - 新版（2026-09 实测）：缩短为 `You are Claude Code, Anthropic's official CLI for Claude.`
     （组合检测，缺一段就放行）；
  3. git 环境句 `Main branch (you will usually use this for PRs)`。
  桥已内置**身份指纹清洗**（启动日志显示「指纹清洗: 开启」），把上述指纹改写为中性表述，
  Claude Code 人设保留。**2026-09-08 修复后真弹验证**：完整真实载荷清洗后上游 200 放行，
  同一载荷不清洗复现 11128。
  另外模型名带 `[1m]` 等展示后缀也会被拦（11102/11128），桥同样自动清洗。
  若仍复现（如 Claude Code 又改了 system 文案）：`node scripts/bisect-11128.mjs <system dump 文件>` 可复现定位，
  或用 `--log bridge.log` 抓日志分析。
- **日志**：默认走 `config.json` 的 `log` 段（`enabled: true` 时写入 `bridge.log`，
  记录每次请求的模型/角色/块类型分布、身份清洗命中数、脱敏命中数，以及上游完整错误体，
  不含任何 token）。关日志：把 `config.json` 里 `log.enabled` 改 `false`，或 `node src/index.js --no-log`。
- **thinking / 思考预算**：Claude Code 若启用 thinking（`budget_tokens`），Anthropic 的
  signature 体系无法伪造，桥会把该请求转成上游扁平 `reasoning_effort`（默认 `high`），
  模型照常深度思考但思考内容不可见（上游思考 `reasoning_content` 默认丢弃，
  可用 `--keep-reasoning-as-text` 并入正文查看）。工具调用与正文不受影响。
- **图片**：支持 Anthropic image 块转 OpenAI image_url（需选多模态模型，如 `hy3`、`glm-5v-turbo`）；
  PDF/document 附件暂不转换。
- **token 过期**：自动刷新，刷新结果保存在 `~/.claude-codebuddy/credential.json`，
  **不回写桌面端 auth 文件**。若刷新也失败会提示重新打开桌面端登录。
- **"内容审核拦截"**：CodeBuddy 后端偶发误拦（提示会原样返回）。可换措辞重试。
- **积分不足**：上游返回 402，桥会把错误信息转成中文提示返回给 Claude Code。
- **端口占用**：换端口 `--port N`；也确认没有残留的桥进程。

## 项目结构

```
claude-codebuddy-bridge/
├── src/
│   ├── index.js      # 入口：CLI 解析 + 配置加载 + 服务启动
│   ├── config.js     # 配置系统：config.json + CLI + 环境变量三级合并
│   ├── server.js     # HTTP 服务：路由、模型目录、健康检查
│   ├── convert.js    # 协议转换核心：Anthropic ↔ OpenAI + 指纹清洗 + 脱敏
│   ├── upstream.js   # 上游客户端：chat 流式 / token 刷新 / 积分 / 模型目录
│   ├── auth.js       # 凭据：桌面端 auth 文件扫描与解析
│   └── util.js       # 共享常量与工具
├── scripts/
│   ├── e2e.mjs               # 端到端回归测试
│   └── bisect-11128.mjs      # 11128 拦截二分定位
├── config.example.json       # 配置模板（复制为 config.json 使用）
├── start.bat                 # Windows 一键启动
└── package.json
```

## 致谢

上游协议细节参考了这些实战项目：[codebuddy2openai](https://github.com/)、dsh-workbuddy-connect、Sliverkiss/workbuddy2api。

## 免责声明

仅供个人学习与合理自用，仅驱动你自己的 CodeBuddy/WorkBuddy 订阅；非官方产品，
与腾讯 / CodeBuddy / Anthropic 无关，请遵守相关服务条款。使用本项目产生的一切后果由使用者自行承担。

## License

[MIT](LICENSE)
