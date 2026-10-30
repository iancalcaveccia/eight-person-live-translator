<#
  One-time cloud configuration — run it YOURSELF so that no AI tool ever handles
  your API keys. It never prints secrets except the host access code, which it
  shows once on your own screen and saves to .secrets/host-access-code.txt
  (gitignored).

  Before running:
    1. `lk cloud auth`                     (links the LiveKit CLI to your LiveKit Cloud project)
    2. Fill translator/.env.local with:
         LIVEKIT_URL=wss://<project>.livekit.cloud
         LIVEKIT_API_KEY=...
         LIVEKIT_API_SECRET=...
         GEMINI_API_KEY=...
         OPENAI_API_KEY=...                (optional backup provider)
    3. The Vercel project is linked (repo has .vercel/project.json) and has DATABASE_URL
       (Vercel dashboard -> Storage -> Create Database -> Neon, Frankfurt region).

  What it does:
    - Generates INTERNAL_API_SECRET, APP_SECRET, CRON_SECRET and a HOST_ACCESS_CODE.
    - Sets LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET and those secrets on Vercel
      (production + preview) as sensitive variables.
    - Creates (first run) or updates the LiveKit Cloud agent in eu-central (Frankfurt)
      with GEMINI_API_KEY, OPENAI_API_KEY, CONTROL_PLANE_URL and INTERNAL_API_SECRET.
    - Deploys the web app to production and checks /api/health.

  Usage:  pwsh scripts/configure-cloud.ps1 -AppUrl https://<your-app>.vercel.app [-HostCode <code>]
#>
param(
  [Parameter(Mandatory = $true)][string]$AppUrl,
  [string]$HostCode = "",
  [switch]$SkipWebDeploy
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$lk = (Get-Command lk -ErrorAction SilentlyContinue).Source
if (-not $lk) { $lk = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\LiveKit.LiveKitCLI_Microsoft.Winget.Source_8wekyb3d8bbwe\lk.exe" }
$AppUrl = $AppUrl.TrimEnd("/")

function Read-EnvFile($path) {
  $map = @{}
  if (-not (Test-Path $path)) { return $map }
  foreach ($line in Get-Content $path) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $i = $line.IndexOf("=")
    $map[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim().Trim('"')
  }
  return $map
}

function New-Secret([int]$bytes = 32) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return [Convert]::ToBase64String($b).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

$worker = Read-EnvFile "translator/.env.local"
foreach ($k in "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "GEMINI_API_KEY") {
  if (-not $worker[$k]) { throw "translator/.env.local is missing $k" }
}

# Reuse previously generated secrets so re-running does not break the running agent.
$state = Join-Path $repo ".secrets"
New-Item -ItemType Directory -Force $state | Out-Null
$saved = Read-EnvFile (Join-Path $state "generated.env")
$internal = if ($saved["INTERNAL_API_SECRET"]) { $saved["INTERNAL_API_SECRET"] } else { New-Secret }
$appSecret = if ($saved["APP_SECRET"]) { $saved["APP_SECRET"] } else { New-Secret }
$cron = if ($saved["CRON_SECRET"]) { $saved["CRON_SECRET"] } else { New-Secret }
if (-not $HostCode) { $HostCode = if ($saved["HOST_ACCESS_CODE"]) { $saved["HOST_ACCESS_CODE"] } else { (New-Secret 9) } }
@(
  "INTERNAL_API_SECRET=$internal",
  "APP_SECRET=$appSecret",
  "CRON_SECRET=$cron",
  "HOST_ACCESS_CODE=$HostCode"
) | Set-Content -Encoding utf8 (Join-Path $state "generated.env")
Set-Content -Encoding utf8 (Join-Path $state "host-access-code.txt") $HostCode

# ---------------------------------------------------------------- Vercel env
function Set-VercelEnv($name, $value, [switch]$Plain) {
  foreach ($target in "production", "preview") {
    $flags = @("env", "add", $name, $target, "--force", "--yes")
    if (-not $Plain) { $flags += "--sensitive" }
    $value | vercel @flags | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "vercel env add $name $target failed" }
  }
  Write-Host "  set $name"
}
Write-Host "Configuring Vercel environment variables…"
Set-VercelEnv "LIVEKIT_URL" $worker["LIVEKIT_URL"] -Plain
Set-VercelEnv "LIVEKIT_API_KEY" $worker["LIVEKIT_API_KEY"]
Set-VercelEnv "LIVEKIT_API_SECRET" $worker["LIVEKIT_API_SECRET"]
Set-VercelEnv "INTERNAL_API_SECRET" $internal
Set-VercelEnv "APP_SECRET" $appSecret
Set-VercelEnv "CRON_SECRET" $cron
Set-VercelEnv "HOST_ACCESS_CODE" $HostCode
Set-VercelEnv "NEXT_PUBLIC_APP_URL" $AppUrl -Plain
$envList = (vercel env ls production 2>&1) -join "`n"
if ($envList -notmatch "DATABASE_URL") {
  Write-Warning "DATABASE_URL is not set on Vercel. Create a Neon database (Vercel -> Storage) or run: vercel env add DATABASE_URL production --sensitive"
}

# ---------------------------------------------------------------- LiveKit agent
$tmp = New-TemporaryFile
try {
  $lines = @(
    "GEMINI_API_KEY=$($worker['GEMINI_API_KEY'])",
    "CONTROL_PLANE_URL=$AppUrl",
    "INTERNAL_API_SECRET=$internal",
    "TRANSLATION_PROVIDER=gemini"
  )
  if ($worker["OPENAI_API_KEY"]) { $lines += "OPENAI_API_KEY=$($worker['OPENAI_API_KEY'])" }
  $lines | Set-Content -Encoding ascii $tmp
  Push-Location translator
  try {
    if (Test-Path "livekit.toml") {
      Write-Host "Updating LiveKit agent secrets and deploying…"
      & $lk agent update-secrets --secrets-file $tmp
      & $lk agent deploy
    } else {
      Write-Host "Creating LiveKit agent in eu-central (Frankfurt)…"
      & $lk agent create --region eu-central --secrets-file $tmp .
    }
    if ($LASTEXITCODE -ne 0) { throw "LiveKit agent deployment failed" }
    & $lk agent status
  } finally { Pop-Location }
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- web deploy
if (-not $SkipWebDeploy) {
  Write-Host "Deploying web app to production…"
  vercel deploy --prod --yes | Out-Host
}
Start-Sleep -Seconds 5
try {
  $health = Invoke-RestMethod "$AppUrl/api/health" -TimeoutSec 20
  Write-Host ("Health: database={0} livekit={1} internalApi={2} hostCode={3}" -f $health.database, $health.livekit, $health.internalApi, $health.hostCode)
} catch {
  Write-Warning "Health check failed: $($_.Exception.Message)"
}
Write-Host ""
Write-Host "Host access code (needed to create a gathering): $HostCode"
Write-Host "Also saved to .secrets/host-access-code.txt (never committed)."
