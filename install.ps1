# dsh-prompt-layer — one-line installer for Windows (PowerShell 5.1+)
# Usage:  irm https://cdn.jsdelivr.net/gh/yuuki64/dsh-prompt-layer@main/install.ps1 | iex
# What it does: copies the plugin into your DSH profile, creates an empty prompt
# file, backs up cordis.patch.yml and appends the config. It never deletes anything.
$ErrorActionPreference = 'Stop'

function Fail([string]$msg) { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }
function Step([string]$msg) { Write-Host $msg }

$repoRaw = 'https://raw.githubusercontent.com/yuuki64/dsh-prompt-layer/main'
$repoCdn = 'https://cdn.jsdelivr.net/gh/yuuki64/dsh-prompt-layer@main'

# ---- 1. locate DSH home -----------------------------------------------------
$candidates = @()
if ($env:DSH_HOME) { $candidates += $env:DSH_HOME }
if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.dsh') }
if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'DeepSeek Harness\dsh-home') }
if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness\dsh-home') }
$dshHome = $candidates | Where-Object { $_ -and (Test-Path (Join-Path $_ 'profiles')) } | Select-Object -First 1
if (-not $dshHome) { Fail "DSH data directory not found. Start DeepSeek Harness once, or set DSH_HOME." }
Step "[1/4] DSH home: $dshHome"

# ---- 2. pick profile --------------------------------------------------------
$profileName = $env:PROMPT_LAYER_PROFILE
if (-not $profileName) {
  if (Test-Path (Join-Path $dshHome 'profiles\desktop')) { $profileName = 'desktop' }
  elseif (Test-Path (Join-Path $dshHome 'profiles\web')) { $profileName = 'web' }
}
if (-not $profileName) { Fail "No profile found under $dshHome\profiles." }
$profileDir = Join-Path $dshHome "profiles\$profileName"
if (-not (Test-Path $profileDir)) { Fail "Profile directory missing: $profileDir" }
Step "[2/4] profile: $profileName"

# ---- 3. download the plugin -------------------------------------------------
$target = Join-Path $profileDir 'prompt-layer.mjs'
$downloaded = $false
foreach ($base in @($repoCdn, $repoRaw)) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$base/index.mjs" -OutFile $target -TimeoutSec 30
    $downloaded = $true
    break
  } catch { }
}
if (-not $downloaded) { Fail "Download failed (both jsDelivr and GitHub raw). Check network." }
Step "[3/4] plugin -> $target ($((Get-Item $target).Length) bytes)"

# ---- 4. prompt file + config ------------------------------------------------
$promptFile = Join-Path $dshHome 'prompt-layer.md'
if (-not (Test-Path $promptFile)) {
  New-Item -ItemType File -Path $promptFile | Out-Null
  Step "[4/4] prompt file created (empty): $promptFile"
} else {
  Step "[4/4] prompt file already exists: $promptFile"
}

$yamlPath = Join-Path $profileDir 'cordis.patch.yml'
if (-not (Test-Path $yamlPath)) { New-Item -ItemType File -Path $yamlPath | Out-Null }
$yaml = Get-Content $yamlPath -Raw -Encoding UTF8
if ($null -eq $yaml) { $yaml = '' }

if ($yaml -match '(?m)^\s*-\s*id:\s*prompt-layer\s*$') {
  Step "[ok] prompt-layer is already configured in cordis.patch.yml, skipped."
} else {
  $backup = "$yamlPath.bak-prompt-layer-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $yamlPath $backup
  $pf = ($promptFile -replace '\\', '/')
  $lines = @(
    '',
    '# ---- prompt-layer (added by installer) ----',
    '- insert:',
    '    - id: prompt-layer',
    '      name: ./prompt-layer.mjs',
    '      config:',
    "        promptFile: '$pf'",
    '        order: -100000',
    "        dropBaseline: 'never'",
    '        autoApprove: false',
    '        verbose: false'
  )
  if ($yaml -notmatch '(?m)^\s*-\s*id:\s*system-prompt\s*$') {
    $lines += @(
      '- id: system-prompt',
      '  config:',
      '    includeHarnessIdentity: false',
      "    personaPrefix: ''"
    )
  } else {
    Step "[warn] cordis.patch.yml already has a system-prompt entry; identity strip not added."
  }
  $block = ($lines -join "`n") + "`n"
  [System.IO.File]::AppendAllText($yamlPath, $block, (New-Object System.Text.UTF8Encoding($false)))
  Step "[ok] config appended. backup: $backup"
}

Step ""
Step "Done. Fully quit DeepSeek Harness (tray icon too), reopen it,"
Step "then type /prompt-layer status in chat."
Step "Prompt text file: $promptFile"
