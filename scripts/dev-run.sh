#!/bin/zsh
# Sends a JS file to the running plugin (dev install only) and prints the result.
# The script gets `ctx` = { bridge, win, app, fs, path, require }.
DIR="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/com.grozoww.rampme/.devcmd"
[[ -d "$DIR" ]] || { echo "Plugin dev hooks are not running" >&2; exit 1; }
rm -f "$DIR"/out.json
cp "$1" "$DIR"/cmd.js.tmp && mv "$DIR"/cmd.js.tmp "$DIR"/cmd.js
for i in {1..300}; do [[ -f "$DIR"/out.json ]] && { cat "$DIR"/out.json; exit 0; }; sleep 0.1; done
echo "timeout" >&2; exit 1
