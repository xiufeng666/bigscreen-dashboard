#!/usr/bin/env bash
# ==========================================================================
# BigScreen 大屏看板 —— macOS / Linux 启动脚本（面向最终用户）
#
# 用法（先 cd 到本脚本所在目录，或直接运行脚本路径）：
#   ./start.sh                                   # 默认 8080 端口，数据存 ./data
#   ./start.sh -open                             # 启动并自动打开浏览器展示大屏
#   ./start.sh -port 9090 -open                  # 指定端口并打开浏览器
#   ./start.sh -password 我的密码 -open           # 开启编辑器/控制鉴权
#   ./start.sh -data /opt/bigscreen/data         # 指定数据目录
#
# 完整参数见 ./start.sh -h 或 README.md。
# ==========================================================================
set -euo pipefail

# 切到脚本所在目录，保证 data/ 与可执行文件位置相对固定
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

usage() {
  cat <<'EOF'
BigScreen 大屏看板 启动脚本

用法: ./start.sh [参数]

参数:
  -port int          监听端口（默认 8080）
  -data string       数据目录（默认 ./data）
  -password string   编辑/控制鉴权密码，空=不鉴权
  -open              启动后自动打开浏览器展示大屏
  -version           打印版本号后退出
  -h, --help         显示本帮助

页面:
  大屏展示页  http://本机IP:8080/
  远程编辑器  http://本机IP:8080/editor

示例:
  ./start.sh -open
  ./start.sh -port 9090 -password 123456 -open
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

detect_os() {
  case "$(uname -s)" in
    Linux*) echo "linux" ;;
    Darwin*) echo "darwin" ;;
    *) echo "unknown" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo "amd64" ;;
    aarch64 | arm64) echo "arm64" ;;
    i386 | i686) echo "386" ;;
    *) echo "unknown" ;;
  esac
}

BIN="${BIGSCREEN_BIN:-}"
if [ -z "$BIN" ]; then
  os="$(detect_os)"
  arch="$(detect_arch)"
  candidates=(
    "./bigscreen-server_${os}_${arch}"
    "./dist/bigscreen-server_${os}_${arch}"
    "./bigscreen-server"
    "../bigscreen-server_${os}_${arch}"
    "../dist/bigscreen-server_${os}_${arch}"
  )
  for candidate in "${candidates[@]}"; do
    if [ -x "$candidate" ]; then
      BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$BIN" ]; then
  echo "错误：未找到与当前系统匹配的 BigScreen 可执行文件。" >&2
  echo "  当前系统: $(uname -s) $(uname -m)" >&2
  echo "  请把 bigscreen-server_$(detect_os)_$(detect_arch) 与本脚本放在同一目录，" >&2
  echo "  或用 BIGSCREEN_BIN=/path/to/bigscreen-server ./start.sh 指定。" >&2
  exit 1
fi

chmod +x "$BIN" 2>/dev/null || true

echo "正在启动 BigScreen 大屏看板..."
echo "  可执行文件: $BIN"
echo "  大屏展示页: http://127.0.0.1:8080/   （端口以实际参数为准）"
echo "  远程编辑器: http://127.0.0.1:8080/editor"
echo "  按 Ctrl+C 停止服务"
echo

exec "$BIN" "$@"
