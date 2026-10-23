#!/bin/zsh
# Builds the GitHub Pages site in docs/: copies the plugin UI into docs/demo
# (running on site/demo-mock.js instead of Resolve) and renders screenshots.
#   scripts/build-site.sh            copy the demo
#   scripts/build-site.sh --shots    also re-render docs/img/*.png (needs Chrome)
set -euo pipefail

ROOT=${0:a:h:h}
DOCS="$ROOT/docs"
DEMO="$DOCS/demo"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

mkdir -p "$DEMO" "$DOCS/img"
cp "$ROOT"/plugin/ui/{styles.css,app.js,graph.js,curve.js} "$DEMO/"
cp "$ROOT/site/demo-mock.js" "$DEMO/mock.js"
cp "$ROOT"/plugin/img/icon.{svg,png} "$DOCS/img/"
# Load the mock before the app; the icon sits one level up, as in the plugin.
sed 's#<script src="curve.js"></script>#<script src="mock.js"></script>\n  <script src="curve.js"></script>#' \
  "$ROOT/plugin/ui/index.html" > "$DEMO/index.html"

if [[ "${1:-}" == "--shots" ]]; then
  TMP=$(mktemp -d)
  shot() {
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$TMP/profile" \
      --force-device-scale-factor=2 --window-size=1060,780 --virtual-time-budget=4000 \
      --screenshot="$DOCS/img/$1.png" "file://$DEMO/index.html?$2" >/dev/null 2>&1
  }
  shot graph 'shot=1&preset=fast-slow-fast&hover=0.5'
  shot transitions 'shot=1&preset=fast-slow-fast&tab=fx&fx=1'
  shot motion-blur 'shot=1&preset=fast-slow-fast&tab=blur&fx=1'
  rm -rf "$TMP"
fi
echo "Site built in $DOCS"
