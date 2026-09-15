#!/usr/bin/env bash
# 离线自检：不需要网络、不需要 clone 被分析的仓库。
# PR 上跑的就是这个——它挡掉「格式坏了」的问题；行号是否真实由 verify-anchors.sh 管。
#
#   bash tools/verify.sh          # 全部
#   bash tools/verify.sh -q       # 只报失败项
set -uo pipefail
cd "$(dirname "$0")/.."

QUIET=0
[[ "${1:-}" == "-q" ]] && QUIET=1
FAIL=0

hdr(){ [[ $QUIET == 1 ]] || printf '\n\033[1m── %s\033[0m\n' "$*"; }
ok(){  [[ $QUIET == 1 ]] || printf '   \033[32m✓\033[0m %s\n' "$*"; }
bad(){ printf '   \033[31m✗ %s\033[0m\n' "$*"; FAIL=1; }

# 单条命令：失败就打印尾部输出
run(){
  local desc="$1"; shift
  local out; out="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -eq 0 ]]; then ok "$desc"; else bad "$desc"; echo "$out" | tail -20 | sed 's/^/     /'; fi
}

ANALYSES=$(node -e '
  global.window={};require("./data/analyses.js");
  console.log((global.window.WIKI_ANALYSES||[]).map(a=>a.id).join(" "));
')

hdr "① 发布前体检（真渲染器 / 纯文本字段 / SVG / component）"
run "tools/check_publish.js" node tools/check_publish.js

hdr "② 各分析页的结构校验（离线：不含行号与逐字围栏）"
for id in $ANALYSES; do
  run "$id --all"    node tools/checker/check_module.js data/analyses.js "$id" --all
  run "$id --design" node tools/checker/check_module.js data/analyses.js "$id" --design
  run "$id --cross"  node tools/checker/check_module.js data/analyses.js "$id" --cross
done

hdr "③ 文风指标（AI 腔不许写回去）"
run "style_audit --guard" node tools/style_audit.js --guard

hdr "④ 手绘 SVG 的文字重叠"
run "lint_svg.py" python3 lint_svg.py

hdr "⑤ 站内链接（按路由解一遍，看目标是否存在）"
run "check_links.js" node tools/check_links.js

hdr "⑥ 联动分析（front-matter / 图片 / 锚点）"
run "build_flows --lint" node tools/build_flows.js --lint
run "check_flows.js"     node tools/check_flows.js

if [[ $FAIL -eq 0 ]]; then
  printf '\n\033[32m全部通过\033[0m（离线校验）\n'
  [[ $QUIET == 1 ]] || printf '\033[2m行号与逐字围栏未校验——需要 clone 被分析的仓库，见 tools/verify-anchors.sh\033[0m\n'
else
  printf '\n\033[31m有检查未通过\033[0m\n'
fi
exit $FAIL
