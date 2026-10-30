<#
  One-time cloud configuration — run it YOURSELF so that no AI tool ever handles
  your API keys. It never prints secrets except the host access code, which it
  shows once on your own screen and saves to .secrets/host-access-code.txt
  (gitignored).

  Before running:
    1. `lk cloud auth`                     (links the LiveKit CLI to your LiveKit Cloud project)
    2. Have a Gemini API key ready. If translator/.env.local has no GEMINI_API_KEY,
       the script asks for it (masked input) and saves it there. Optional in that
       file: OPENAI_API_KEY (backup provider) and LIVEKIT_URL / LIVEKIT_API_KEY /
       LIVEKIT_API_SECRET; when those are empty, the project linked by
       `lk cloud auth` is used (or -LiveKitProject <name>).
    3. The Vercel project is linked (repo has .vercel/project.json) and has DATABASE_URL
       (Vercel dashboard -> Storage -> Create Database -> Neon, Frankfurt region).

  What it does:
    - Generates INTERNAL_API_SECRET, APP_SECRET, CRON_SECRET and a HOST_ACCESS_CODE.
    - Sets LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET and those secrets on Vercel
      (production + preview) as sensitive variables.
    - Creates (first run) or updates the LiveKit Cloud agent in eu-central (Frankfurt)
      with GEMINI_API_KEY, OPENAI_API_KEY, CONTROL_PLANE_URL and INTERNAL_API_SECRET.
    - Deploys the web app to production and checks /api/health.

  Usage (Windows PowerShell 5.1 or 7):
    powershell -ExecutionPolicy Bypass -File scripts\configure-cloud.ps1 -AppUrl https://<your-app>.vercel.app [-HostCode <code>]
#>
param(
  [Parameter(Mandatory = $true)][string]$AppUrl,
  [string]$HostCode = "",
  [string]$LiveKitProject = "",
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

# LiveKit credentials: translator/.env.local if filled in, otherwise the project
# linked with `lk cloud auth` (stored by the LiveKit CLI on this PC). Values are
# never printed.
if (-not ($worker["LIVEKIT_URL"] -and $worker["LIVEKIT_API_KEY"] -and $worker["LIVEKIT_API_SECRET"])) {
  $projects = (& $lk project list --json | Out-String | ConvertFrom-Json) | ForEach-Object { $_ }
  $cliConfig = Join-Path $env:USERPROFILE ".livekit\cli-config.yaml"
  $default = ""
  if (Test-Path $cliConfig) {
    $m = Select-String -Path $cliConfig -Pattern '^\s*default_project:\s*(\S+)' | Select-Object -First 1
    if ($m) { $default = $m.Matches[0].Groups[1].Value.Trim('"') }
  }
  $chosen = if ($LiveKitProject) { $projects | Where-Object { $_.Name -eq $LiveKitProject } }
            elseif ($default) { $projects | Where-Object { $_.Name -eq $default } }
            else { $projects | Select-Object -First 1 }
  $chosen = $chosen | Select-Object -First 1
  if (-not $chosen -or -not $chosen.APIKey -or -not $chosen.APISecret) {
    throw "No LiveKit credentials: fill translator/.env.local or run 'lk cloud auth' first"
  }
  Write-Host "Using LiveKit project '$($chosen.Name)' linked with 'lk cloud auth'."
  $worker["LIVEKIT_URL"] = $chosen.URL
  $worker["LIVEKIT_API_KEY"] = $chosen.APIKey
  $worker["LIVEKIT_API_SECRET"] = $chosen.APISecret
}
if (-not $worker["GEMINI_API_KEY"]) {
  # Ask for the key in this terminal (input is masked) and save it to translator/.env.local.
  Write-Host ""
  Write-Host "Paste your Gemini API key (from https://aistudio.google.com/apikey) and press Enter."
  Write-Host "It shows as *** and is saved only to translator/.env.local on this PC."
  $secure = Read-Host -AsSecureString "Gemini API key"
  $plain = ([System.Net.NetworkCredential]::new("", $secure).Password).Trim().Trim('"')
  if (-not $plain) { throw "No Gemini key entered" }
  $envPath = Join-Path $repo "translator\.env.local"
  $out = New-Object System.Collections.Generic.List[string]
  $replaced = $false
  if (Test-Path $envPath) {
    foreach ($line in Get-Content $envPath) {
      if (-not $replaced -and $line -match '^\s*GEMINI_API_KEY\s*=') { $out.Add("GEMINI_API_KEY=$plain"); $replaced = $true }
      else { $out.Add($line) }
    }
  }
  if (-not $replaced) { $out.Add("GEMINI_API_KEY=$plain") }
  [System.IO.File]::WriteAllLines($envPath, $out, (New-Object System.Text.UTF8Encoding $false))
  $worker["GEMINI_API_KEY"] = $plain
  Write-Host "Saved to translator/.env.local."
}

# Check the Gemini key and model before deploying anything (prints only the outcome).
$geminiModel = if ($worker["GEMINI_MODEL"]) { $worker["GEMINI_MODEL"] } else { "gemini-3.5-live-translate-preview" }
try {
  Invoke-RestMethod -Uri "https://generativelanguage.googleapis.com/v1beta/models/$geminiModel" `
    -Headers @{ "x-goog-api-key" = $worker["GEMINI_API_KEY"] } -TimeoutSec 20 | Out-Null
  Write-Host "Gemini key check: OK ($geminiModel is available to this key)."
} catch {
  $code = 0
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  if ($code -in 400, 401, 403) {
    throw "Google rejected the Gemini key (HTTP $code). Create a new key at https://aistudio.google.com/apikey and run this script again; it will ask for the key if you first empty the GEMINI_API_KEY= line in translator/.env.local."
  }
  Write-Warning "Could not confirm the Gemini model (HTTP ${code}: $($_.Exception.Message)). Continuing."
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
) | Set-Content -Encoding ascii (Join-Path $state "generated.env")
Set-Content -Encoding ascii (Join-Path $state "host-access-code.txt") $HostCode

# ---------------------------------------------------------------- Vercel env
function Set-VercelEnv($name, $value, [switch]$Plain) {
  foreach ($target in "production", "preview") {
    # --value (not a stdin pipe): Windows PowerShell 5.1 would append a newline to piped values.
    $flags = @("env", "add", $name, $target, "--value", $value, "--force", "--yes")
    if (-not $Plain) { $flags += "--sensitive" }
    vercel @flags | Out-Null
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
