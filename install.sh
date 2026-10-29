#!/usr/bin/env bash
# dsh-prompt-layer — one-line installer for macOS / Linux
# Usage:  curl -fsSL https://raw.githubusercontent.com/yuuki64/dsh-prompt-layer/main/install.sh | bash
# Installs into every profile found under $DSH_HOME/profiles (desktop, web, ...).
# Creates an empty prompt file, backs up cordis.patch.yml, appends config.
# Never deletes anything.
set -euo pipefail

RAW="https://raw.githubusercontent.com/yuuki64/dsh-prompt-layer/main"
CDN="https://cdn.jsdelivr.net/gh/yuuki64/dsh-prompt-layer@main"

fail() { echo "[x] $1" >&2; exit 1; }

home="${DSH_HOME:-$HOME/.dsh}"
[ -d "$home/profiles" ] || fail "DSH data dir not found: $home/profiles (start DeepSeek Harness once, or set DSH_HOME)"
echo "[1/4] DSH home: $home"

# ---- profiles ---------------------------------------------------------------
profiles=()
if [ -n "${PROMPT_LAYER_PROFILE:-}" ]; then
  profiles=("$PROMPT_LAYER_PROFILE")
else
  for d in "$home"/profiles/*/; do
    [ -d "$d" ] || continue
    [ -f "$d/package.json" ] && profiles+=("$(basename "$d")")
  done
fi
[ ${#profiles[@]} -gt 0 ] || fail "no profile under $home/profiles"
echo "[2/4] profiles: ${profiles[*]}"

# ---- download ---------------------------------------------------------------
tmp="$(mktemp "${TMPDIR:-/tmp}/prompt-layer-XXXXXX.mjs")"
if ! curl -fsSL --max-time 30 "$RAW/index.mjs" -o "$tmp"; then
  curl -fsSL --max-time 30 "$CDN/index.mjs" -o "$tmp" || fail "download failed (GitHub raw + jsDelivr)"
fi
echo "[3/4] plugin downloaded ($(wc -c < "$tmp" | tr -d ' ') bytes)"

# ---- prompt file ------------------------------------------------------------
prompt_file="$home/prompt-layer.md"
if [ ! -f "$prompt_file" ]; then
  : > "$prompt_file"
  echo "[4/4] prompt file created (empty): $prompt_file"
else
  echo "[4/4] prompt file already exists: $prompt_file"
fi

# ---- per profile ------------------------------------------------------------
for profile in "${profiles[@]}"; do
  pdir="$home/profiles/$profile"
  [ -d "$pdir" ] || { echo "[warn] profile dir missing: $pdir" >&2; continue; }
  cp "$tmp" "$pdir/prompt-layer.mjs"
  echo "  - $profile : plugin -> $pdir/prompt-layer.mjs"

  yaml="$pdir/cordis.patch.yml"
  [ -f "$yaml" ] || : > "$yaml"

  if grep -Eq '^[[:space:]]*-[[:space:]]*id:[[:space:]]*prompt-layer[[:space:]]*$' "$yaml"; then
    echo "  - $profile : already configured, skipped"
    continue
  fi

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
    echo "        workspaceFile: '.dsh-prompt-layer.md'"
    echo "        order: -100000"
    echo "        dropBaseline: 'never'"
    echo "        autoApprove: true"
    echo "        forceAsk: true"
    echo "        verbose: false"
    if ! grep -Eq '^[[:space:]]*-[[:space:]]*id:[[:space:]]*system-prompt[[:space:]]*$' "$yaml"; then
      echo "- id: system-prompt"
      echo "  config:"
      echo "    includeHarnessIdentity: false"
      echo "    personaPrefix: ''"
    else
      echo "  - $profile : [warn] system-prompt entry exists, identity strip not added" >&2
    fi
  } >> "$yaml"
  echo "  - $profile : config appended (backup: $(basename "$backup"))"
done

rm -f "$tmp"

echo ""
echo "Done. Fully quit DeepSeek Harness and reopen it, then type /prompt-layer status in chat."
echo "Prompt text file: $prompt_file"
