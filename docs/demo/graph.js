// Canvas editor for a ramp curve. x = time across the clip, y = source position.
(function (root) {
  'use strict';
  const C = root.RMCurve;

  const COLORS = {
    grid: 'rgba(255,255,255,0.05)',
    bound: 'rgba(255,255,255,0.16)',
    label: '#5b6168',
    accent: '#2bff66',
    ink: '#0f1012',
    slow: '#38c8ff',
    fast: '#ffd23f',
    back: '#ff52d9',
  };
  const HIT_ANCHOR = 12;
  const HIT_HANDLE = 10;

  // Speed colour: reverse, real-time or slower, normal, very fast.
  function speedColor(slope, base) {
    if (slope < -0.02) return COLORS.back;
    const pct = base ? slope * base : slope * 100;
    if (base ? pct <= 110 : slope <= 0.35) return COLORS.slow;
    if (base ? pct >= 1500 : slope >= 2.5) return COLORS.fast;
    return COLORS.accent;
  }

  class GraphEditor {
    constructor(canvas, { onChange, onCommit, onHover }) {
      this.canvas = canvas;
      this.g = canvas.getContext('2d');
      this.onChange = onChange;
      this.onCommit = onCommit;
      this.onHover = onHover;
      this.anchors = C.linear();
      this.ys = C.sample(this.anchors);
      this.base = null;
      this.sel = -1;
      this.drag = null;
      this.hoverX = null;
      this.enabled = true;
      this.pad = { l: 22, r: 22, t: 34, b: 34 };
      new ResizeObserver(() => this.resize()).observe(canvas);
      canvas.addEventListener('pointerdown', (e) => this.down(e));
      canvas.addEventListener('pointermove', (e) => this.move(e));
      canvas.addEventListener('pointerup', (e) => this.up(e));
      canvas.addEventListener('pointercancel', (e) => this.up(e));
      canvas.addEventListener('pointerleave', () => this.hover(null));
      canvas.addEventListener('dblclick', (e) => this.dbl(e));
      canvas.addEventListener('contextmenu', (e) => this.context(e));
    }

    setCurve(anchors) {
      this.anchors = C.normalize(anchors);
      this.ys = C.sample(this.anchors);
      if (this.sel >= this.anchors.length) this.sel = -1;
      this.draw();
    }

    setBaseSpeed(base) {
      this.base = base;
      this.draw();
    }

    setEnabled(on) {
      this.enabled = on;
      this.canvas.classList.toggle('disabled', !on);
      if (!on) this.drag = null;
    }

    removeSelected() {
      if (this.sel <= 0 || this.sel >= this.anchors.length - 1) return;
      const next = C.removeAnchor(this.anchors, this.sel);
      this.sel = -1;
      this.setCurve(next);
      this.onCommit(this.anchors);
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w;
      this.h = h;
      this.draw();
    }

    rect() {
      const p = this.pad;
      return { x: p.l, y: p.t, w: this.w - p.l - p.r, h: this.h - p.t - p.b };
    }

    toPx(x, y) {
      const r = this.rect();
      return [r.x + x * r.w, r.y + (1 - y) * r.h];
    }

    fromPx(px, py) {
      const r = this.rect();
      return [(px - r.x) / r.w, 1 - (py - r.y) / r.h];
    }

    point(e) {
      const b = this.canvas.getBoundingClientRect();
      return [e.clientX - b.left, e.clientY - b.top];
    }

    hit(px, py) {
      const a = this.anchors;
      const near = (x, y, r) => Math.hypot(px - x, py - y) <= r;
      // Handles of the selected anchor win over anchors, so short handles stay reachable.
      const order = this.sel >= 0 ? [this.sel, ...a.keys()] : [...a.keys()];
      for (const i of order) {
        const [ax, ay] = this.toPx(a[i].x, a[i].y);
        if (i < a.length - 1 && (a[i].ox || a[i].oy)) {
          const [hx, hy] = this.toPx(a[i].x + a[i].ox, a[i].y + a[i].oy);
          if (near(hx, hy, HIT_HANDLE) && !near(ax, ay, 4)) return { type: 'out', i };
        }
        if (i > 0 && (a[i].ix || a[i].iy)) {
          const [hx, hy] = this.toPx(a[i].x + a[i].ix, a[i].y + a[i].iy);
          if (near(hx, hy, HIT_HANDLE) && !near(ax, ay, 4)) return { type: 'in', i };
        }
      }
      for (let i = 0; i < a.length; i++) {
        const [ax, ay] = this.toPx(a[i].x, a[i].y);
        if (near(ax, ay, HIT_ANCHOR)) return { type: 'anchor', i };
      }
      return null;
    }

    down(e) {
      if (!this.enabled || e.button !== 0) return;
      const [px, py] = this.point(e);
      const h = this.hit(px, py);
      this.sel = h ? h.i : -1;
      if (h) {
        this.drag = { ...h, moved: false };
        this.canvas.setPointerCapture(e.pointerId);
      }
      this.draw();
    }

    move(e) {
      const [px, py] = this.point(e);
      if (!this.drag) {
        const h = this.enabled && this.hit(px, py);
        this.canvas.style.cursor = h ? (h.type === 'anchor' ? 'grab' : 'pointer') : 'crosshair';
        this.hover(this.fromPx(px, py)[0]);
        return;
      }
      const [x, y] = this.fromPx(px, py);
      const a = C.clone(this.anchors);
      const d = this.drag;
      const p = a[d.i];
      if (d.type === 'anchor') {
        if (d.i > 0 && d.i < a.length - 1) p.x = x;
        p.y = Math.min(1, Math.max(0, y));
      } else {
        const out = d.type === 'out';
        const dx = x - p.x;
        const dy = y - p.y;
        if (out) {
          p.ox = dx;
          p.oy = dy;
        } else {
          p.ix = dx;
          p.iy = dy;
        }
        // Keep the opposite handle in line (smooth point) unless Option is held.
        const hasOther = out ? d.i > 0 : d.i < a.length - 1;
        if (!e.altKey && hasOther) {
          const [ax, ay] = this.toPx(p.x, p.y);
          const [hx, hy] = this.toPx(p.x + dx, p.y + dy);
          const ox = out ? p.ix : p.ox;
          const oy = out ? p.iy : p.oy;
          const [qx, qy] = this.toPx(p.x + ox, p.y + oy);
          const len = Math.hypot(qx - ax, qy - ay) || 30;
          const vx = ax - hx;
          const vy = ay - hy;
          const vl = Math.hypot(vx, vy);
          if (vl > 1) {
            const [nx, ny] = this.fromPx(ax + (vx / vl) * len, ay + (vy / vl) * len);
            if (out) {
              p.ix = nx - p.x;
              p.iy = ny - p.y;
            } else {
              p.ox = nx - p.x;
              p.oy = ny - p.y;
            }
          }
        }
      }
      d.moved = true;
      this.setCurve(a);
      this.hover(x);
      this.onChange(this.anchors);
    }

    up(e) {
      if (!this.drag) return;
      const moved = this.drag.moved;
      this.drag = null;
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
      if (moved) this.onCommit(this.anchors);
    }

    dbl(e) {
      if (!this.enabled) return;
      const [px, py] = this.point(e);
      if (this.hit(px, py)) return;
      const [x] = this.fromPx(px, py);
      const { anchors, index } = C.insertAnchor(this.anchors, x, this.ys);
      if (index < 0) return;
      this.sel = index;
      this.setCurve(anchors);
      this.onCommit(this.anchors);
    }

    context(e) {
      e.preventDefault();
      if (!this.enabled) return;
      const [px, py] = this.point(e);
      const h = this.hit(px, py);
      if (!h || h.type !== 'anchor') return;
      this.sel = h.i;
      this.removeSelected();
    }

    hover(x) {
      this.hoverX = x === null || x < 0 || x > 1 ? null : x;
      this.draw();
      if (this.onHover) this.onHover(this.hoverX === null ? null : C.slopeAt(this.ys, this.hoverX));
    }

    draw() {
      const g = this.g;
      if (!this.w) return;
      const r = this.rect();
      g.clearRect(0, 0, this.w, this.h);

      // Grid
      g.lineWidth = 1;
      g.strokeStyle = COLORS.grid;
      g.beginPath();
      for (let i = 1; i < 8; i++) {
        const x = Math.round(r.x + (r.w * i) / 8) + 0.5;
        g.moveTo(x, r.y - 8);
        g.lineTo(x, r.y + r.h + 8);
      }
      for (let i = 1; i < 4; i++) {
        const y = Math.round(r.y + (r.h * i) / 4) + 0.5;
        g.moveTo(r.x, y);
        g.lineTo(r.x + r.w, y);
      }
      g.stroke();

      // Source start and end
      g.strokeStyle = COLORS.bound;
      g.setLineDash([5, 5]);
      g.beginPath();
      for (const y of [r.y, r.y + r.h]) {
        g.moveTo(r.x, Math.round(y) + 0.5);
        g.lineTo(r.x + r.w, Math.round(y) + 0.5);
      }
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = COLORS.label;
      g.font = '700 11px -apple-system, sans-serif';
      g.fillText('LAST SOURCE FRAME', r.x, r.y - 9);
      g.fillText('FIRST SOURCE FRAME', r.x, r.y + r.h + 17);

      // Speed strip along the bottom edge
      const ys = this.ys;
      const stripY = this.h - 9;
      const SEG = 160;
      for (let i = 0; i < SEG; i++) {
        const x0 = i / SEG;
        g.fillStyle = speedColor(C.slopeAt(ys, x0 + 0.5 / SEG), this.base);
        g.fillRect(r.x + x0 * r.w, stripY, r.w / SEG + 0.5, 4);
      }

      // Curve
      g.save();
      g.strokeStyle = COLORS.accent;
      g.lineWidth = 3;
      g.lineJoin = 'round';
      g.shadowColor = 'rgba(43,255,102,0.55)';
      g.shadowBlur = 14;
      g.beginPath();
      const n = ys.length - 1;
      for (let i = 0; i <= n; i += 2) {
        const [x, y] = this.toPx(i / n, ys[i]);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      g.restore();

      // Handles
      const a = this.anchors;
      g.lineWidth = 1.25;
      for (let i = 0; i < a.length; i++) {
        const [ax, ay] = this.toPx(a[i].x, a[i].y);
        const hs = [];
        if (i > 0 && (a[i].ix || a[i].iy)) hs.push([a[i].x + a[i].ix, a[i].y + a[i].iy]);
        if (i < a.length - 1 && (a[i].ox || a[i].oy)) hs.push([a[i].x + a[i].ox, a[i].y + a[i].oy]);
        const strong = i === this.sel;
        for (const [hx, hy] of hs) {
          const [px, py] = this.toPx(hx, hy);
          g.strokeStyle = strong ? 'rgba(43,255,102,0.85)' : 'rgba(43,255,102,0.4)';
          g.setLineDash([3, 4]);
          g.beginPath();
          g.moveTo(ax, ay);
          g.lineTo(px, py);
          g.stroke();
          g.setLineDash([]);
          g.fillStyle = COLORS.ink;
          g.lineWidth = 2;
          g.strokeStyle = strong ? COLORS.accent : 'rgba(43,255,102,0.7)';
          g.beginPath();
          g.arc(px, py, strong ? 5.5 : 4.5, 0, Math.PI * 2);
          g.fill();
          g.stroke();
          g.lineWidth = 1.25;
        }
      }

      // Anchors
      for (let i = 0; i < a.length; i++) {
        const [ax, ay] = this.toPx(a[i].x, a[i].y);
        const strong = i === this.sel;
        g.fillStyle = COLORS.accent;
        g.strokeStyle = strong ? '#ffffff' : COLORS.ink;
        g.lineWidth = strong ? 2.5 : 3;
        g.beginPath();
        g.arc(ax, ay, strong ? 9 : 7.5, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }

      // Hover cursor
      if (this.hoverX !== null) {
        const [hx, hy] = this.toPx(this.hoverX, C.valueAt(ys, this.hoverX));
        g.strokeStyle = 'rgba(255,255,255,0.18)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(Math.round(hx) + 0.5, r.y - 8);
        g.lineTo(Math.round(hx) + 0.5, r.y + r.h + 8);
        g.stroke();
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.arc(hx, hy, 3.5, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  // Small preview used on preset cards.
  function drawThumb(canvas, anchors) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 120;
    const h = canvas.clientHeight || 62;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const p = 8;
    const toPx = (x, y) => [p + x * (w - 2 * p), p + (1 - y) * (h - 2 * p)];
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < 4; i++) {
      const x = Math.round(p + ((w - 2 * p) * i) / 4) + 0.5;
      g.moveTo(x, p);
      g.lineTo(x, h - p);
      const y = Math.round(p + ((h - 2 * p) * i) / 4) + 0.5;
      g.moveTo(p, y);
      g.lineTo(w - p, y);
    }
    g.stroke();
    const ys = C.sample(anchors, 201);
    g.strokeStyle = COLORS.accent;
    g.lineWidth = 2.2;
    g.lineJoin = 'round';
    g.beginPath();
    ys.forEach((y, i) => {
      const [x, yy] = toPx(i / 200, y);
      if (i === 0) g.moveTo(x, yy);
      else g.lineTo(x, yy);
    });
    g.stroke();
    g.fillStyle = COLORS.accent;
    for (const a of anchors) {
      const [x, y] = toPx(a.x, a.y);
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
    }
  }

  root.RMGraph = { GraphEditor, drawThumb, speedColor };
})(self);
