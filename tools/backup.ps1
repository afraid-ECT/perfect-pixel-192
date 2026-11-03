# 备份脚本：把整个项目（含 .git 提交历史）打成一个带时间戳的 tar.gz
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\backup.ps1
#   powershell -ExecutionPolicy Bypass -File tools\backup.ps1 -Dest "E:\备份" -Keep 10
#
# 还原：tar -xzf perfect-pixel-192_2026-11-03_1638.tar.gz
#
# 说明：用 tar 而不是 Compress-Archive，因为 PowerShell 5.1 打出的 zip
# 条目名用反斜杠（.git\HEAD），在 macOS/Linux 上解压会变成奇怪的文件名。

param(
    [string]$Dest = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "_backups"),
    [int]$Keep = 20
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$name = Split-Path -Leaf $root
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"

if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest -Force | Out-Null }
$out = Join-Path $Dest ("{0}_{1}.tar.gz" -f $name, $stamp)

Push-Location (Split-Path -Parent $root)
try {
    tar -czf $out --exclude=.build --exclude=node_modules $name
    if ($LASTEXITCODE -ne 0) { throw ("tar 打包失败（退出码 {0}）" -f $LASTEXITCODE) }
}
finally { Pop-Location }

$entries = @(tar -tzf $out)
$gitCount = @($entries | Where-Object { $_ -match "/\.git/(HEAD|config|refs)" }).Count
$sizeKb = [math]::Round((Get-Item $out).Length / 1kb, 1)

Get-ChildItem $Dest -Filter ("{0}_*.tar.gz" -f $name) |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $Keep |
    Remove-Item -Force

Write-Host ("备份完成：{0}" -f $out)
Write-Host ("  {0} 个条目，{1} KB，含 .git 历史：{2}" -f $entries.Count, $sizeKb, ($gitCount -gt 0))
Write-Host ("  还原用：tar -xzf `"{0}`"" -f $out)
