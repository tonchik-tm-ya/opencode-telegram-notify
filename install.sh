#!/usr/bin/env bash
# Install the telegram-notify plugin for opencode.
#
# Usage:
#   curl -sL https://raw.githubusercontent.com/tonchik-tm-ya/opencode-telegram-notify/master/install.sh | bash
#
# Or from a cloned repo:
#   git clone https://github.com/tonchik-tm-ya/opencode-telegram-notify.git
#   cd opencode-telegram-notify && bash install.sh
#
# To fetch the plugin from another location, set PLUGIN_URL (see below).
set -euo pipefail

# Where to get telegram-notify.ts from. Empty = take the file next to this script.
PLUGIN_URL="${PLUGIN_URL:-}"

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_DIR="$CONFIG_DIR/plugins"
PLUGIN_FILE="$PLUGIN_DIR/telegram-notify.ts"
CONFIG_FILE="$CONFIG_DIR/telegram-notify.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$PLUGIN_DIR"

# Checksum file: next to the plugin in URL mode (e.g. .../telegram-notify.ts.sha256)
# or in the local repo.
SHA_FILE=""
if [ -n "$PLUGIN_URL" ]; then
  SHA_FILE="${PLUGIN_URL}.sha256"
elif [ -f "$SCRIPT_DIR/telegram-notify.ts.sha256" ]; then
  SHA_FILE="$SCRIPT_DIR/telegram-notify.ts.sha256"
fi

if [ -n "$PLUGIN_URL" ]; then
  echo "→ Fetching plugin from $PLUGIN_URL"
  curl -fsSL "$PLUGIN_URL" -o "$PLUGIN_FILE"
elif [ -f "$SCRIPT_DIR/telegram-notify.ts" ]; then
  echo "→ Copying plugin from the repository"
  cp "$SCRIPT_DIR/telegram-notify.ts" "$PLUGIN_FILE"
else
  echo "✗ No telegram-notify.ts next to the script and PLUGIN_URL is not set." >&2
  echo "  Usage: curl -sL https://raw.githubusercontent.com/tonchik-tm-ya/opencode-telegram-notify/master/install.sh | bash" >&2
  exit 1
fi

# Sanity check: the file looks like a plugin (not an HTML 404 page, not empty).
if ! grep -q "TelegramNotify" "$PLUGIN_FILE" 2>/dev/null; then
  echo "✗ Downloaded file does not look like the plugin (no TelegramNotify). Check PLUGIN_URL." >&2
  exit 1
fi

# SHA-256 verification, when a checksum is available.
if [ -n "$SHA_FILE" ]; then
  if EXPECTED=$(curl -fsSL "$SHA_FILE" 2>/dev/null | awk '{print $1}') && [ -n "$EXPECTED" ]; then
    ACTUAL=$(sha256sum "$PLUGIN_FILE" | awk '{print $1}')
    if [ "$ACTUAL" != "$EXPECTED" ]; then
      echo "✗ Hash mismatch: expected $EXPECTED, got $ACTUAL." >&2
      echo "  File is corrupted or tampered with. Installation aborted." >&2
      rm -f "$PLUGIN_FILE"
      exit 1
    fi
    echo "✓ SHA-256 hash matches"
  else
    echo "⚠ Could not fetch the checksum ($SHA_FILE) — skipping hash verification."
  fi
fi

echo "✓ Plugin installed: $PLUGIN_FILE"

# Create config from the example only if missing (never overwrite an existing one).
if [ ! -f "$CONFIG_FILE" ]; then
  if [ -f "$SCRIPT_DIR/telegram-notify.json.example" ]; then
    cp "$SCRIPT_DIR/telegram-notify.json.example" "$CONFIG_FILE"
    echo "✓ Config created: $CONFIG_FILE"
    echo "  ⚠ Fill in your botToken and chatId (see README → Installation)."
  else
    echo "⚠ Config not created (no telegram-notify.json.example next to the script). Create it manually."
  fi
else
  echo "→ Config already exists, leaving it untouched: $CONFIG_FILE"
fi

echo
echo "Done. Next steps:"
echo "  1. Check the token/chatId in $CONFIG_FILE"
echo "  2. Restart opencode"
echo "  3. The first notification arrives after any turn completes"