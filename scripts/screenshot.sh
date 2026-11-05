#!/usr/bin/env bash
# 离线无头浏览器截图（开发验收用，不随产品分发）
# 用法: scripts/screenshot.sh <url> <out.png> [宽=1920] [高=1080] [虚拟时间ms=4000]
set -u

URL="${1:?usage: screenshot.sh <url> <out.png> [width] [height] [budgetMs]}"
OUT="${2:?usage: screenshot.sh <url> <out.png> [width] [height] [budgetMs]}"
W="${3:-1920}"
H="${4:-1080}"
BUDGET="${5:-4000}"

CANDIDATES=(
  "$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell"
  "$HOME/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
  "$(command -v chromium 2>/dev/null || true)"
  "$(command -v chromium-browser 2>/dev/null || true)"
  "$(command -v google-chrome 2>/dev/null || true)"
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
)

CHROME=""
for c in "${CANDIDATES[@]}"; do
  if [ -n "$c" ] && [ -x "$c" ]; then CHROME="$c"; break; fi
done

if [ -z "$CHROME" ]; then
  echo "未找到 Chrome/Chromium 无头浏览器" >&2
  exit 1
fi

rm -f "$OUT"
"$CHROME" --headless --disable-gpu --hide-scrollbars --no-sandbox \
  --force-device-scale-factor=1 --window-size="${W},${H}" \
  --virtual-time-budget="${BUDGET}" --screenshot="$OUT" "$URL" 2>/dev/null

if [ -f "$OUT" ]; then
  echo "screenshot: $OUT"
else
  echo "screenshot failed: $OUT" >&2
  exit 1
fi
