const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../plugin/ui/curve.js');

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('linear curve samples to y = x', () => {
  const ys = C.sample(C.linear());
  assert.equal(ys.length, C.SAMPLES);
  for (const x of [0, 0.25, 0.5, 0.9, 1]) close(C.valueAt(ys, x), x);
  close(C.slopeAt(ys, 0.5), 1, 1e-2);
});

test('every preset is valid and keeps the source range', () => {
  for (const p of C.PRESETS) {
    assert.ok(C.isValid(p.anchors), p.id);
    assert.ok(C.same(C.normalize(p.anchors), p.anchors), `${p.id} changes when normalized`);
    const ys = C.sample(p.anchors);
    close(ys[0], 0);
    assert.ok(ys.every((y) => y >= 0 && y <= 1), p.id);
    assert.ok(Math.max(...ys) > 0.99, `${p.id} never reaches the last source frame`);
  }
});

test('forward presets never play backwards', () => {
  const reversing = new Set(['mid-reverse', 'boomerang-l', 'boomerang', 'boomerang-r']);
  for (const p of C.PRESETS.filter((q) => !reversing.has(q.id))) {
    const ys = C.sample(p.anchors);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] >= ys[i - 1] - 1e-9, `${p.id} goes back at ${i}`);
    close(ys[ys.length - 1], 1);
  }
});

test('fast-slow-fast slows to about 0.18x in the middle', () => {
  const p = C.PRESETS.find((q) => q.id === 'fast-slow-fast');
  const ys = C.sample(p.anchors);
  close(C.slopeAt(ys, 0.5), 0.18, 0.01);
  assert.ok(C.slopeAt(ys, 0.02) > 2);
});

test('reverse flips the source direction', () => {
  const ys = C.sample(C.reverse(C.linear()));
  close(ys[0], 1);
  close(ys[ys.length - 1], 0);
  close(C.slopeAt(ys, 0.5), -1, 1e-2);
});

test('normalize pins the ends and keeps handles inside their segment', () => {
  const bad = [C.anchor(0.2, -1, 0.3, 0, 0.9, 2), C.anchor(0.6, 0.5, 0.4, 0, -0.2, 0), C.anchor(0.7, 2, 0, 0, 0.5, 0)];
  const a = C.normalize(bad);
  assert.equal(a[0].x, 0);
  assert.equal(a[2].x, 1);
  assert.equal(a[0].y, 0);
  assert.equal(a[2].y, 1);
  assert.equal(a[0].ix, 0);
  assert.equal(a[2].ox, 0);
  assert.ok(a[0].ox <= a[1].x - a[0].x + 1e-12);
  close(a[0].oy / a[0].ox, 2 / 0.9);
  assert.ok(a[1].ix <= 0 && a[1].ox >= 0);
  assert.ok(C.isValid(a));
});

test('insert and remove anchors keep the curve valid', () => {
  const base = C.linear();
  const { anchors, index } = C.insertAnchor(base, 0.4, C.sample(base));
  assert.equal(index, 1);
  assert.equal(anchors.length, 3);
  close(anchors[1].y, 0.4);
  close(C.valueAt(C.sample(anchors), 0.7), 0.7, 1e-2);
  assert.equal(C.removeAnchor(anchors, 0), anchors, 'ends cannot be removed');
  assert.equal(C.removeAnchor(anchors, 1).length, 2);
});

test('isValid rejects junk', () => {
  assert.equal(C.isValid(null), false);
  assert.equal(C.isValid([{ x: 0 }]), false);
  assert.equal(C.isValid([C.anchor(0, 0), { ...C.anchor(1, 1), y: NaN }]), false);
});
