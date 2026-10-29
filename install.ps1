# dsh-prompt-layer — one-line installer for Windows (PowerShell 5.1+)
# Usage:  irm https://raw.githubusercontent.com/yuuki64/dsh-prompt-layer/main/install.ps1 | iex
# Installs into every profile found under $DSH_HOME/profiles (desktop, web, ...).
# Creates an empty prompt file, backs up cordis.patch.yml, appends config.
# Never deletes anything.
$ErrorActionPreference = 'Stop'

function Fail([string]$msg) { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }
function Step([string]$msg) { Write-Host $msg }

$repoRaw = 'https://raw.githubusercontent.com/yuuki64/dsh-prompt-layer/main'
$repoCdn = 'https://cdn.jsdelivr.net/gh/yuuki64/dsh-prompt-layer@main'

# ---- 1. DSH home ------------------------------------------------------------
$candidates = @()
if ($env:DSH_HOME) { $candidates += $env:DSH_HOME }
if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.dsh') }
if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'DeepSeek Harness\dsh-home') }
if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness\dsh-home') }
$dshHome = $candidates | Where-Object { $_ -and (Test-Path (Join-Path $_ 'profiles')) } | Select-Object -First 1
if (-not $dshHome) { Fail "DSH data directory not found. Start DeepSeek Harness once, or set DSH_HOME." }
Step "[1/4] DSH home: $dshHome"

# ---- 2. profiles (all of them) ---------------------------------------------
$profiles = @()
$want = $env:PROMPT_LAYER_PROFILE
if ($want) {
  $profiles = @($want)
} else {
  $profiles = @(Get-ChildItem (Join-Path $dshHome 'profiles') -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } |
    ForEach-Object { $_.Name })
}
if ($profiles.Count -eq 0) { Fail "No profile found under $dshHome\profiles." }
Step ("[2/4] profiles: " + ($profiles -join ', '))

# ---- 3. download the plugin ------------------------------------------------
$tmp = Join-Path $env:TEMP ("prompt-layer-" + [guid]::NewGuid().ToString('N') + ".mjs")
$downloaded = $false
foreach ($base in @($repoRaw, $repoCdn)) {
  try { Invoke-WebRequest -UseBasicParsing -Uri "$base/index.mjs" -OutFile $tmp -TimeoutSec 30; $downloaded = $true; break } catch { }
}
if (-not $downloaded) { Fail "Download failed (GitHub raw and jsDelivr). Check network." }
Step "[3/4] plugin downloaded ($((Get-Item $tmp).Length) bytes)"

# ---- 4. per profile: copy plugin + config ----------------------------------
$promptFile = Join-Path $dshHome 'prompt-layer.md'
if (-not (Test-Path $promptFile)) {
  New-Item -ItemType File -Path $promptFile | Out-Null
  Step "[4/4] prompt file created (empty): $promptFile"
} else {
  Step "[4/4] prompt file already exists: $promptFile"
}
$pf = ($promptFile -replace '\\', '/')

foreach ($profile in $profiles) {
  $pdir = Join-Path $dshHome ("profiles\" + $profile)
  if (-not (Test-Path $pdir)) { Step "[warn] profile dir missing: $pdir"; continue }
  Copy-Item $tmp (Join-Path $pdir 'prompt-layer.mjs') -Force
  Step "  - $profile : plugin -> $(Join-Path $pdir 'prompt-layer.mjs')"

  $yamlPath = Join-Path $pdir 'cordis.patch.yml'
  if (-not (Test-Path $yamlPath)) { New-Item -ItemType File -Path $yamlPath | Out-Null }
  $yaml = Get-Content $yamlPath -Raw -Encoding UTF8
  if ($null -eq $yaml) { $yaml = '' }

  if ($yaml -match '(?m)^\s*-\s*id:\s*prompt-layer\s*$') {
    Step "  - $profile : already configured, skipped"
    continue
  }

  $backup = "$yamlPath.bak-prompt-layer-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $yamlPath $backup

  $lines = @(
    '',
    '# ---- prompt-layer (added by installer) ----',
    '- insert:',
    '    - id: prompt-layer',
    '      name: ./prompt-layer.mjs',
    '      config:',
    "        promptFile: '$pf'",
    "        workspaceFile: '.dsh-prompt-layer.md'",
    '        order: -100000',
    "        dropBaseline: 'never'",
    '        autoApprove: true',
    '        forceAsk: true',
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
    Step "  - $profile : [warn] system-prompt entry exists, identity strip not added"
  }
  $block = ($lines -join "`n") + "`n"
  [System.IO.File]::AppendAllText($yamlPath, $block, (New-Object System.Text.UTF8Encoding($false)))
  Step "  - $profile : config appended (backup: $(Split-Path $backup -Leaf))"
}

Remove-Item $tmp -Force -ErrorAction SilentlyContinue

Step ""
Step "Done. Fully quit DeepSeek Harness (tray icon too), reopen it,"
Step "then type /prompt-layer status in chat."
Step "Prompt text file: $promptFile"
