#!/bin/zsh
# Copies changed plugin files into Resolve's plugin folder, keeping dev hooks.
# UI changes reload the open window; main/lib changes need the plugin reopened.
set -euo pipefail
ROOT=${0:a:h:h}
DEST="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/com.grozoww.rampme"
rsync -a --exclude '.dev' --exclude '.devcmd' --exclude 'WorkflowIntegration.node' "$ROOT/plugin/" "$DEST/"
