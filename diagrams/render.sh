#!/usr/bin/env bash
# 渲染 diagrams/*.puml → *.svg，并检查宽度
#
# 依赖：plantuml（brew install plantuml）
#
# 注意两个已知坑：
#   1. skinparam FontSize 不支持小数——写 12.5 会被解析成 125，图宽膨胀 10 倍。
#      统一用整数。
#   2. 同级类太多时 PlantUML 会横向铺开。超过 ~1150px 的图在页面里会被缩小，
#      应当减少同级的类，或把「其余实现」合并成一个节点。
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v plantuml >/dev/null 2>&1; then
  echo "缺少 plantuml。安装：brew install plantuml" >&2
  exit 1
fi

plantuml -tsvg -charset UTF-8 ./*.puml

# 小数字号检查（会静默膨胀 10 倍）
if grep -l 'FontSize [0-9]*\.' ./*.puml 2>/dev/null | grep -q .; then
  echo "⚠️  发现小数字号，PlantUML 会把它解析成 10 倍："
  grep -n 'FontSize [0-9]*\.' ./*.puml || true
fi

echo
echo "宽度检查（阈值 1150px，超出会在页面里被缩小）："
wide=0
for f in ./*.svg; do
  w=$(sed -n 's/.*width="\([0-9]*\)px".*/\1/p' "$f" | head -1)
  [ -z "$w" ] && continue
  if [ "$w" -gt 1150 ]; then
    printf "  ⚠️  %5s  %s\n" "$w" "$(basename "$f")"; wide=$((wide+1))
  fi
done
[ "$wide" -eq 0 ] && echo "  ✅ 全部在阈值内"
echo
echo "已渲染 $(ls -1 ./*.svg 2>/dev/null | wc -l | tr -d ' ') 个 SVG"
