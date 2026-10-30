# dsh-prompt-layer - one-line installer for Windows (PowerShell 5.1+)
# Usage:  irm https://raw.githubusercontent.com/yuuki64/dsh-prompt-layer/main/install.ps1 | iex
#         $env:PL_FULL=1; irm ... | iex   (same, plus writes the author's prompt.full.md)
#         $env:PL_PROMPT_URL='https://.../x.md'; irm ... | iex   (use any prompt text file)
# Installs the package into every profile found under $DSH_HOME/profiles (desktop, web, ...):
#   <profile>/node_modules/dsh-prompt-layer/{package.json,index.mjs,client.js}
# Creates an empty prompt file, backs up cordis.patch.yml, appends config.
# Never deletes anything.
$ErrorActionPreference = 'Stop'

function Fail([string]$msg) { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }
function Step([string]$msg) { Write-Host $msg }

# Windows PowerShell 5.1 sometimes still defaults to TLS 1.0 against GitHub.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol
} catch { }
$ProgressPreference = 'SilentlyContinue'

$repoRaw = 'https://raw.githubusercontent.com/yuuki64/dsh-prompt-layer/main'
$repoCdn = 'https://cdn.jsdelivr.net/gh/yuuki64/dsh-prompt-layer@main'
$files = @('package.json', 'index.mjs', 'client.js')

# ---- 1. DSH home ------------------------------------------------------------
$candidates = @()
if ($env:DSH_HOME) { $candidates += $env:DSH_HOME }
if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.dsh') }
if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'DeepSeek Harness\dsh-home') }
if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness\dsh-home') }
$dshHome = $candidates | Where-Object { $_ -and (Test-Path (Join-Path $_ 'profiles')) } | Select-Object -First 1
if (-not $dshHome) { Fail "DSH data directory not found. Start DeepSeek Harness once, or set DSH_HOME." }
Step "[1/4] DSH home: $dshHome"

# ---- 2. profiles ------------------------------------------------------------
if ($env:PROMPT_LAYER_PROFILE) {
  $profiles = @($env:PROMPT_LAYER_PROFILE)
} else {
  $profiles = @(Get-ChildItem (Join-Path $dshHome 'profiles') -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } |
    ForEach-Object { $_.Name })
}
if ($profiles.Count -eq 0) { Fail "No profile found under $dshHome\profiles." }
Step ("[2/4] profiles: " + ($profiles -join ', '))

# ---- 3. download ------------------------------------------------------------
$tmp = Join-Path $env:TEMP ("prompt-layer-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
foreach ($file in $files) {
  $ok = $false
  foreach ($base in @($repoRaw, $repoCdn)) {
    try { Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile (Join-Path $tmp $file) -TimeoutSec 30; $ok = $true; break } catch { }
  }
  if (-not $ok) { Fail "Download failed: $file (GitHub raw and jsDelivr)." }
}
Step "[3/4] package downloaded ($((Get-ChildItem $tmp).Count) files)"

# ---- 4. install per profile -------------------------------------------------
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

  $pkgDir = Join-Path $pdir 'node_modules\dsh-prompt-layer'
  New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null
  foreach ($file in $files) { Copy-Item (Join-Path $tmp $file) (Join-Path $pkgDir $file) -Force }
  Step "  - $profile : package -> $pkgDir"

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
    '      name: dsh-prompt-layer',
    '      config:',
    "        promptFile: '$pf'",
    "        workspaceFile: '.dsh-prompt-layer.md'",
    '        order: -100000',
    "        dropBaseline: 'never'",
    '        tailFrom: head',
    "        # neutralize: 'reminders'   # uncomment to strip host injection blocks",
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

# ---- 5. optional: install the author's full prompt text ---------------------
# Enabled by:  $env:PL_FULL=1   or   $env:PL_PROMPT_URL='https://.../prompt.md'
if ($env:PL_FULL -or $env:PL_PROMPT_URL) {
  $srcs = @()
  if ($env:PL_PROMPT_URL) { $srcs += $env:PL_PROMPT_URL }
  $srcs += @("$repoRaw/prompt.full.md", "$repoCdn/prompt.full.md")
  $dl = Join-Path $tmp 'prompt.full.md'
  $ok = $false
  foreach ($u in $srcs) {
    try { Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $dl -TimeoutSec 30; $ok = $true; break } catch { }
  }
  if (-not $ok) {
    Step "[warn] full prompt download failed; prompt file left as-is"
  } elseif ((Test-Path $promptFile) -and ((Get-FileHash $promptFile).Hash -eq (Get-FileHash $dl).Hash)) {
    Step "  - full prompt already up to date"
  } else {
    if ((Test-Path $promptFile) -and ((Get-Item $promptFile).Length -gt 0)) {
      $pbak = "$promptFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
      Copy-Item $promptFile $pbak
      Step "  - prompt file backed up: $(Split-Path $pbak -Leaf)"
    }
    Copy-Item $dl $promptFile -Force
    Step ("[5/5] full prompt installed: " + (Get-Item $promptFile).Length + " bytes -> $promptFile")
  }
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Step ""
Step "Done. Fully quit DeepSeek Harness (tray icon too), reopen it,"
Step "then type /prompt-layer status in chat (or click the PL button bottom-right)."
Step "Prompt text file: $promptFile"
