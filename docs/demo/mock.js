// Stand-in for the plugin's preload API, so the real UI runs in a browser on
// a made-up timeline. Edits only change this fake state.
(function () {
  'use strict';
  const listeners = [];
  const ctx = {
    status: 'ok',
    timeline: { name: 'Night Run — edit v3', fps: 30 },
    frame: 40,
    media: { id: 'clip-1', name: 'C0412_drift_wide.mov', track: 1, start: 0, end: 80, speed: 600, ramp: null },
    range: {
      kind: 'adjustment', id: 'adj-1', gid: 'adj1', name: 'Adjustment Clip', track: 2,
      start: 66, end: 96, clips: 2, fx: null, stale: false,
    },
  };
  const copy = (v) => JSON.parse(JSON.stringify(v));
  const ok = (result) => Promise.resolve({ ok: true, result });
  const push = () => setTimeout(() => listeners.forEach((cb) => cb(copy(ctx))), 0);
  const KEY = 'rampme-demo-prefs';
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY));
    } catch {
      return null;
    }
  };

  window.rampme = {
    getContext: () => ok(copy(ctx)),
    applyRamp: (p) => {
      ctx.media.ramp = { v: 1, anchors: p.anchors, mode: p.mode };
      push();
      return ok({});
    },
    clearRamp: () => {
      ctx.media.ramp = null;
      push();
      return ok({ empty: true });
    },
    applyFx: (p) => {
      ctx.range.fx = p.settings;
      push();
      return ok({ clips: ctx.range.clips });
    },
    clearFx: () => {
      ctx.range.fx = null;
      push();
      return ok({ clips: ctx.range.clips });
    },
    getPrefs: () => ok(load() || { smoothness: 'off', pinned: true, presets: [] }),
    setPrefs: (prefs) => {
      try {
        localStorage.setItem(KEY, JSON.stringify(prefs));
      } catch {
        // Private mode: settings just do not stick.
      }
      return ok();
    },
    setPinned: () => ok(),
    onContext: (cb) => {
      listeners.push(cb);
      return () => {};
    },
  };

  // ?preset=fast-slow-fast&tab=fx&fx=1 sets up a starting state; &shot=1 for screenshots.
  const params = new URLSearchParams(location.search);
  if (params.toString()) {
    window.addEventListener('load', () => setTimeout(() => {
      // No half-finished transitions in screenshots.
      if (params.get('shot')) document.styleSheets[0].insertRule('*, *::after { transition: none !important; }');
      const click = (sel) => {
        const el = document.querySelector(sel);
        if (el) el.click();
      };
      if (params.get('preset')) click(`.preset[data-id="${params.get('preset')}"]`);
      if (params.get('tab')) click(`.tab[data-tab="${params.get('tab')}"]`);
      if (params.get('fx')) {
        click('[data-fx="shake.on"]');
        click('[data-fx="glow.on"]');
        click('[data-fx="blur.on"]');
      }
      if (params.get('hover')) {
        const cv = document.querySelector('#graph');
        const b = cv.getBoundingClientRect();
        cv.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, clientX: b.left + b.width * Number(params.get('hover')), clientY: b.top + 60,
        }));
      }
    }, 300));
  }
})();
