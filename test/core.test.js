const test = require('node:test');
const assert = require('node:assert/strict');
const { compare, diffText } = require('../src/core');

test('identical text is unchanged', () => {
  assert.deepEqual(diffText('hello world', 'hello world'), [{ type: 'equal', text: 'hello world' }]);
});
test('shows changes without losing either response', () => {
  const d = diffText('A cat naps.', 'A dog naps.');
  assert.equal(d.filter(x => x.type !== 'add').map(x => x.text).join(''), 'A cat naps.');
  assert.equal(d.filter(x => x.type !== 'remove').map(x => x.text).join(''), 'A dog naps.');
});
test('unknown model metadata never silently becomes fair', () => {
  assert.equal(compare({ baseline: { response: 'a' }, candidate: { response: 'b' } }).fairness.status, 'unverified');
});
test('truncated completion limits validity', () => {
  const r = compare({ prompt: 'test', baseline: { response: 'a', finishReason: 'length' }, candidate: { response: 'b' } });
  assert.equal(r.fairness.status, 'limited');
});
test('different prompts are flagged', () => {
  const r = compare({ baseline: { prompt: 'A', response: 'a' }, candidate: { prompt: 'B', response: 'b' } });
  assert.ok(r.fairness.warnings.some(x => x.code === 'prompt-variation'));
});
test('requirement checks are deterministic and case-insensitive', () => {
  const r = compare({ baseline: { response: 'Nope' }, candidate: { response: 'Use HTTP 401' }, checks: { requiredPhrases: ['401'] } });
  assert.deepEqual(r.checks[0], { phrase: '401', baseline: false, candidate: true });
});
test('long inputs degrade gracefully without large allocation', () => {
  const a = Array(600).fill('a').join(' ');
  const b = Array(600).fill('b').join(' ');
  assert.equal(diffText(a, b).length, 2);
});
