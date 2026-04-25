#!/usr/bin/env bash
# 生成随机 URL-safe 密码，并写入 Cloudflare Worker Secret SUB_STORE_FRONTEND_BACKEND_PATH。
#
# 用法：
#   ./scripts/rotate-secret.sh                # 默认 32 位
#   ./scripts/rotate-secret.sh -l 48          # 自定义长度
#   ./scripts/rotate-secret.sh --no-clipboard # 不复制到剪贴板
#   ./scripts/rotate-secret.sh -n my-worker   # 指定 Worker 名称

set -euo pipefail

LENGTH=32
COPY_CLIPBOARD=1
WORKER_NAME=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -l|--length)
            LENGTH="$2"
            shift 2
            ;;
        --no-clipboard)
            COPY_CLIPBOARD=0
            shift
            ;;
        -n|--name)
            WORKER_NAME="$2"
            shift 2
            ;;
        -h|--help)
            sed -n '2,9p' "$0"
            exit 0
            ;;
        *)
            echo "未知参数: $1" >&2
            exit 1
            ;;
    esac
done

if [[ "$LENGTH" -lt 16 ]]; then
    echo "密码长度不能小于 16 位。" >&2
    exit 1
fi

# 生成 URL-safe 随机字符串：从 base64 中过滤出 [A-Za-z0-9]
RAND_RAW="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$LENGTH")"
PATH_VALUE="/${RAND_RAW}"

echo "[rotate-secret] 已生成新密码，长度 ${#PATH_VALUE} 位（含 /）"

# 复制到剪贴板（可选）
copy_to_clipboard() {
    local value="$1"
    if command -v pbcopy >/dev/null 2>&1; then
        printf '%s' "$value" | pbcopy
        return 0
    fi
    if command -v wl-copy >/dev/null 2>&1; then
        printf '%s' "$value" | wl-copy
        return 0
    fi
    if command -v xclip >/dev/null 2>&1; then
        printf '%s' "$value" | xclip -selection clipboard
        return 0
    fi
    if command -v xsel >/dev/null 2>&1; then
        printf '%s' "$value" | xsel --clipboard --input
        return 0
    fi
    return 1
}

if [[ "$COPY_CLIPBOARD" -eq 1 ]]; then
    if copy_to_clipboard "$PATH_VALUE"; then
        echo "[rotate-secret] 已复制到剪贴板，请尽快粘贴到前端配置后清空剪贴板"
    else
        echo "[rotate-secret] 未找到可用剪贴板工具（pbcopy/wl-copy/xclip/xsel），跳过复制"
    fi
fi

# 通过管道写入 Cloudflare Worker Secret
WRANGLER_ARGS=(wrangler secret put SUB_STORE_FRONTEND_BACKEND_PATH)
if [[ -n "$WORKER_NAME" ]]; then
    WRANGLER_ARGS+=(--name "$WORKER_NAME")
fi

echo "[rotate-secret] 调用 npx ${WRANGLER_ARGS[*]}"
printf '%s' "$PATH_VALUE" | npx "${WRANGLER_ARGS[@]}"

cat <<EOF

[rotate-secret] Secret 已更新。
请同步更新以下位置：
  1. 前端后端地址：https://<your-worker-domain>${PATH_VALUE}
  2. GitHub Actions Secret：SUB_STORE_PASSWORD_VALUE

粘贴完成后请清空剪贴板，例如：
  unset CLIPBOARD || true
  pbcopy </dev/null 2>/dev/null || wl-copy --clear 2>/dev/null || true
EOF
