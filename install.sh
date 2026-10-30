#!/usr/bin/env bash
# dsh-prompt-layer — one-line installer for macOS / Linux
# Usage:  curl -fsSL https://raw.githubusercontent.com/yuuki64/dsh-prompt-layer/main/install.sh | bash
#         PL_FULL=1 ... (same, plus writes the author's prompt.full.md as the prompt file)
# Installs the package into every profile under $DSH_HOME/profiles:
#   <profile>/node_modules/dsh-prompt-layer/{package.json,index.mjs,client.js}
# Creates an empty prompt file, backs up cordis.patch.yml, appends config.
# Never deletes anything.
set -euo pipefail

RAW="https://raw.githubusercontent.com/yuuki64/dsh-prompt-layer/main"
CDN="https://cdn.jsdelivr.net/gh/yuuki64/dsh-prompt-layer@main"
FILES="package.json index.mjs client.js"

fail() { echo "[x] $1" >&2; exit 1; }

home="${DSH_HOME:-$HOME/.dsh}"
[ -d "$home/profiles" ] || fail "DSH data dir not found: $home/profiles (start DeepSeek Harness once, or set DSH_HOME)"
echo "[1/4] DSH home: $home"

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

tmp="$(mktemp -d "${TMPDIR:-/tmp}/prompt-layer-XXXXXX")"
for f in $FILES; do
  if ! curl -fsSL --max-time 30 "$RAW/$f" -o "$tmp/$f"; then
    curl -fsSL --max-time 30 "$CDN/$f" -o "$tmp/$f" || fail "download failed: $f"
  fi
done
echo "[3/4] package downloaded"

prompt_file="$home/prompt-layer.md"
if [ ! -f "$prompt_file" ]; then
  : > "$prompt_file"
  echo "[4/4] prompt file created (empty): $prompt_file"
else
  echo "[4/4] prompt file already exists: $prompt_file"
fi

for profile in "${profiles[@]}"; do
  pdir="$home/profiles/$profile"
  [ -d "$pdir" ] || { echo "[warn] profile dir missing: $pdir" >&2; continue; }

  pkg="$pdir/node_modules/dsh-prompt-layer"
  mkdir -p "$pkg"
  for f in $FILES; do cp "$tmp/$f" "$pkg/$f"; done
  echo "  - $profile : package -> $pkg"

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
    echo "      name: dsh-prompt-layer"
    echo "      config:"
    echo "        promptFile: '$prompt_file'"
    echo "        workspaceFile: '.dsh-prompt-layer.md'"
    echo "        order: -100000"
    echo "        dropBaseline: 'never'"
    echo "        tailFrom: head"
    echo "        # neutralize: 'reminders'"
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

# optional: install the author's full prompt text
# Enabled by:  PL_FULL=1   or   PL_PROMPT_URL='https://.../prompt.md'
if [ -n "${PL_FULL:-}" ] || [ -n "${PL_PROMPT_URL:-}" ]; then
  srcs=""
  if [ -n "${PL_PROMPT_URL:-}" ]; then srcs="$PL_PROMPT_URL"; fi
  srcs="$srcs $RAW/prompt.full.md $CDN/prompt.full.md"
  got=""
  for u in $srcs; do
    if curl -fsSL --max-time 30 "$u" -o "$tmp/prompt.full.md" 2>/dev/null; then got=1; break; fi
  done
  if [ -z "$got" ]; then
    echo "[warn] full prompt download failed; prompt file left as-is" >&2
  elif [ -s "$prompt_file" ] && cmp -s "$prompt_file" "$tmp/prompt.full.md"; then
    echo "  - full prompt already up to date"
  else
    if [ -s "$prompt_file" ]; then
      cp "$prompt_file" "$prompt_file.bak-$(date +%Y%m%d-%H%M%S)"
      echo "  - prompt file backed up"
    fi
    cp "$tmp/prompt.full.md" "$prompt_file"
    echo "[5/5] full prompt installed: $(wc -c < "$prompt_file" | tr -d ' ') bytes -> $prompt_file"
  fi
fi

rm -rf "$tmp"

echo ""
echo "Done. Fully quit DeepSeek Harness and reopen it, then type /prompt-layer status"
echo "(or click the PL button at the bottom-right)."
echo "Prompt text file: $prompt_file"
