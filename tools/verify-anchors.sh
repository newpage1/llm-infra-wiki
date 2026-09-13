#!/usr/bin/env bash
# 完整校验：连行号与逐字围栏一起查——需要先拿到被分析的代码。
#
#   bash tools/verify-anchors.sh                 # 自动 clone 到 .anchor-cache/
#   ANCHOR_CACHE=/path/to/clones bash tools/verify-anchors.sh   # 复用已有 clone
#   bash tools/verify-anchors.sh mooncake vllm   # 只查指定分析页
#
# 为什么单独一个脚本：完整校验要 clone 五个仓库（vllm 一个就上百 MB），
# 不适合挂在每个 PR 上。PR 跑 tools/verify.sh（离线），这个手动跑或定时跑。
#
# 缓存目录里的子目录名 = 分析页 id；若该目录已经是这个提交的 git 仓库就直接复用，
# 不会重复下载。
set -uo pipefail
cd "$(dirname "$0")/.."

CACHE="${ANCHOR_CACHE:-.anchor-cache}"
FAIL=0
ONLY=("$@")

mkdir -p "$CACHE"

# 只解析 anchors.json 里我们要的字段（不引入 jq 依赖）
entries=$(node -e '
  const j = require("./tools/anchors.json");
  for (const [id, v] of Object.entries(j.repos)) {
    console.log([id, v.url, v.rev, v.local ? "1" : "0", (v.note || "").replace(/\n/g, " ")].join("\t"));
  }
')

while IFS=$'\t' read -r id url rev islocal note; do
  [[ -z "$id" ]] && continue
  if [[ ${#ONLY[@]} -gt 0 ]]; then
    keep=0; for o in "${ONLY[@]}"; do [[ "$o" == "$id" ]] && keep=1; done
    [[ $keep == 0 ]] && continue
  fi

  printf '\n\033[1m── %s\033[0m\n' "$id"

  if [[ "$islocal" == "1" ]]; then
    printf '   \033[33m⊘ 跳过\033[0m 基线无法从公开仓库复现\n'
    printf '     %s\n' "$note"
    continue
  fi

  dir="$CACHE/$id"
  if [[ -d "$dir/.git" ]] && git -C "$dir" cat-file -e "$rev^{commit}" 2>/dev/null; then
    printf '   复用 %s @ %s\n' "$dir" "$rev"
  else
    printf '   拉取 %s @ %s …\n' "$url" "$rev"
    rm -rf "$dir"
    git init -q "$dir" || { printf '   \033[31m✗ git init 失败\033[0m\n'; FAIL=1; continue; }
    git -C "$dir" remote add origin "$url" || true
    if ! git -C "$dir" fetch -q --depth 1 origin "$rev" 2>&1 | tail -3; then
      printf '   \033[31m✗ 拉取失败（提交不存在或网络不可达）\033[0m\n'; FAIL=1; continue
    fi
    git -C "$dir" checkout -q FETCH_HEAD || { printf '   \033[31m✗ checkout 失败\033[0m\n'; FAIL=1; continue; }
  fi

  out=$(node tools/checker/check_module.js data/analyses.js "$id" --all --repo "$dir" 2>&1)
  rc=$?
  last=$(echo "$out" | grep '^合计：' | tail -1)
  if [[ $rc -eq 0 && "$last" == *"0 个错误"* ]]; then
    printf '   \033[32m✓\033[0m %s\n' "$last"
  else
    printf '   \033[31m✗ %s\033[0m\n' "${last:-（无输出）}"
    echo "$out" | grep -E '❌|⚠️' | head -20 | sed 's/^/     /'
    FAIL=1
  fi
done <<< "$entries"

printf '\n'
if [[ $FAIL -eq 0 ]]; then
  printf '\033[32m完整校验通过\033[0m\n'
else
  printf '\033[31m完整校验未通过\033[0m\n'
fi
exit $FAIL
