#!/bin/bash
# 风扇管家 fan-pro FPK 构建脚本
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${ROOT}/app"
FPK_DIR="${ROOT}/fpk"
BUILD_DIR="${ROOT}/build"
DIST_DIR="${ROOT}/dist"
PIP="${PIP:-pip3}"

VERSION="$(grep '^version' "${FPK_DIR}/manifest" | awk '{print $3}')"
[ $# -ge 1 ] && VERSION="$1"
OUT_NAME="fan-pro-${VERSION}-amd64.fpk"

echo "==> [1/4] 安装 Python 依赖到 app/server/vendor"
rm -rf "${APP_DIR}/server/vendor"
"${PIP}" install -q --target "${APP_DIR}/server/vendor" \
  flask requests gunicorn
find "${APP_DIR}/server/vendor" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf "${APP_DIR}/server/vendor/bin" 2>/dev/null || true
find "${APP_DIR}" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true

echo "==> [2/4] 打包 app.tgz"
mkdir -p "${BUILD_DIR}"
tar czf "${BUILD_DIR}/app.tgz" -C "${APP_DIR}" .

echo "==> [3/4] 写入 checksum"
SUM="$(md5sum "${BUILD_DIR}/app.tgz" | awk '{print $1}')"
sed -E "s/^checksum[[:space:]]*=.*/checksum              = ${SUM}/" \
  "${FPK_DIR}/manifest" > "${BUILD_DIR}/manifest"
grep '^checksum' "${BUILD_DIR}/manifest"

echo "==> [4/4] 组装 FPK"
STAGE="${BUILD_DIR}/stage"
rm -rf "${STAGE}"; mkdir -p "${STAGE}"
cp "${BUILD_DIR}/app.tgz" "${STAGE}/"
cp "${BUILD_DIR}/manifest" "${STAGE}/manifest"
cp -r "${FPK_DIR}/cmd" "${FPK_DIR}/config" "${STAGE}/"
# wizard 目录必须存在；git 不跟踪空目录，缺失时补空目录
mkdir -p "${STAGE}/wizard"
cp -r "${FPK_DIR}/wizard/." "${STAGE}/wizard/" 2>/dev/null || true
cp "${FPK_DIR}/ICON.PNG" "${FPK_DIR}/ICON_256.PNG" "${STAGE}/"
mkdir -p "${DIST_DIR}"
tar czf "${DIST_DIR}/${OUT_NAME}" -C "${STAGE}" .
tar tzf "${DIST_DIR}/${OUT_NAME}" >/dev/null
echo "完成: dist/${OUT_NAME} ($(du -h "${DIST_DIR}/${OUT_NAME}" | awk '{print $1}'))"
