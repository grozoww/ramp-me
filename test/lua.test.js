const test = require('node:test');
const assert = require('node:assert/strict');
const lua = require('../plugin/lib/lua.js');

test('toLua writes plain values', () => {
  assert.equal(lua.toLua(null), 'nil');
  assert.equal(lua.toLua(true), 'true');
  assert.equal(lua.toLua(0.1234567891), '0.123457');
  assert.equal(lua.toLua([1, 2]), '{1,2}');
  assert.equal(lua.toLua({ a: 1 }), '{["a"]=1}');
  assert.throws(() => lua.toLua(NaN));
});

test('toLua escapes strings so any text survives', () => {
  assert.equal(lua.toLua('a"b\\c\nd]]e'), '"a\\034b\\092c\\010d]]e"');
  // A digit right after an escaped quote must not merge into the escape.
  assert.equal(lua.toLua('["4434"]'), '"[\\0344434\\034]"');
});

test('generated scripts carry the token and settings', () => {
  const body = lua.fxApply({
    gid: 'abc12345', settings: { blur: { on: true, type: 'zoom', strength: 50, angle: 0, center: [0.5, 0.5] } },
    itemStart: 0, itemDuration: 80, rangeStart: 20, rangeEnd: 170, data: '{"v":1}',
  });
  const code = lua.wrap('tok1', body);
  assert.match(code, /^local __f, __e = loadstring\(/);
  assert.ok(code.includes('tok1'));
  assert.ok(code.includes('abc12345'));
  assert.ok(!code.includes('[[['), 'no ambiguous long brackets');
});
