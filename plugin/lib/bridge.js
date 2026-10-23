// Talks to DaVinci Resolve through the Workflow Integration API.
//
// Resolve's scripting API cannot set clip speed, so everything goes through the
// clip's Fusion comp. Comp time runs in source frames and the edit-page speed is
// applied after Fusion, so a TimeStretcher in the comp can redistribute speed
// while the clip keeps its timeline length and source range.
//
// Fusion comps on adjustment clips are not processed when made by a script, so
// an adjustment clip only marks a time range: its effects are written into the
// comps of the video clips under it, faded by an envelope over that range.

const lua = require('./lua');
const { tcToFrame } = require('./timecode');

const ITEMS_TTL_MS = 1500;
const GAP_RESCAN_MS = 600;
const STATE_TTL_MS = 2000;
const LUA_TIMEOUT_MS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Short id used in Fusion tool names (letters and digits only).
const gidOf = (uniqueId) => String(uniqueId).replace(/[^0-9a-zA-Z]/g, '').slice(0, 8) || 'x';

// The JS API throws where Python returns None (GetMediaPoolItem on an adjustment
// clip, GetData on a key that was never set).
const safe = async (fn) => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

const parseJson = (s) => {
  if (typeof s !== 'string' || !s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

class Bridge {
  constructor(WI, pluginId) {
    this.WI = WI;
    this.pluginId = pluginId;
    this.resolve = null;
    this.queue = Promise.resolve();
    this.seq = 0;
    this.tl = null; // { id, obj, name, fps, df, items, itemsAt }
    this.states = new Map(); // item id -> { at, ramp, fx: Map(gid -> data) }
    this.meta = new Map(); // item id -> { name, isMedia, enabled }
    this.current = null; // last context with live objects
  }

  // Runs Resolve calls one at a time so polling never interleaves with an apply.
  exec(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async connect() {
    if (this.resolve) return this.resolve;
    if (!(await this.WI.Initialize(this.pluginId))) throw new Error('Could not connect to DaVinci Resolve');
    this.resolve = await this.WI.GetResolve();
    if (!this.resolve) throw new Error('Could not connect to DaVinci Resolve');
    return this.resolve;
  }

  cleanup() {
    this.resolve = null;
    return this.WI.CleanUp();
  }

  // Runs Lua inside a comp and returns its result. Comp.Execute returns before
  // the script finishes, so the script writes "<token>|ok|<json>" to comp data.
  async lua(comp, body) {
    const token = `t${++this.seq}x${Date.now()}`;
    // Resolve skips a comp it still considers untouched (as AddFusionComp makes
    // it), and edits made from inside the comp do not change that. Adding a tool
    // through the API does; the Lua side deletes this loose router again.
    await safe(() => comp.AddTool('PipeRouter', -32768, -32768));
    try {
      await comp.Execute(lua.wrap(token, body));
    } catch (e) {
      // Execute returns nothing and the bridge fails to parse that; the script still runs.
      if (!/Unknown object type/.test(String(e))) throw e;
    }
    const t0 = Date.now();
    for (let i = 0; ; i++) {
      const io = await safe(() => comp.GetData('RampMe.io'));
      if (typeof io === 'string' && io.startsWith(`${token}|`)) {
        const rest = io.slice(token.length + 1);
        if (rest.startsWith('ok|')) return parseJson(rest.slice(3));
        throw new Error(`Fusion: ${rest.slice(4)}`);
      }
      if (Date.now() - t0 > LUA_TIMEOUT_MS) throw new Error('Fusion did not answer in time');
      await sleep(i < 20 ? 2 : 15);
    }
  }

  async timeline() {
    const r = await this.connect();
    const project = await (await r.GetProjectManager()).GetCurrentProject();
    if (!project) return null;
    const tl = await project.GetCurrentTimeline();
    if (!tl) return null;
    const id = await tl.GetUniqueId();
    if (!this.tl || this.tl.id !== id) {
      const fps = parseFloat(await tl.GetSetting('timelineFrameRate')) || 24;
      const df = String(await tl.GetSetting('timelineDropFrameTimecode')) === '1';
      this.tl = { id, obj: tl, name: await tl.GetName(), fps, df, items: null, itemsAt: 0 };
      this.states.clear();
      this.meta.clear();
    }
    this.tl.obj = tl;
    return this.tl;
  }

  // Video items of the current timeline. Each API call costs ~0.1 ms, so only
  // id and position are read on every scan; name and type are kept per id.
  // maxAge 0 forces a fresh scan.
  async items(maxAge = ITEMS_TTL_MS) {
    const t = this.tl;
    if (t.items && Date.now() - t.itemsAt < maxAge) return t.items;
    const tl = t.obj;
    const count = await tl.GetTrackCount('video');
    const list = [];
    for (let track = 1; track <= count; track++) {
      if (!(await tl.GetIsTrackEnabled('video', track))) continue;
      for (const obj of (await tl.GetItemListInTrack('video', track)) || []) {
        const id = await obj.GetUniqueId();
        let meta = this.meta.get(id);
        if (!meta) {
          const mpi = await safe(() => obj.GetMediaPoolItem());
          const type = mpi ? String(await safe(() => mpi.GetClipProperty('Type'))) : '';
          meta = { name: await obj.GetName(), isMedia: Boolean(mpi) && !/^audio$/i.test(type), enabled: await obj.GetClipEnabled() };
          this.meta.set(id, meta);
        }
        if (!meta.enabled) continue;
        list.push({ obj, track, id, ...meta, start: await obj.GetStart(), end: await obj.GetEnd() });
      }
    }
    t.items = list;
    t.itemsAt = Date.now();
    return list;
  }

  async readState(item, force = false) {
    const cached = this.states.get(item.id);
    if (!force && cached && Date.now() - cached.at < STATE_TTL_MS) return cached;
    const state = { at: Date.now(), ramp: null, fx: new Map(), hasComp: false };
    if ((await item.obj.GetFusionCompCount()) > 0) {
      const comp = await item.obj.GetFusionCompByIndex(1);
      if (comp) {
        state.hasComp = true;
        state.ramp = parseJson(await safe(() => comp.GetData('RampMe.state')));
      }
    }
    this.states.set(item.id, state);
    return state;
  }

  async readFx(item, gid) {
    const state = await this.readState(item);
    if (!state.hasComp) return null;
    if (!state.fx.has(gid)) {
      const comp = await item.obj.GetFusionCompByIndex(1);
      state.fx.set(gid, parseJson(comp && (await safe(() => comp.GetData(`RampMe.fx.${gid}`)))));
    }
    return state.fx.get(gid);
  }

  // Base speed from the edit page, in percent of real time. The source times are
  // those of the first and last frame shown, so they span duration - 1 frames.
  async speedOf(item) {
    try {
      const startT = await item.obj.GetSourceStartTime();
      const endT = await item.obj.GetSourceEndTime();
      const dur = item.end - item.start;
      if (dur > 1 && endT > startT) {
        const raw = ((endT - startT) * this.tl.fps * 100) / (dur - 1);
        // The source times land a fraction of a frame off; 601.3% is really 600%.
        const round5 = Math.round(raw / 5) * 5;
        return Math.abs(raw - round5) <= Math.max(1, raw * 0.004) ? round5 : Math.round(raw);
      }
    } catch {
      // Older Resolve versions lack the time getters.
    }
    return null;
  }

  affected(range, items) {
    if (range.kind === 'clip') return items.filter((i) => i.id === range.id);
    return items.filter((i) => i.isMedia && i.track < range.track && i.start < range.end && i.end > range.start);
  }

  // Snapshot of what is under the playhead, safe to send to the window.
  async context() {
    const t = await this.timeline();
    if (!t) {
      this.current = null;
      return { status: 'noTimeline' };
    }
    const frame = tcToFrame(await t.obj.GetCurrentTimecode(), t.fps, t.df);
    let items = await this.items();
    const at = (list) => list.filter((i) => i.start <= frame && frame < i.end).sort((a, b) => b.track - a.track);
    let here = at(items);
    // The cache may be stale after an edit; look again before saying "nothing
    // here", but not on every poll while the playhead sits in a gap.
    if (!here.length) {
      items = await this.items(GAP_RESCAN_MS);
      here = at(items);
    }
    const media = here.find((i) => i.isMedia) || null;
    const adj = here.find((i) => !i.isMedia && (!media || i.track > media.track)) || null;

    const ctx = { status: 'ok', timeline: { name: t.name, fps: t.fps }, frame, media: null, range: null };
    if (media) {
      const state = await this.readState(media);
      ctx.media = {
        id: media.id,
        name: media.name,
        track: media.track,
        start: media.start,
        end: media.end,
        speed: await this.speedOf(media),
        ramp: state.ramp,
      };
    }
    const rangeItem = adj || media;
    if (rangeItem) {
      const range = this.rangeOf(rangeItem);
      const under = this.affected(range, items);
      const stored = await this.storedFx(range, items);
      range.clips = under.length;
      range.fx = stored ? stored.settings : null;
      // Re-apply when the adjustment clip was moved or trimmed, or clips under it changed.
      range.stale = Boolean(stored) && (stored.rangeStart !== range.start || stored.rangeEnd !== range.end ||
        String(stored.items) !== String(under.map((i) => i.id)));
      ctx.range = range;
    }
    this.current = { ctx, media, items };
    return ctx;
  }

  // An adjustment clip marks a range for the clips under it; a video clip is its own range.
  rangeOf(item) {
    return {
      kind: item.isMedia ? 'clip' : 'adjustment',
      id: item.id,
      gid: gidOf(item.id),
      name: item.name,
      track: item.track,
      start: item.start,
      end: item.end,
    };
  }

  // Edits name their target by id: the playhead may have moved on by the time
  // a queued edit runs, and it must still land on the clip it was made for.
  async find(id) {
    if (!this.tl) await this.timeline();
    if (!this.tl) return null;
    const hit = (await this.items()).find((i) => i.id === id);
    return hit || (await this.items(0)).find((i) => i.id === id) || null;
  }

  async ensureComp(item) {
    if ((await item.obj.GetFusionCompCount()) === 0) {
      if (!(await item.obj.AddFusionComp())) throw new Error(`Could not add a Fusion comp to ${item.name}`);
    }
    const comp = await item.obj.GetFusionCompByIndex(1);
    if (!comp) throw new Error(`Could not open the Fusion comp of ${item.name}`);
    return comp;
  }

  async applyRamp({ mediaId, anchors, samples, mode }) {
    const media = await this.find(mediaId);
    if (!media || !media.isMedia) throw new Error('That clip is no longer on the timeline');
    const comp = await this.ensureComp(media);
    const state = { v: 1, anchors, mode };
    const res = await this.lua(comp, lua.rampApply({ samples, mode, state: JSON.stringify(state) }));
    // Resolve resamples the comp output to the edit-page speed; nearest keeps
    // the comp's frames exact instead of blending them a second time.
    await media.obj.SetProperty('RetimeProcess', 1);
    const cached = await this.readState(media);
    cached.ramp = state;
    cached.hasComp = true;
    return res;
  }

  async clearRamp({ mediaId }) {
    const media = await this.find(mediaId);
    if (!media || !media.isMedia) throw new Error('That clip is no longer on the timeline');
    if ((await media.obj.GetFusionCompCount()) === 0) return { empty: true };
    const comp = await media.obj.GetFusionCompByIndex(1);
    const res = await this.lua(comp, lua.rampClear());
    const cached = await this.readState(media);
    cached.ramp = null;
    return res;
  }

  // Writes the effect settings into every clip under the current range and
  // removes them from clips that left the range since the last apply.
  async applyFx({ rangeId, settings }) {
    const target = await this.find(rangeId);
    if (!target) throw new Error('That clip is no longer on the timeline');
    const range = this.rangeOf(target);
    const items = await this.items();
    const under = this.affected(range, items);
    if (!under.length) throw new Error('No video clip under this adjustment clip');
    const stored = await this.storedFx(range, items);
    const previous = items.filter((i) => stored && stored.items.includes(i.id) && !under.includes(i));

    const data = JSON.stringify({ v: 1, settings, rangeStart: range.start, rangeEnd: range.end, items: under.map((i) => i.id) });
    for (const item of under) {
      const comp = await this.ensureComp(item);
      await this.lua(comp, lua.fxApply({
        gid: range.gid,
        settings,
        itemStart: item.start,
        itemDuration: item.end - item.start,
        rangeStart: range.start,
        rangeEnd: range.end,
        data,
      }));
      const state = await this.readState(item);
      state.hasComp = true;
      state.fx.set(range.gid, JSON.parse(data));
    }
    for (const item of previous) await this.removeFx(item, range.gid);
    return { clips: under.length };
  }

  async clearFx({ rangeId }) {
    const target = await this.find(rangeId);
    if (!target) return { clips: 0 };
    const range = this.rangeOf(target);
    const items = await this.items();
    const stored = await this.storedFx(range, items);
    const ids = new Set([...this.affected(range, items).map((i) => i.id), ...(stored ? stored.items : [])]);
    let n = 0;
    for (const item of items.filter((i) => ids.has(i.id))) {
      if (await this.readFx(item, range.gid)) {
        await this.removeFx(item, range.gid);
        n++;
      }
    }
    return { clips: n };
  }

  // Effect data of a range, read from the first clip under it that has some.
  async storedFx(range, items) {
    for (const item of this.affected(range, items)) {
      const stored = await this.readFx(item, range.gid);
      if (stored && Array.isArray(stored.items)) return stored;
    }
    return null;
  }

  async removeFx(item, gid) {
    const comp = await item.obj.GetFusionCompByIndex(1);
    if (!comp) return;
    await this.lua(comp, lua.fxApply({
      gid, settings: {}, itemStart: item.start, itemDuration: item.end - item.start, rangeStart: 0, rangeEnd: 1, data: '',
    }));
    (await this.readState(item)).fx.set(gid, null);
  }
}

module.exports = { Bridge, gidOf };
