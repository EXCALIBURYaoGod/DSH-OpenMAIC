#!/bin/bash
# 构建 @openteach/bundle 的 dsh 插件产物（lib/index.js + lib/index.d.ts）。
#
# 依赖解析沿用 dsh-openmaic 的做法：把 harness checkout 里的 @deepseek-ai/* 宿主包
# 软链到本包 node_modules，使 tsdown 的类型检查与打包对齐「运行中的 dsh 所带的那套
# 包」。默认使用本地 checkout；可用 DSH_CHECKOUT 指定。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ] && command -v dsh &>/dev/null; then
  DSH_BIN=$(readlink -f "$(command -v dsh)" 2>/dev/null || command -v dsh)
  CANDIDATE=$(cd "$(dirname "$DSH_BIN")/.." && pwd 2>/dev/null || true)
  if [ -n "$CANDIDATE" ] && [ -d "$CANDIDATE/packages" ] && [ -d "$CANDIDATE/vendor" ]; then
    CHECKOUT="$CANDIDATE"
  fi
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ] || [ ! -d "$CHECKOUT/vendor" ]; then
  echo "build: cannot locate the harness checkout (set DSH_CHECKOUT or put dsh on PATH)" >&2
  exit 1
fi

TSDOWN="$CHECKOUT/node_modules/.bin/tsdown"
if [ ! -x "$TSDOWN" ]; then
  echo "build: tsdown not found at $TSDOWN" >&2
  exit 1
fi

# 读取某个 package.json 的 "name" 字段。
pkg_name() {
  grep -m1 '"name"' "$1" | sed -E 's/.*"name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
}

echo "=== Linking @deepseek-ai/* host packages (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai node_modules/@types
# 泛化扫描：不硬编码各宿主包在 checkout 中的目录，按 package.json 的 name 建链。
while IFS= read -r manifest; do
  name=$(pkg_name "$manifest")
  case "$name" in
    @deepseek-ai/*) ;;
    *) continue ;;
  esac
  target=$(dirname "$manifest")
  mkdir -p "node_modules/$(dirname "$name")"
  ln -sfn "$target" "node_modules/$name"
done < <(find "$CHECKOUT/packages" "$CHECKOUT/vendor" -maxdepth 3 -name package.json -not -path '*/node_modules/*' 2>/dev/null)

if [ -d "$CHECKOUT/node_modules/@types" ]; then
  ln -sfn "$CHECKOUT/node_modules/@types" node_modules/@types
fi

echo "=== Building openmaic-core (esbuild single-file bundle) ==="
# openmaic-core 的 vendor 源码（OpenMAIC lib/ 移植）不参与组装层 typecheck，
# 由 build.mjs 用 esbuild 单文件打包为 lib/index.js；组装层 tsdown 再将其内联。
node packages/openmaic-core/build.mjs

echo "=== Bundling src -> lib (tsdown) ==="
"$TSDOWN"

echo "=== Build complete ==="
ls -la lib/