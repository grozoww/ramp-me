(function () {
  'use strict';
  const C = window.RMCurve;
  const { GraphEditor, drawThumb } = window.RMGraph;
  const api = window.rampme;

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const copy = (v) => JSON.parse(JSON.stringify(v));

  const FX_DEFAULTS = {
    blurPeak: 'middle',
    fxPeak: 'middle',
    blur: { on: false, type: 'zoom', strength: 40, angle: 0, center: [0.5, 0.5] },
    shake: { on: false, strength: 35, frequency: 60, blur: true },
    warp: { on: false, strength: 40 },
    aberration: { on: false, strength: 40 },
    glow: { on: false, strength: 40, size: 40 },
  };
  const PEAKS = [
    ['start', 'Start', 'M1 1 Q 6 10 21 11'],
    ['middle', 'Middle', 'M1 11 Q 11 -9 21 11'],
    ['end', 'End', 'M1 11 Q 16 10 21 1'],
    ['full', 'Full', 'M1 11 L3 1 L19 1 L21 11'],
  ];

  const state = {
    tab: 'graph',
    ctx: null,
    mediaId: null,
    rangeId: undefined,
    anchors: C.linear(),
    smoothness: 'off',
    prefs: { smoothness: 'off', presets: [] },
    activePreset: null,
    history: [],
    future: [],
    fx: copy(FX_DEFAULTS),
  };

  // ---------- helpers ----------

  let toastTimer = null;
  function toast(msg, kind = 'error') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast ${kind === 'info' ? 'info' : ''}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
  }

  async function call(fn, ...args) {
    const res = await fn(...args);
    if (!res.ok) toast(res.error);
    return res;
  }

  const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  function set(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    keys.reduce((o, k) => o[k], obj)[last] = value;
  }

  function mergeFx(stored) {
    const fx = copy(FX_DEFAULTS);
    if (!stored || typeof stored !== 'object') return fx;
    for (const key of Object.keys(fx)) {
      if (typeof fx[key] === 'object') Object.assign(fx[key], stored[key] || {});
      else if (typeof stored[key] === typeof fx[key]) fx[key] = stored[key];
    }
    return fx;
  }

  function matchPreset(anchors) {
    const all = [...C.PRESETS, ...state.prefs.presets];
    const hit = all.find((p) => C.same(C.normalize(p.anchors), anchors));
    return hit ? hit.id : null;
  }

  // ---------- graph ----------

  const editor = new GraphEditor($('#graph'), {
    onChange: (anchors) => {
      state.anchors = anchors;
      state.activePreset = null;
      markPreset();
      scheduleRamp();
    },
    onCommit: (anchors) => {
      commit(anchors);
      scheduleRamp();
    },
    onHover: (slope) => renderSpeed(slope),
  });
  let committed = C.linear();
  const histories = new Map(); // clip id -> { history, future, committed }

  function commit(anchors) {
    if (C.same(anchors, committed)) return;
    state.history.push(committed);
    if (state.history.length > 100) state.history.shift();
    state.future = [];
    committed = C.clone(anchors);
    state.anchors = C.clone(anchors);
    state.activePreset = matchPreset(state.anchors);
    markPreset();
  }

  function setCurve(anchors, { record = true, send = true } = {}) {
    const next = C.normalize(anchors);
    if (record) commit(next);
    else committed = C.clone(next);
    state.anchors = next;
    state.activePreset = matchPreset(next);
    editor.setCurve(next);
    markPreset();
    renderSpeed(null);
    if (send) sendRamp();
  }

  function undo(redo = false) {
    const from = redo ? state.future : state.history;
    const to = redo ? state.history : state.future;
    if (!from.length) return;
    to.push(committed);
    const anchors = from.pop();
    committed = C.clone(anchors);
    state.anchors = C.clone(anchors);
    state.activePreset = matchPreset(anchors);
    editor.setCurve(anchors);
    markPreset();
    sendRamp();
  }

  let rampTimer = null;
  function scheduleRamp() {
    if (rampTimer) return;
    rampTimer = setTimeout(() => {
      rampTimer = null;
      sendRamp();
    }, 40);
  }

  async function sendRamp() {
    if (!state.ctx || !state.ctx.media) return;
    const samples = C.sample(state.anchors).map((v) => Math.round(v * 1e5) / 1e5);
    await call(api.applyRamp, { mediaId: state.mediaId, anchors: state.anchors, samples, mode: state.smoothness });
  }

  function renderSpeed(slope) {
    const el = $('#speedReadout');
    const base = state.ctx && state.ctx.media && state.ctx.media.speed;
    const fmt = (s) => (base ? `${Math.round(s * base)}%` : `×${s.toFixed(2)}`);
    if (slope === null || slope === undefined) {
      const [lo, hi] = C.slopeRange(editor.ys);
      el.innerHTML = `Speed <b>${fmt(lo)}</b> – <b>${fmt(hi)}</b>`;
    } else {
      el.innerHTML = `Speed here <b>${fmt(slope)}</b>`;
    }
  }

  function renderPresets() {
    const box = $('#presets');
    box.textContent = '';
    const card = (p, custom) => {
      const b = document.createElement('button');
      b.className = 'preset';
      b.dataset.id = p.id;
      b.title = p.name;
      const cv = document.createElement('canvas');
      const name = document.createElement('span');
      name.textContent = p.name;
      b.append(cv, name);
      if (custom) {
        const del = document.createElement('button');
        del.className = 'del';
        del.textContent = '×';
        del.title = 'Delete preset';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          state.prefs.presets = state.prefs.presets.filter((q) => q.id !== p.id);
          savePrefs();
          renderPresets();
        });
        b.append(del);
      }
      b.addEventListener('click', () => {
        if (!state.ctx || !state.ctx.media) {
          toast('Put the playhead over a video clip first');
          return;
        }
        setCurve(p.anchors);
      });
      box.append(b);
      requestAnimationFrame(() => drawThumb(cv, C.normalize(p.anchors)));
    };
    C.PRESETS.forEach((p) => card(p, false));
    if (state.prefs.presets.length) {
      const t = document.createElement('div');
      t.className = 'label group-title';
      t.textContent = 'My presets';
      box.append(t);
      state.prefs.presets.forEach((p) => card(p, true));
    }
    markPreset();
  }

  function markPreset() {
    $$('.preset').forEach((el) => el.classList.toggle('active', el.dataset.id === state.activePreset));
  }

  function renderSmoothness() {
    $$('#smoothness button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === state.smoothness)));
  }

  async function savePrefs() {
    await call(api.setPrefs, state.prefs);
  }

  // ---------- effects ----------

  let fxTimer = null;
  function scheduleFx() {
    clearTimeout(fxTimer);
    fxTimer = setTimeout(async () => {
      if (!state.ctx || !state.ctx.range) {
        toast('Put the playhead over an adjustment clip or a video clip');
        return;
      }
      await call(api.applyFx, { rangeId: state.rangeId, settings: state.fx });
    }, 60);
  }

  function renderFx() {
    const fx = state.fx;
    $$('[data-fx]').forEach((el) => {
      const v = get(fx, el.dataset.fx);
      if (el.type === 'checkbox') el.checked = Boolean(v);
      else el.value = v;
      const out = el.parentElement.querySelector('output');
      if (out) out.textContent = el.value;
    });
    $$('[data-fx-seg]').forEach((seg) => {
      const v = get(fx, seg.dataset.fxSeg);
      $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)));
    });
    $$('[data-show]').forEach((el) => {
      const [path, value] = el.dataset.show.split('=');
      el.hidden = get(fx, path) !== value;
    });
    $$('.card').forEach((card) => {
      const sw = $('.card-head input', card);
      if (sw) card.classList.toggle('off', !sw.checked);
    });
    const dot = $('#centerPad .pad-dot');
    dot.style.left = `${fx.blur.center[0] * 100}%`;
    dot.style.top = `${(1 - fx.blur.center[1]) * 100}%`;
  }

  function bindFx() {
    $$('[data-fx]').forEach((el) => {
      el.addEventListener('input', () => {
        const v = el.type === 'checkbox' ? el.checked : Number(el.value);
        set(state.fx, el.dataset.fx, v);
        renderFx();
        scheduleFx();
      });
    });
    $$('.seg.peak').forEach((seg) => {
      seg.innerHTML = PEAKS.map(([v, label, d]) =>
        `<button data-value="${v}" title="${label}"><svg viewBox="0 0 22 12"><path d="${d}"/></svg>${label}</button>`).join('');
    });
    $$('[data-fx-seg]').forEach((seg) => {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        set(state.fx, seg.dataset.fxSeg, b.dataset.value);
        renderFx();
        scheduleFx();
      });
    });
    const pad = $('#centerPad');
    const movePad = (e) => {
      const r = pad.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      state.fx.blur.center = [Math.round(x * 1000) / 1000, Math.round((1 - y) * 1000) / 1000];
      renderFx();
      scheduleFx();
    };
    pad.addEventListener('pointerdown', (e) => {
      pad.setPointerCapture(e.pointerId);
      movePad(e);
    });
    pad.addEventListener('pointermove', (e) => {
      if (pad.hasPointerCapture(e.pointerId)) movePad(e);
    });
    pad.addEventListener('dblclick', () => {
      state.fx.blur.center = [0.5, 0.5];
      renderFx();
      scheduleFx();
    });
  }

  // ---------- context ----------

  function renderStatus() {
    const ctx = state.ctx;
    const dot = $('#connDot');
    const text = $('#connText');
    dot.className = 'dot';
    if (!ctx) {
      text.textContent = 'Connecting…';
    } else if (ctx.status === 'ok') {
      dot.classList.add('ok');
      text.textContent = 'Connected to Resolve';
    } else if (ctx.status === 'noTimeline') {
      text.textContent = 'Open a timeline';
    } else {
      dot.classList.add('bad');
      text.textContent = ctx.message || 'Not connected';
    }
    $('#tlName').textContent = ctx && ctx.timeline ? ctx.timeline.name : '';
  }

  function renderTarget() {
    const ctx = state.ctx;
    const kind = $('#targetKind');
    const name = $('#targetName');
    const meta = $('#targetMeta');
    const notice = $('#notice');
    notice.hidden = true;
    const fps = ctx && ctx.timeline ? ctx.timeline.fps : 0;
    const secs = (frames) => (fps ? `${(frames / fps).toFixed(1)} s` : `${frames} fr`);
    const empty = (text) => {
      kind.textContent = '—';
      kind.className = 'target-kind off';
      name.textContent = text;
      meta.textContent = '';
    };
    if (!ctx || ctx.status !== 'ok') {
      empty(ctx && ctx.status === 'noTimeline' ? 'Open a timeline in Resolve' : 'Waiting for Resolve');
      return;
    }
    kind.className = 'target-kind';
    if (state.tab === 'graph') {
      const m = ctx.media;
      if (!m) return empty('Move the playhead over a video clip');
      kind.textContent = 'Clip';
      name.textContent = m.name;
      const parts = [`V${m.track}`, secs(m.end - m.start)];
      if (m.speed) parts.push(`<b>${m.speed}%</b>`);
      if (m.ramp) parts.push('<b>ramped</b>');
      meta.innerHTML = parts.join(' · ');
      if (m.speed && m.speed <= 105) {
        notice.textContent = 'This clip plays at 100%. Speed it up first (for example to 600% with Retime Controls), then pick a ramp: the slow parts land near real time.';
        notice.hidden = false;
      }
    } else {
      const r = ctx.range;
      if (!r) return empty('Move the playhead over an adjustment clip or a video clip');
      kind.textContent = r.kind === 'adjustment' ? 'Adjustment clip' : 'Whole clip';
      name.textContent = r.name;
      const parts = [`V${r.track}`, secs(r.end - r.start)];
      if (r.kind === 'adjustment') parts.push(`${r.clips} clip${r.clips === 1 ? '' : 's'} under it`);
      meta.innerHTML = parts.join(' · ');
      if (r.kind === 'adjustment' && !r.clips) {
        notice.textContent = 'There is no video clip under this adjustment clip.';
        notice.hidden = false;
      }
    }
  }

  function onContext(ctx) {
    state.ctx = ctx;
    renderStatus();
    renderTarget();
    // Reload only when a different clip comes under the playhead. A gap or a
    // failed poll keeps the editor as is, so edits still on their way to
    // Resolve are not overwritten by older data read back from the comp.
    const m = ctx.status === 'ok' ? ctx.media : null;
    if (m && m.id !== state.mediaId) {
      if (state.mediaId) histories.set(state.mediaId, { history: state.history, future: state.future, committed });
      state.mediaId = m.id;
      const ramp = m.ramp;
      const anchors = C.normalize(ramp && C.isValid(ramp.anchors) ? ramp.anchors : C.linear());
      // Keep this clip's undo steps from an earlier visit, unless its curve
      // was changed elsewhere since (then they would undo into the wrong shape).
      const saved = histories.get(m.id);
      const keep = saved && C.same(saved.committed, anchors);
      state.history = keep ? saved.history : [];
      state.future = keep ? saved.future : [];
      state.smoothness = ramp ? (ramp.mode === 'flow' ? 'flow' : 'off') : state.prefs.smoothness;
      setCurve(anchors, { record: false, send: false });
      renderSmoothness();
    }
    editor.setEnabled(Boolean(m));
    editor.setBaseSpeed(m ? m.speed : null);
    renderSpeed(null);
    $('#btnClear').disabled = !(m && m.ramp);

    const r = ctx.status === 'ok' ? ctx.range : null;
    if (r && r.id !== state.rangeId) {
      state.rangeId = r.id;
      state.fx = mergeFx(r.fx);
      renderFx();
    }
  }

  // ---------- wiring ----------

  function showTab(tab) {
    state.tab = tab;
    $$('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    renderTarget();
  }

  $$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  $('#smoothness').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.smoothness = b.dataset.value;
    state.prefs.smoothness = state.smoothness;
    renderSmoothness();
    savePrefs();
    if (state.ctx && state.ctx.media && (state.ctx.media.ramp || !C.same(state.anchors, C.linear()))) sendRamp();
  });

  $('#pinned').addEventListener('change', (e) => {
    state.prefs.pinned = e.target.checked;
    savePrefs();
    call(api.setPinned, state.prefs.pinned);
  });

  $('#btnReverse').addEventListener('click', () => {
    if (!state.ctx || !state.ctx.media) return toast('Put the playhead over a video clip first');
    setCurve(C.reverse(state.anchors));
  });

  $('#btnClear').addEventListener('click', async () => {
    const res = await call(api.clearRamp, { mediaId: state.mediaId });
    if (res.ok) setCurve(C.linear(), { send: false });
  });

  $('#btnSave').addEventListener('click', () => {
    $('#saveRow').hidden = false;
    $('#saveName').value = '';
    $('#saveName').focus();
  });
  $('#saveCancel').addEventListener('click', () => { $('#saveRow').hidden = true; });
  $('#saveRow').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#saveName').value.trim();
    if (!name) return;
    const preset = { id: `u${Date.now()}`, name, anchors: C.clone(state.anchors) };
    state.prefs.presets.push(preset);
    state.activePreset = preset.id;
    $('#saveRow').hidden = true;
    savePrefs();
    renderPresets();
    toast(`Saved "${name}"`, 'info');
  });

  $('#btnClearFx').addEventListener('click', async () => {
    if (!state.ctx || !state.ctx.range) return toast('Put the playhead over an adjustment clip or a video clip');
    const res = await call(api.clearFx, { rangeId: state.rangeId });
    if (res.ok) {
      state.fx = copy(FX_DEFAULTS);
      renderFx();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof Element && e.target.closest('input, textarea')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (state.tab === 'graph') undo(e.shiftKey);
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && state.tab === 'graph') {
      editor.removeSelected();
    }
  });

  // Read-only view of the editor state, for checks from the developer hooks.
  window.RMDebug = () => ({
    anchors: C.clone(state.anchors),
    history: state.history.length,
    future: state.future.length,
    mediaId: state.mediaId,
  });

  async function init() {
    bindFx();
    const prefs = await api.getPrefs();
    if (prefs.ok && prefs.result) {
      state.prefs = prefs.result;
      state.prefs.presets = state.prefs.presets.filter((p) => C.isValid(p.anchors));
    }
    state.smoothness = state.prefs.smoothness;
    $('#pinned').checked = state.prefs.pinned !== false;
    renderSmoothness();
    renderPresets();
    renderFx();
    showTab('graph');
    api.onContext(onContext);
    const ctx = await api.getContext();
    onContext(ctx.ok ? ctx.result : { status: 'error', message: ctx.error });
  }

  init();
})();
