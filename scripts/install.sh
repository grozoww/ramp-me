#!/bin/zsh
# Installs Ramp Me into DaVinci Resolve Studio (macOS).
#   scripts/install.sh        normal install
#   scripts/install.sh --dev  same, plus dev hooks (see scripts/dev-run.sh)
# Resolve does not follow symlinks here, so this always copies. Re-run it (or
# scripts/dev-sync.sh) after changing the code. Resolve only lists new plugins
# after a restart; updated files are picked up the next time the plugin opens.
set -euo pipefail

ROOT=${0:a:h:h}
SRC="$ROOT/plugin"
RESOLVE="/Library/Application Support/Blackmagic Design/DaVinci Resolve"
NODE_MOD="$RESOLVE/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node"
DEST_DIR="$RESOLVE/Workflow Integration Plugins"
DEST="$DEST_DIR/com.grozoww.rampme"

[[ -f "$NODE_MOD" ]] || { echo "WorkflowIntegration.node not found. Is DaVinci Resolve Studio installed?" >&2; exit 1; }
mkdir -p "$DEST_DIR"
[[ -L "$DEST" ]] && rm "$DEST"
mkdir -p "$DEST"
rsync -a --delete --exclude '.dev' --exclude '.devcmd' "$SRC/" "$DEST/"
cp "$NODE_MOD" "$DEST/WorkflowIntegration.node"
if [[ "${1:-}" == "--dev" ]]; then
  touch "$DEST/.dev"
  echo "Installed to $DEST (dev hooks on)"
else
  rm -rf "$DEST/.dev" "$DEST/.devcmd"
  echo "Installed to $DEST"
fi
