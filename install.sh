#!/usr/bin/env bash
# dsh-prompt-layer — one-line installer for macOS / Linux
# Usage:  curl -fsSL https://cdn.jsdelivr.net/gh/yuuki64/dsh-prompt-layer@main/install.sh | bash
# What it does: copies the plugin into your DSH profile, creates an empty prompt
# file, backs up cordis.patch.yml and appends the config. It never deletes anything.
set -euo pipefail

CDN="https://cdn.jsdelivr.net/gh/yuuki64/dsh-prompt-layer@main"
RAW="https://raw.githubusercontent.com/yuuki64/dsh-prompt-layer/main"

fail() { echo "[x] $1" >&2; exit 1; }

# ---- 1. DSH home ------------------------------------------------------------
home="${DSH_HOME:-$HOME/.dsh}"
[ -d "$home/profiles" ] || fail "DSH data dir not found: $home/profiles (start DeepSeek Harness once, or set DSH_HOME)"
echo "[1/4] DSH home: $home"

# ---- 2. profile -------------------------------------------------------------
profile="${PROMPT_LAYER_PROFILE:-}"
if [ -z "$profile" ]; then
  if [ -d "$home/profiles/desktop" ]; then profile=desktop
  elif [ -d "$home/profiles/web" ]; then profile=web
  fi
fi
[ -n "$profile" ] || fail "no profile under $home/profiles"
pdir="$home/profiles/$profile"
[ -d "$pdir" ] || fail "profile dir missing: $pdir"
echo "[2/4] profile: $profile"

# ---- 3. plugin --------------------------------------------------------------
target="$pdir/prompt-layer.mjs"
if ! curl -fsSL --max-time 30 "$CDN/index.mjs" -o "$target"; then
  curl -fsSL --max-time 30 "$RAW/index.mjs" -o "$target" || fail "download failed (jsDelivr + GitHub raw)"
fi
echo "[3/4] plugin -> $target ($(wc -c < "$target" | tr -d ' ') bytes)"

# ---- 4. prompt file + config ------------------------------------------------
prompt_file="$home/prompt-layer.md"
if [ ! -f "$prompt_file" ]; then
  : > "$prompt_file"
  echo "[4/4] prompt file created (empty): $prompt_file"
else
  echo "[4/4] prompt file already exists: $prompt_file"
fi

yaml="$pdir/cordis.patch.yml"
[ -f "$yaml" ] || : > "$yaml"

if grep -Eq '^[[:space:]]*-[[:space:]]*id:[[:space:]]*prompt-layer[[:space:]]*$' "$yaml"; then
  echo "[ok] prompt-layer already configured, skipped."
else
  backup="$yaml.bak-prompt-layer-$(date +%Y%m%d-%H%M%S)"
  cp "$yaml" "$backup"
  {
    echo ""
    echo "# ---- prompt-layer (added by installer) ----"
    echo "- insert:"
    echo "    - id: prompt-layer"
    echo "      name: ./prompt-layer.mjs"
    echo "      config:"
    echo "        promptFile: '$prompt_file'"
    echo "        order: -100000"
    echo "        dropBaseline: 'never'"
    echo "        autoApprove: false"
    echo "        verbose: false"
    if ! grep -Eq '^[[:space:]]*-[[:space:]]*id:[[:space:]]*system-prompt[[:space:]]*$' "$yaml"; then
      echo "- id: system-prompt"
      echo "  config:"
      echo "    includeHarnessIdentity: false"
      echo "    personaPrefix: ''"
    else
      echo "[warn] cordis.patch.yml already has a system-prompt entry; identity strip not added." >&2
    fi
  } >> "$yaml"
  echo "[ok] config appended. backup: $backup"
fi

echo ""
echo "Done. Fully quit DeepSeek Harness and reopen it, then type /prompt-layer status in chat."
echo "Prompt text file: $prompt_file"
