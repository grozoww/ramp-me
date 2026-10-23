const test = require('node:test');
const assert = require('node:assert/strict');
const { tcToFrame } = require('../plugin/lib/timecode.js');

test('non-drop timecode', () => {
  assert.equal(tcToFrame('00:00:00:10', 30, false), 10);
  assert.equal(tcToFrame('01:00:00:00', 24, false), 86400);
  assert.equal(tcToFrame('00:00:02:15', 30, false), 75);
  assert.equal(tcToFrame('00:01:00:00', 23.976, false), 1440);
});

test('drop-frame timecode', () => {
  assert.equal(tcToFrame('00:01:00;02', 29.97, true), 1800);
  assert.equal(tcToFrame('00:10:00;00', 29.97, true), 17982);
  assert.equal(tcToFrame('00:01:00;04', 59.94, true), 3600);
});

test('bad input', () => {
  assert.equal(tcToFrame('', 30, false), null);
  assert.equal(tcToFrame('12:00', 30, false), null);
});
