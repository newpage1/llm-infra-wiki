#!/usr/bin/env bash
# 启动 LLM Infra Wiki 本地预览服务
#
#   ./serve.sh              # 仅本机可访问  http://127.0.0.1:8899
#   ./serve.sh --lan        # 局域网可访问  http://<本机IP>:8899
#   PORT=9000 ./serve.sh    # 换端口
#
# 前台运行，Ctrl-C 停止。若要让别人长期访问，见 README 的「部署」一节。

set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8899}"
BIND="127.0.0.1"

if [[ "${1:-}" == "--lan" ]]; then
  BIND="0.0.0.0"
fi

echo "serving $(pwd) at http://${BIND}:${PORT}/"
[[ "$BIND" == "0.0.0.0" ]] && echo "（局域网模式：同网段的设备可用本机 IP 访问）"

exec python3 -m http.server "$PORT" --bind "$BIND"
