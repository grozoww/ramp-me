// Speed-ramp curve model shared by the UI and the tests.
//
// A curve maps timeline position x (0..1 across the clip) to source position y
// (0 = first source frame of the clip, 1 = last). It is a chain of cubic Bezier
// segments between anchors. The slope dy/dx is the speed relative to the clip's
// base speed: slope 1 keeps the edit-page speed, slope 1/6 on a 600% clip is 100%.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RMCurve = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SAMPLES = 1001;
  const MIN_GAP = 0.02;

  // Anchor: { x, y, ix, iy, ox, oy } where (ix, iy) and (ox, oy) are the in/out
  // handles as offsets from the anchor.
  function anchor(x, y, ix = 0, iy = 0, ox = 0, oy = 0) {
    return { x, y, ix, iy, ox, oy };
  }

  // Builds anchors from rows [x, y, slopeIn, slopeOut, weightIn, weightOut].
  // A handle is weight * gap / 3 long, so weight 1 gives an even Bezier.
  function fromSlopes(rows) {
    return rows.map((row, i) => {
      const [x, y, sIn, sOut = sIn, wIn = 1, wOut = wIn] = row;
      const a = anchor(x, y);
      const prev = rows[i - 1];
      const next = rows[i + 1];
      if (prev) {
        const dx = -wIn * (x - prev[0]) / 3;
        a.ix = dx;
        a.iy = dx * sIn;
      }
      if (next) {
        const dx = wOut * (next[0] - x) / 3;
        a.ox = dx;
        a.oy = dx * sOut;
      }
      return a;
    });
  }

  const PRESETS = [
    { id: 'linear', name: 'Linear', anchors: fromSlopes([[0, 0, 1], [1, 1, 1]]) },
    { id: 'fast-slow-fast', name: 'Fast-Slow-Fast', anchors: fromSlopes([[0, 0, 3], [0.5, 0.5, 0.18], [1, 1, 3]]) },
    { id: 'slow-fast-slow', name: 'Slow-Fast-Slow', anchors: fromSlopes([[0, 0, 0.15, 0.15, 1.4], [1, 1, 0.15, 0.15, 1.4]]) },
    { id: 'speed-up', name: 'Speed Up', anchors: fromSlopes([[0, 0, 0.15], [1, 1, 2.5]]) },
    { id: 'slow-down', name: 'Slow Down', anchors: fromSlopes([[0, 0, 2.5], [1, 1, 0.15]]) },
    { id: 'mid-reverse', name: 'Mid Reverse', anchors: fromSlopes([[0, 0, 2.5], [0.33, 0.55, 0], [0.55, 0.42, 0], [1, 1, 2.5]]) },
    // Pushes: slow stretches with short fast bursts at the inner anchors.
    { id: 'mid-push', name: 'Mid Push', anchors: fromSlopes([[0, 0, 0.2, 0.2, 1, 1.2], [0.5, 0.5, 3.5, 3.5, 0.45], [1, 1, 0.2, 0.2, 1.2]]) },
    { id: '2-push', name: '2-Push', anchors: fromSlopes([[0, 0, 0.2, 0.2, 1, 1.2], [1 / 3, 1 / 3, 3.5, 3.5, 0.4], [2 / 3, 2 / 3, 3.5, 3.5, 0.4], [1, 1, 0.2, 0.2, 1.2]]) },
    { id: '3-push', name: '3-Push', anchors: fromSlopes([[0, 0, 0.2, 0.2, 1, 1.2], [0.25, 0.25, 3.5, 3.5, 0.4], [0.5, 0.5, 3.5, 3.5, 0.4], [0.75, 0.75, 3.5, 3.5, 0.4], [1, 1, 0.2, 0.2, 1.2]]) },
    { id: 'boomerang-l', name: 'Boomerang L', anchors: fromSlopes([[0, 0, 4], [0.3, 1, 0], [1, 0, -2]]) },
    { id: 'boomerang', name: 'Boomerang', anchors: fromSlopes([[0, 0, 3], [0.5, 1, 0], [1, 0, -3]]) },
    { id: 'boomerang-r', name: 'Boomerang R', anchors: fromSlopes([[0, 0, 2], [0.7, 1, 0], [1, 0, -4]]) },
  ];

  function clone(anchors) {
    return anchors.map((a) => ({ x: a.x, y: a.y, ix: a.ix, iy: a.iy, ox: a.ox, oy: a.oy }));
  }

  function linear() {
    return clone(PRESETS[0].anchors);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // Keeps a handle on its own side of the anchor (at worst vertical) and scales
  // it down, keeping its slope, so it does not reach past the next anchor.
  function fitHandle(dx, dy, sign, maxDx) {
    if (dx === 0 && dy === 0) return [0, 0];
    let x = sign > 0 ? Math.max(1e-4, dx) : Math.min(-1e-4, dx);
    let y = dy;
    const limit = Math.max(1e-4, maxDx);
    if (Math.abs(x) > limit) {
      const f = limit / Math.abs(x);
      x *= f;
      y *= f;
    }
    return [x, y];
  }

  // Puts anchors back into a valid shape: ends at x = 0 and 1, x strictly
  // increasing, y in 0..1, handles pointing forward/backward and never
  // reaching past the neighbouring anchor (keeps x(t) monotonic per segment).
  function normalize(anchors) {
    const out = clone(anchors).sort((a, b) => a.x - b.x);
    const n = out.length;
    out[0].x = 0;
    out[n - 1].x = 1;
    for (let i = 1; i < n - 1; i++) {
      out[i].x = clamp(out[i].x, out[i - 1].x + MIN_GAP, 1 - MIN_GAP * (n - 1 - i));
    }
    for (let i = 0; i < n; i++) {
      const a = out[i];
      a.y = clamp(a.y, 0, 1);
      if (i === 0) {
        a.ix = 0;
        a.iy = 0;
      } else {
        [a.ix, a.iy] = fitHandle(a.ix, a.iy, -1, a.x - out[i - 1].x);
      }
      if (i === n - 1) {
        a.ox = 0;
        a.oy = 0;
      } else {
        [a.ox, a.oy] = fitHandle(a.ox, a.oy, 1, out[i + 1].x - a.x);
      }
    }
    return out;
  }

  function bezier(p0, p1, p2, p3, t) {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  }

  // Returns the curve as y values at n evenly spaced x positions, y clamped to 0..1.
  // Works on a dense polyline with x forced non-decreasing, so any handle
  // layout still gives a function of x and the editor draws what gets applied.
  function sample(anchors, n = SAMPLES) {
    const pts = [];
    const STEPS = 128;
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i];
      const b = anchors[i + 1];
      for (let s = i === 0 ? 0 : 1; s <= STEPS; s++) {
        const t = s / STEPS;
        pts.push([
          bezier(a.x, a.x + a.ox, b.x + b.ix, b.x, t),
          bezier(a.y, a.y + a.oy, b.y + b.iy, b.y, t),
        ]);
      }
    }
    let maxX = 0;
    for (const p of pts) {
      p[0] = clamp(Math.max(maxX, p[0]), 0, 1);
      maxX = p[0];
    }
    const ys = new Array(n);
    let j = 0;
    for (let k = 0; k < n; k++) {
      const x = k / (n - 1);
      while (j < pts.length - 2 && pts[j + 1][0] < x) j++;
      const [x0, y0] = pts[j];
      const [x1, y1] = pts[Math.min(j + 1, pts.length - 1)];
      const y = x1 > x0 ? y0 + (y1 - y0) * clamp((x - x0) / (x1 - x0), 0, 1) : y1;
      ys[k] = clamp(y, 0, 1);
    }
    return ys;
  }

  // Interpolated y at x from samples.
  function valueAt(ys, x) {
    const p = clamp(x, 0, 1) * (ys.length - 1);
    const i = Math.floor(p);
    if (i >= ys.length - 1) return ys[ys.length - 1];
    return ys[i] + (ys[i + 1] - ys[i]) * (p - i);
  }

  // Slope dy/dx at x from samples (relative speed; negative means reverse).
  function slopeAt(ys, x) {
    const n = ys.length - 1;
    const i = clamp(Math.round(clamp(x, 0, 1) * n), 0, n);
    const a = Math.max(0, i - 2);
    const b = Math.min(n, i + 2);
    return (ys[b] - ys[a]) / ((b - a) / n);
  }

  // Lowest and highest slope over the curve, ignoring the very ends.
  function slopeRange(ys) {
    let lo = Infinity;
    let hi = -Infinity;
    const n = ys.length - 1;
    for (let i = 2; i <= n - 2; i += 2) {
      const s = slopeAt(ys, i / n);
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    return [lo, hi];
  }

  // Plays the source the other way round: y -> 1 - y.
  function reverse(anchors) {
    return anchors.map((a) => ({ x: a.x, y: 1 - a.y, ix: a.ix, iy: -a.iy, ox: a.ox, oy: -a.oy }));
  }

  // Adds an anchor on the curve at x, with handles along the local slope.
  function insertAnchor(anchors, x, ys) {
    const i = anchors.findIndex((a) => a.x > x);
    if (i <= 0) return { anchors, index: -1 };
    const prev = anchors[i - 1];
    const next = anchors[i];
    if (x - prev.x < MIN_GAP || next.x - x < MIN_GAP) return { anchors, index: -1 };
    const y = valueAt(ys, x);
    const s = slopeAt(ys, x);
    const inDx = -(x - prev.x) / 3;
    const outDx = (next.x - x) / 3;
    const added = anchor(x, y, inDx, inDx * s, outDx, outDx * s);
    const list = clone(anchors);
    list.splice(i, 0, added);
    // Shorten the neighbours' facing handles so they do not cross the new anchor.
    return { anchors: normalize(list), index: i };
  }

  function removeAnchor(anchors, index) {
    if (index <= 0 || index >= anchors.length - 1) return anchors;
    const list = clone(anchors);
    list.splice(index, 1);
    return normalize(list);
  }

  function same(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    const eq = (p, q) => Math.abs(p - q) < 1e-6;
    return a.every((p, i) => ['x', 'y', 'ix', 'iy', 'ox', 'oy'].every((k) => eq(p[k], b[i][k])));
  }

  // Checks untrusted data (saved presets, comp data) before use.
  function isValid(anchors) {
    return Array.isArray(anchors) && anchors.length >= 2 && anchors.length <= 64 &&
      anchors.every((a) => a && ['x', 'y', 'ix', 'iy', 'ox', 'oy'].every((k) => Number.isFinite(a[k])));
  }

  return {
    SAMPLES,
    PRESETS,
    anchor,
    fromSlopes,
    clone,
    linear,
    normalize,
    sample,
    valueAt,
    slopeAt,
    slopeRange,
    reverse,
    insertAnchor,
    removeAnchor,
    same,
    isValid,
  };
});
