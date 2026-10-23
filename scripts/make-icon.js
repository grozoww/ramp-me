#!/usr/bin/env node
// Draws the plugin icon from the Fast-Slow-Fast preset and renders it to PNG.
//   node scripts/make-icon.js
// Writes plugin/img/icon.svg and plugin/img/icon.png (1024 px, via headless Chrome).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('../plugin/ui/curve.js');

const OUT = path.join(__dirname, '..', 'plugin', 'img');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Plot area inside the 1024 canvas; y = 0 (first source frame) is at the bottom.
const X0 = 250;
const X1 = 774;
const Y0 = 742;
const Y1 = 270;
const px = (x) => +(X0 + x * (X1 - X0)).toFixed(1);
const py = (y) => +(Y0 - y * (Y0 - Y1)).toFixed(1);

const anchors = C.PRESETS.find((p) => p.id === 'fast-slow-fast').anchors;
let d = `M ${px(anchors[0].x)} ${py(anchors[0].y)}`;
for (let i = 0; i < anchors.length - 1; i++) {
  const a = anchors[i];
  const b = anchors[i + 1];
  d += ` C ${px(a.x + a.ox)} ${py(a.y + a.oy)}, ${px(b.x + b.ix)} ${py(b.y + b.iy)}, ${px(b.x)} ${py(b.y)}`;
}

// Speed strip like the one under the editor: fast, normal, slow, normal, fast.
const ys = C.sample(anchors, 401);
const strip = [];
const SEG = 40;
for (let i = 0; i < SEG; i++) {
  const s = C.slopeAt(ys, (i + 0.5) / SEG);
  const color = s <= 0.35 ? '#38c8ff' : s >= 2.2 ? '#ffd23f' : '#2bff66';
  const w = (X1 - X0) / SEG;
  strip.push(`<rect x="${(X0 + i * w).toFixed(1)}" y="800" width="${(w + 0.6).toFixed(1)}" height="16" fill="${color}"/>`);
}

const grid = [];
for (let i = 1; i < 4; i++) {
  const x = X0 + ((X1 - X0) * i) / 4;
  grid.push(`<line x1="${x}" y1="${Y1 - 20}" x2="${x}" y2="${Y0 + 20}"/>`);
}
for (let i = 1; i < 3; i++) {
  const y = Y1 + ((Y0 - Y1) * i) / 3;
  grid.push(`<line x1="${X0}" y1="${y}" x2="${X1}" y2="${y}"/>`);
}

const dots = anchors.map((a) => `<circle cx="${px(a.x)}" cy="${py(a.y)}" r="38"/>`).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#22262c"/>
      <stop offset="1" stop-color="#0c0d0f"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="22"/>
    </filter>
    <clipPath id="strip"><rect x="${X0}" y="800" width="${X1 - X0}" height="16" rx="8"/></clipPath>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
  <rect x="101.5" y="101.5" width="821" height="821" rx="184.5" fill="none" stroke="#ffffff" stroke-opacity="0.09" stroke-width="3"/>
  <g stroke="#ffffff" stroke-opacity="0.07" stroke-width="5">${grid.join('')}</g>
  <g stroke="#ffffff" stroke-opacity="0.2" stroke-width="5" stroke-dasharray="18 16">
    <line x1="${X0}" y1="${Y1}" x2="${X1}" y2="${Y1}"/>
    <line x1="${X0}" y1="${Y0}" x2="${X1}" y2="${Y0}"/>
  </g>
  <path d="${d}" fill="none" stroke="#2bff66" stroke-opacity="0.55" stroke-width="54" stroke-linecap="round" filter="url(#glow)"/>
  <path d="${d}" fill="none" stroke="#2bff66" stroke-width="40" stroke-linecap="round"/>
  <g fill="#2bff66" stroke="#0f1012" stroke-width="16">${dots}</g>
  <g clip-path="url(#strip)">${strip.join('')}</g>
</svg>
`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.svg'), svg);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rampme-icon-'));
const html = path.join(tmp, 'icon.html');
fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
execFileSync(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  `--user-data-dir=${path.join(tmp, 'profile')}`,
  '--default-background-color=00000000',
  '--window-size=1024,1024',
  `--screenshot=${path.join(OUT, 'icon.png')}`,
  `file://${html}`,
], { stdio: 'ignore' });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote ${path.join(OUT, 'icon.svg')} and icon.png`);
