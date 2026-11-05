#!/usr/bin/env bash
# ==========================================================================
# BigScreen 大屏看板 —— 六平台离线交叉编译脚本
#
# 用法:
#   scripts/build-all.sh                 # 默认版本 1.0.0，输出到 dist/
#   VERSION=1.2.0 scripts/build-all.sh   # 指定版本号（注入 -X main.version）
#   OUT_DIR=/tmp/dist scripts/build-all.sh
#
# 产物（CGO_ENABLED=0，纯静态、无外部依赖、无需运行环境）：
#   dist/bigscreen-server_windows_amd64.exe
#   dist/bigscreen-server_windows_386.exe
#   dist/bigscreen-server_darwin_arm64
#   dist/bigscreen-server_darwin_amd64
#   dist/bigscreen-server_linux_amd64
#   dist/bigscreen-server_linux_arm64
# ==========================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${VERSION:-1.0.0}"
OUT_DIR="${OUT_DIR:-dist}"
LDFLAGS="-s -w -X main.version=${VERSION}"

if ! command -v go >/dev/null 2>&1; then
  echo "错误：未找到 go 命令，请先安装 Go 1.22+（离线环境可用官方 tar.gz 解压安装）。" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# 平台列表：OS ARCH
TARGETS=(
  "windows amd64"
  "windows 386"
  "darwin arm64"
  "darwin amd64"
  "linux amd64"
  "linux arm64"
)

echo "=================================================================="
echo " BigScreen 大屏看板 交叉编译  v${VERSION}"
echo " 输出目录 : $ROOT/$OUT_DIR"
echo " Go 版本  : $(go version)"
echo " 构建参数 : CGO_ENABLED=0 ldflags=\"$LDFLAGS\""
echo "=================================================================="
echo

BUILT=()
for target in "${TARGETS[@]}"; do
  read -r os arch <<<"$target"
  name="bigscreen-server_${os}_${arch}"
  if [ "$os" = "windows" ]; then
    name="${name}.exe"
  fi
  dest="$OUT_DIR/$name"
  printf '  [%s/%s] -> %s\n' "$os" "$arch" "$dest"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
    go build -trimpath -buildvcs=false -ldflags "$LDFLAGS" -o "$dest" ./server
  BUILT+=("$dest")
done

echo
echo "=== 产物信息 ==="
if command -v file >/dev/null 2>&1; then
  file "${BUILT[@]}"
else
  ls -lh "${BUILT[@]}"
fi

echo
echo "=== 完成 ==="
echo "  部署：把目标平台的可执行文件与 start.sh（Windows 用 start.bat）拷到同一目录，"
echo "        双击或命令行运行即可；数据默认写入同目录 data/。"
echo "  示例：./bigscreen-server_linux_arm64 -port 8080 -data ./data -password 你的密码"
