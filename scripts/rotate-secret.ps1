<#
.SYNOPSIS
    生成随机 URL-safe 密码，并写入 Cloudflare Worker Secret SUB_STORE_FRONTEND_BACKEND_PATH。

.DESCRIPTION
    - 使用加密安全随机数生成密码
    - 自动加上 / 前缀，符合 SUB_STORE_FRONTEND_BACKEND_PATH 格式
    - 通过管道传给 wrangler secret put，密码不写入磁盘
    - 可选：复制到剪贴板，方便前端粘贴

.PARAMETER Length
    密码字符长度（不含开头的 /），默认 32。

.PARAMETER NoClipboard
    指定后不复制到剪贴板。

.PARAMETER WorkerName
    Worker 名称，默认读取 wrangler.toml 配置（不传即由 wrangler 自行解析）。

.EXAMPLE
    ./scripts/rotate-secret.ps1
    生成 32 位密码并写入 Secret，同时复制到剪贴板。

.EXAMPLE
    ./scripts/rotate-secret.ps1 -Length 48 -NoClipboard
    生成 48 位密码并写入 Secret，不复制到剪贴板。
#>
[CmdletBinding()]
param(
    [int]$Length = 32,
    [switch]$NoClipboard,
    [string]$WorkerName
)

$ErrorActionPreference = 'Stop'

if ($Length -lt 16) {
    throw "密码长度不能小于 16 位。"
}

# 生成 URL-safe 随机字符串
$alphabet = ([char[]](48..57) + [char[]](65..90) + [char[]](97..122))
$bytes = New-Object byte[] ($Length * 2)
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$chars = foreach ($b in $bytes) { $alphabet[$b % $alphabet.Length] }
$path = '/' + (-join $chars[0..($Length - 1)])

Write-Host "[rotate-secret] 已生成新密码，长度 $($path.Length) 位（含 /）" -ForegroundColor Cyan

# 复制到剪贴板（可选）
function Copy-ToClipboard {
    param([string]$Value)
    # 优先使用 Windows 自带的 clip.exe，兼容各种 shell 启动方式
    $clip = Get-Command clip.exe -ErrorAction SilentlyContinue
    if ($clip) {
        $Value | & $clip.Path
        return ($LASTEXITCODE -eq 0)
    }
    try {
        Set-Clipboard -Value $Value
        return $true
    } catch {
        return $false
    }
}

if (-not $NoClipboard) {
    if (Copy-ToClipboard -Value $path) {
        Write-Host "[rotate-secret] 已复制到剪贴板，请尽快粘贴到前端配置后清空剪贴板" -ForegroundColor Yellow
    } else {
        Write-Warning "未能复制到剪贴板，请手动从下方提示中复制 path 值"
    }
}

# 通过管道写入 Cloudflare Worker Secret
$wranglerArgs = @('wrangler', 'secret', 'put', 'SUB_STORE_FRONTEND_BACKEND_PATH')
if ($WorkerName) {
    $wranglerArgs += @('--name', $WorkerName)
}

Write-Host "[rotate-secret] 调用 npx $($wranglerArgs -join ' ')" -ForegroundColor Cyan
$path | & npx @wranglerArgs

if ($LASTEXITCODE -ne 0) {
    throw "wrangler secret put 失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "[rotate-secret] Secret 已更新。" -ForegroundColor Green
Write-Host "请同步更新以下位置：" -ForegroundColor Green
Write-Host "  1. 前端后端地址：https://<your-worker-domain>$path"
Write-Host "  2. GitHub Actions Secret：SUB_STORE_PASSWORD_VALUE"
Write-Host ""
Write-Host "粘贴完成后，请清空剪贴板：" -ForegroundColor DarkYellow
Write-Host "  Set-Clipboard -Value `$null"
