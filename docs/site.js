(function () {
  'use strict';
  const C = window.RMCurve;
  const $ = (sel) => document.querySelector(sel);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const COLORS = { accent: '#2bff66', slow: '#38c8ff', fast: '#ffd23f', back: '#ff52d9' };
  const BASE = 600; // the demo clip runs at 600%, as in the usual workflow
  const ORDER = ['fast-slow-fast', 'speed-up', 'mid-push', 'boomerang', 'slow-fast-slow', '2-push'];
  const presets = ORDER.map((id) => C.PRESETS.find((p) => p.id === id));
  const N = 241;
  const MORPH = 750;
  const SWEEP = 3600;
  const HOLD = 600;
  const FRAMES = 40;

  const speedColor = (slope) => {
    if (slope < -0.02) return COLORS.back;
    const pct = slope * BASE;
    if (pct <= 130) return COLORS.slow;
    if (pct >= 1400) return COLORS.fast;
    return COLORS.accent;
  };
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function fit(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }

  // ---------- hero ----------

  const graph = $('#heroGraph');
  const ribbon = $('#heroRibbon');
  const speedEl = $('#heroSpeed');
  const nameEl = $('#heroPreset');
  let idx = 0;
  let from = C.sample(presets[0].anchors, N);
  let to = from;
  let ys = from;
  let cycleStart = performance.now() - MORPH;

  function drawHero(now) {
    const t = now - cycleStart;
    let head = null;
    if (t < MORPH) {
      const k = ease(t / MORPH);
      ys = from.map((v, i) => v + (to[i] - v) * k);
    } else {
      ys = to;
      head = Math.min(1, (t - MORPH) / SWEEP);
    }
    if (t > MORPH + SWEEP + HOLD) {
      idx = (idx + 1) % presets.length;
      from = to;
      to = C.sample(presets[idx].anchors, N);
      nameEl.textContent = presets[idx].name;
      cycleStart = now;
    }

    const { g, w, h } = fit(graph);
    const pad = { l: 14, r: 14, t: 18, b: 18 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const X = (x) => pad.l + x * pw;
    const Y = (y) => pad.t + (1 - y) * ph;
    g.clearRect(0, 0, w, h);

    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < 8; i++) {
      g.moveTo(Math.round(X(i / 8)) + 0.5, pad.t);
      g.lineTo(Math.round(X(i / 8)) + 0.5, pad.t + ph);
    }
    for (let i = 1; i < 4; i++) {
      g.moveTo(pad.l, Math.round(Y(i / 4)) + 0.5);
      g.lineTo(pad.l + pw, Math.round(Y(i / 4)) + 0.5);
    }
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.setLineDash([5, 5]);
    g.beginPath();
    g.moveTo(pad.l, Math.round(Y(1)) + 0.5);
    g.lineTo(pad.l + pw, Math.round(Y(1)) + 0.5);
    g.moveTo(pad.l, Math.round(Y(0)) + 0.5);
    g.lineTo(pad.l + pw, Math.round(Y(0)) + 0.5);
    g.stroke();
    g.setLineDash([]);

    g.save();
    g.strokeStyle = COLORS.accent;
    g.lineWidth = 3.5;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.shadowColor = 'rgba(43,255,102,0.6)';
    g.shadowBlur = 16;
    g.beginPath();
    ys.forEach((y, i) => (i ? g.lineTo(X(i / (N - 1)), Y(y)) : g.moveTo(X(0), Y(y))));
    g.stroke();
    g.restore();

    if (head !== null) {
      const x = X(head);
      const y = Y(C.valueAt(ys, head));
      g.strokeStyle = '#ff4d4d';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, pad.t - 8);
      g.lineTo(x, pad.t + ph + 8);
      g.stroke();
      g.fillStyle = '#ff4d4d';
      g.beginPath();
      g.moveTo(x - 6, pad.t - 12);
      g.lineTo(x + 6, pad.t - 12);
      g.lineTo(x, pad.t - 4);
      g.fill();
      g.fillStyle = '#fff';
      g.strokeStyle = '#0a0b0d';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, y, 6.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      const slope = C.slopeAt(ys, Math.min(0.995, Math.max(0.005, head)));
      speedEl.textContent = `${Math.round(slope * BASE)}%`;
      speedEl.style.color = speedColor(slope);
    }

    // Which source frames the clip shows: one tick per timeline frame, placed
    // at its source position. Ticks bunch up where the ramp is slow.
    const r = fit(ribbon);
    r.g.clearRect(0, 0, r.w, r.h);
    r.g.fillStyle = 'rgba(255,255,255,0.04)';
    r.g.fillRect(0, 0, r.w, r.h);
    for (let i = 0; i < FRAMES; i++) {
      const tx = i / (FRAMES - 1);
      const sx = C.valueAt(ys, tx);
      const played = head === null || tx <= head;
      r.g.globalAlpha = played ? 1 : 0.22;
      r.g.fillStyle = speedColor(C.slopeAt(ys, Math.min(0.995, Math.max(0.005, tx))));
      r.g.fillRect(Math.round(4 + sx * (r.w - 10)), 5, 2, r.h - 10);
    }
    r.g.globalAlpha = 1;
  }

  let visible = true;
  new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; }).observe(graph);
  function loop(now) {
    if (visible) drawHero(now);
    requestAnimationFrame(loop);
  }
  if (reduce) {
    ys = to;
    drawHero(cycleStart + MORPH + SWEEP * 0.5);
    window.addEventListener('resize', () => drawHero(cycleStart + MORPH + SWEEP * 0.5));
  } else {
    requestAnimationFrame(loop);
  }

  // ---------- demo ----------

  const stage = $('#demoStage');
  const frame = $('#demoFrame');
  const fitDemo = () => {
    frame.style.transform = `scale(${stage.clientWidth / 1060})`;
  };
  new ResizeObserver(fitDemo).observe(stage);

  // ---------- copy ----------

  document.querySelectorAll('.copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(document.getElementById(btn.dataset.copy).textContent);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Select and copy';
      }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
    });
  });
})();
