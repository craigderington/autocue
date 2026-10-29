import test from 'node:test';
import assert from 'node:assert/strict';
import { advancePosition, positionForScroll, scrollForPosition } from '../public/playback.js';

// Three lines with different word counts, including a paragraph gap before line 3.
const rows = [{ start: 0, y: 0 }, { start: 8, y: 72 }, { start: 13, y: 180 }, { start: 20, y: 252 }];

test('a minute of reading at 140 WPM advances exactly 140 words', () => {
  let position = 0;
  for (let frame = 0; frame < 3600; frame++) position = advancePosition(position, 500, 140, 1 / 60);
  assert.ok(Math.abs(position - 140) < 0.00001);
});

test('changing speed takes effect on the next frame without jumping position', () => {
  const position = advancePosition(10, 100, 120, 0.5);
  assert.equal(position, 11);
  assert.equal(advancePosition(position, 100, 240, 0.5), 13);
});

test('completion stops at the last word, including one-word scripts', () => {
  assert.equal(advancePosition(19, 20, 300, 1), 20);
  assert.equal(advancePosition(0, 1, 300, 1), 1);
});

test('continuous movement accounts for words per line and paragraph gaps', () => {
  assert.equal(scrollForPosition(rows, 0), 0);
  assert.equal(scrollForPosition(rows, 4), 36);
  assert.equal(scrollForPosition(rows, 10.5), 126);
  assert.equal(scrollForPosition(rows, 20), 252);
});

test('manual scroll maps back to reading position without losing progress', () => {
  for (const position of [0, 1, 4.5, 8, 12.99, 13, 16, 20]) {
    assert.ok(Math.abs(positionForScroll(rows, scrollForPosition(rows, position)) - position) < 0.00001);
  }
});

test('font or viewport reflow preserves the word position', () => {
  const resized = [{ start: 0, y: 0 }, { start: 4, y: 96 }, { start: 9, y: 192 }, { start: 20, y: 288 }];
  const before = scrollForPosition(rows, 10);
  const after = scrollForPosition(resized, 10);
  assert.notEqual(before, after);
  assert.equal(positionForScroll(resized, after), 10);
});

test('overscroll and empty content are bounded', () => {
  assert.equal(positionForScroll(rows, -50), 0);
  assert.equal(positionForScroll(rows, 999), 20);
  assert.equal(scrollForPosition(rows, 999), 252);
  assert.equal(scrollForPosition([], 0), 0);
  assert.equal(positionForScroll([], 100), 0);
});
