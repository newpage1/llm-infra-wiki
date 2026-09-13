#!/usr/bin/env bash
# 把站点直接传到静态托管（不经过 git）。
#
#   bash deploy.sh                # 发布到生产
#   bash deploy.sh --preview      # 发一个预览分支，拿到一个临时 URL
#   bash deploy.sh --dry-run      # 只列出会传哪些文件，不真传
#
# 平时**不需要跑这个**：Cloudflare Pages 接了 GitHub 之后，推到 main 就自动发布。
# 这个脚本用于「不想开 PR、只想把当前工作区丢上去看一眼」的场景。
#
# 前置：npm i -g wrangler && wrangler login
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="${CF_PROJECT:-llm-infra-wiki}"
MODE="deploy"
case "${1:-}" in
  --preview) MODE="preview" ;;
  --dry-run) MODE="dryrun" ;;
  "") ;;
  *) echo "未知参数：$1（可用 --preview / --dry-run）" >&2; exit 2 ;;
esac

# ── 只传发布需要的东西 ────────────────────────────────────────────
# Cloudflare Pages 会把整个目录当静态站托管，所以施工产物、脚本、规范
# 都不该进去。这里显式列白名单，而不是靠排除——排除法总会漏。
FILES=(index.html)
DIRS=(assets data diagrams)

if [[ "$MODE" == "dryrun" ]]; then
  echo "会发布以下内容（相对仓库根）："
  printf '  %s\n' "${FILES[@]}" "${DIRS[@]}"
  echo
  echo "体积："
  du -ch "${FILES[@]}" "${DIRS[@]}" 2>/dev/null | tail -1
  echo
  echo "不会发布的（施工与源码）："
  printf '  %s\n' .git .github .anchor-cache .backup .work authoring tools \
                   *.py CONTRIBUTING.md README.md
  exit 0
fi

command -v wrangler >/dev/null || {
  echo "❌ 没装 wrangler。先跑：npm i -g wrangler && wrangler login" >&2; exit 1
}

# 用一个临时目录拼出「正好要发布的那份」，避免把脚本也传上去
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
for f in "${FILES[@]}"; do cp -R "$f" "$STAGE/"; done
for d in "${DIRS[@]}"; do cp -R "$d" "$STAGE/"; done

echo "暂存目录：$STAGE（$(du -sh "$STAGE" | cut -f1)）"
if [[ "$MODE" == "preview" ]]; then
  echo "→ 发布预览分支"
  wrangler pages deploy "$STAGE" --project-name "$PROJECT" --branch preview
else
  echo "→ 发布生产"
  wrangler pages deploy "$STAGE" --project-name "$PROJECT" --branch main
fi
