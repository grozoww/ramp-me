// User preferences and saved presets, kept outside the plugin folder so
// reinstalling the plugin does not wipe them.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), 'Library', 'Application Support', 'RampMe');
const FILE = path.join(DIR, 'prefs.json');

const DEFAULTS = { smoothness: 'off', pinned: true, presets: [] };

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      smoothness: data.smoothness === 'flow' ? 'flow' : 'off',
      pinned: data.pinned !== false,
      presets: Array.isArray(data.presets) ? data.presets.filter((p) => p && typeof p.name === 'string') : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(prefs) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2));
  fs.renameSync(tmp, FILE);
}

module.exports = { load, save, DIR };
