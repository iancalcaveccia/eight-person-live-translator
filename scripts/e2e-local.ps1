<#
  Runs the full local stack and the browser E2E suite:
    livekit-server --dev  ->  Python worker (TRANSLATION_PROVIDER=mock)  ->  web app (E2E build)
  and then `playwright test` against it with the installed Chrome.

  Requirements: livekit-server binary (LIVEKIT_SERVER_BIN or tools path), uv, pnpm, Chrome.
  Usage:  pwsh scripts/e2e-local.ps1 [-SkipBuild] [-Grep "<test name filter>"]
#>
param(
  [switch]$SkipBuild,
  [string]$Grep = ""
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$lkBin = if ($env:LIVEKIT_SERVER_BIN) { $env:LIVEKIT_SERVER_BIN } else { "C:\Users\ianca\tools\livekit-server\livekit-server.exe" }
$uvPython = if ($env:UV_PYTHON_BIN) { $env:UV_PYTHON_BIN } else { "C:\Users\ianca\AppData\Roaming\uv\python\cpython-3.13.18-windows-x86_64-none\python.exe" }
if (-not $env:UV_PROJECT_ENVIRONMENT) { $env:UV_PROJECT_ENVIRONMENT = "C:\Users\ianca\.venvs\eight-person-translator" }
$venvPython = Join-Path $env:UV_PROJECT_ENVIRONMENT "Scripts\python.exe"

$logs = Join-Path $repo "test-results\logs"
New-Item -ItemType Directory -Force $logs | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

$common = @{
  LIVEKIT_URL         = "ws://127.0.0.1:7880"
  LIVEKIT_API_KEY     = "devkey"
  LIVEKIT_API_SECRET  = "secret"
  INTERNAL_API_SECRET = "e2e-internal-secret"
}
foreach ($k in $common.Keys) { Set-Item "env:$k" $common[$k] }

$procs = @()
function Stop-All {
  foreach ($p in $script:procs) { if ($p -and -not $p.HasExited) { & taskkill /PID $p.Id /T /F 2>$null | Out-Null } }
}

try {
  if (-not (Test-Path "tests\e2e\fixtures\monologue_30s.wav")) { & "$repo\tests\e2e\make-fixtures.ps1" }

  # 1. LiveKit SFU (dev keys devkey/secret)
  $procs += Start-Process $lkBin -ArgumentList "--dev", "--bind", "127.0.0.1" -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput "$logs\livekit-$stamp.log" -RedirectStandardError "$logs\livekit-$stamp.err.log"

  # 2. Web app (E2E build exposes window.__mesa inspection hooks)
  $env:NEXT_PUBLIC_E2E_HOOKS = "1"
  $env:HOST_ACCESS_CODE = "e2e-host-code"
  $env:APP_SECRET = "e2e-app-secret"
  $env:PGLITE_DIR = ".data/e2e-$stamp"
  $env:GATHERING_IDLE_END_MINUTES = "30"
  if (-not $SkipBuild) { pnpm exec next build | Out-File "$logs\build-$stamp.log" }
  $procs += Start-Process "cmd.exe" -ArgumentList "/c", "pnpm exec next start -p 3100 -H 127.0.0.1" -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput "$logs\web-$stamp.log" -RedirectStandardError "$logs\web-$stamp.err.log"

  # 3. Translator worker with the deterministic mock provider
  $env:TRANSLATION_PROVIDER = "mock"
  $env:CONTROL_PLANE_URL = "http://127.0.0.1:3100"
  $env:AGENT_IDLE_PROCESSES = "3"
  $env:AGENT_LOAD_THRESHOLD = "0.99"
  $env:AGENT_IGNORE_HOST_LOAD = "1"
  $procs += Start-Process "uv" -ArgumentList "run", "--python", $uvPython, "python", "src/agent.py", "start" -WorkingDirectory "$repo\translator" `
    -PassThru -WindowStyle Hidden -RedirectStandardOutput "$logs\worker-$stamp.log" -RedirectStandardError "$logs\worker-$stamp.err.log"

  # Wait for the web app
  $deadline = (Get-Date).AddSeconds(90)
  do {
    Start-Sleep -Milliseconds 800
    try { $ok = (Invoke-WebRequest "http://127.0.0.1:3100/api/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $ok = $false }
  } until ($ok -or (Get-Date) -gt $deadline)
  if (-not $ok) { throw "web app did not become healthy; see $logs" }
  Start-Sleep -Seconds 4 # let the worker register with LiveKit

  $env:E2E_BASE_URL = "http://127.0.0.1:3100"
  $env:E2E_HOST_CODE = "e2e-host-code"
  $env:E2E_PYTHON = $venvPython
  $pwArgs = @("exec", "playwright", "test")
  if ($Grep) { $pwArgs += @("-g", $Grep) }
  & pnpm @pwArgs
  $code = $LASTEXITCODE
  Write-Output "Logs: $logs (stamp $stamp)"
  exit $code
}
finally {
  Stop-All
}
