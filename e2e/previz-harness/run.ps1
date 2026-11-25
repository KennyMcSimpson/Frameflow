$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')
$prefix = if ($args.Count -gt 0) { $args[0] } else { 'after' }
& node_modules\.bin\esbuild.cmd e2e/previz-harness/harness.mjs --bundle --format=iife --log-level=warning --outfile=e2e/previz-harness/build/harness.js
if ($LASTEXITCODE -ne 0) { exit 1 }
& node_modules\.bin\electron.cmd e2e/previz-harness/main.cjs $prefix
