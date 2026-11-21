#!/usr/bin/env bash
# 发布 @waiyubaodian/hevc-player 到公网 npm，并带完整前置校验。
# 用法：bash scripts/publish.sh [--dry-run]
set -euo pipefail

cd "$(dirname "$0")/.."
PKG_NAME=$(node -p "require('./package.json').name")
PKG_VERSION=$(node -p "require('./package.json').version")
DRY_RUN="${1:-}"

echo "==> 包：${PKG_NAME}@${PKG_VERSION}"
echo ""

echo "==> [1/5] 检查登录状态"
if ! npm whoami >/dev/null 2>&1; then
  echo "✗ 未登录 npm。请先执行：npm login"
  exit 1
fi
NPM_USER=$(npm whoami)
echo "    当前账号：${NPM_USER}"

echo "==> [2/5] 检查 scope 发布权限"
# 查询组织是否存在（publishConfig.access=public）
SCOPE="${PKG_NAME%@*}"
SCOPE="${SCOPE#@}"
ORG_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -H "Authorization: Bearer $(npm config get //registry.npmjs.org/:_authToken 2>/dev/null || echo '')" \
  "https://registry.npmjs.org/-/org/${SCOPE}/package" || echo "000")
echo "    尝试查询组织 ${SCOPE}：HTTP ${ORG_CODE}（403/404 通常表示尚无权或无组织）"

echo "==> [3/5] 检查版本是否已被占用"
PUBLISHED=$(npm view "${PKG_NAME}@${PKG_VERSION}" version 2>/dev/null || echo "NONE")
if [ "${PUBLISHED}" != "NONE" ]; then
  echo "✗ 版本 ${PKG_VERSION} 已存在，请先更新 package.json 的 version"
  exit 1
fi
echo "    版本可用：${PKG_VERSION}"

echo "==> [4/5] 质量门（typecheck + test + build）"
npm run typecheck
npm test
npm run build

echo "==> [5/5] 发布"
if [ "${DRY_RUN}" = "--dry-run" ]; then
  npm publish --dry-run
  echo ""
  echo "✓ dry-run 完成，未真正发布"
else
  npm publish
  echo ""
  echo "✓ 发布成功：https://www.npmjs.com/package/${PKG_NAME}"
fi
