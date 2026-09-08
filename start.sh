#!/bin/bash
# claude-codebuddy-bridge macOS/Linux 一键启动
# 用法: ./start.sh [追加参数]
#   ./start.sh                 前台启动（配置走 config.json）
#   ./start.sh --port 8789     临时换端口
#   ./start.sh --no-log        本次关闭日志
#   ./start.sh --doctor        预检后退出
# 后台运行: nohup ./start.sh >/dev/null 2>&1 &

set -u
cd "$(dirname "$0")"

# ===== 自动定位 node =====
NODE_EXE=""
if command -v node >/dev/null 2>&1; then
  NODE_EXE="$(command -v node)"
elif [ -x "/usr/local/bin/node" ]; then
  NODE_EXE="/usr/local/bin/node"
elif [ -x "/opt/homebrew/bin/node" ]; then
  NODE_EXE="/opt/homebrew/bin/node"   # Apple Silicon Homebrew
elif [ -x "$HOME/.nvm/versions/node" ]; then
  # nvm 未 source 的场景：取版本号最大的 node
  NODE_EXE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
fi

if [ -z "$NODE_EXE" ]; then
  echo "[错误] 未找到 Node.js，请先安装 Node.js 18+：https://nodejs.org"
  echo "  macOS: brew install node  或  nvm install 22"
  exit 1
fi

echo ""
echo "============================================"
echo "   claude-codebuddy-bridge  启动器"
echo "============================================"
echo "   Base URL : http://127.0.0.1:8788"
echo "   配置     : config.json (日志开关/端口等, 详见 README)"
echo "   按 Ctrl+C 停止"
echo "--------------------------------------------"
echo "   可追加参数覆盖配置, 例如:"
echo "     ./start.sh --no-log             关闭日志"
echo "     ./start.sh --port 8789          换端口"
echo "     ./start.sh --doctor             预检后退出"
echo "--------------------------------------------"
echo ""

exec "$NODE_EXE" src/index.js "$@"
