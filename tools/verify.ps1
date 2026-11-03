﻿# 提交前自检：跑全部自动化断言，任何一条失败就返回非零
# 用法：powershell -ExecutionPolicy Bypass -File tools\verify.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

$suites = @(
    @{ name = "算法回归";        file = "test/test-core.mjs" },
    @{ name = "成品模式回归";    file = "test/test-strong.mjs" },
    @{ name = "静态一致性";      file = "test/test-static.mjs" }
)

$failed = @()
foreach ($s in $suites) {
    Write-Host ("== {0} ==" -f $s.name)
    & node $s.file
    if ($LASTEXITCODE -ne 0) { $failed += $s.name }
}

Write-Host ""
if ($failed.Count -gt 0) {
    Write-Host ("× 失败: {0}" -f ($failed -join ", "))
    Pop-Location
    exit 1
}
Write-Host "√ 全部通过"
Pop-Location
