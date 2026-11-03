const test = require('node:test');
const assert = require('node:assert/strict');
const { withModelTimeout } = require('../src/providers/vscode/request');
const { runWithVsCode } = require('../src/providers/vscode/generation');

function api() {
  const sources = [];
  class CancellationError extends Error {}
  class CancellationTokenSource {
    constructor() {
      this.listeners = new Set();
      this.token = { isCancellationRequested: false, onCancellationRequested: listener => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      } };
      sources.push(this);
    }
    cancel() {
      this.token.isCancellationRequested = true;
      for (const listener of this.listeners) listener();
    }
    dispose() { this.disposed = true; }
  }
  return { sources, CancellationTokenSource, CancellationError,
    LanguageModelChatMessage: { User: content => ({ role: 'user', content }) } };
}

test('a reasoning request still running at the old 180-second cutoff can finish normally', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const vscode = api();
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = withModelTimeout(vscode, undefined, undefined, () => {
    started();
    return new Promise(resolve => { finish = resolve; });
  });
  await ready;
  t.mock.timers.tick(180001);
  assert.equal(vscode.sources[0].token.isCancellationRequested, false);
  finish('long reasoning completed');
  assert.equal(await pending, 'long reasoning completed');
  t.mock.timers.tick(600000);
  assert.equal(vscode.sources[0].token.isCancellationRequested, false, 'Completed requests must clear the timer');
});

test('default timeout allows requests past 180 seconds and enforces 600 seconds even if providers ignore cancellation', async t => {
  const vscode = api();
  let expire, delay, cleared;
  t.mock.method(global, 'setTimeout', (callback, ms) => { expire = callback; delay = ms; return 42; });
  t.mock.method(global, 'clearTimeout', id => { cleared = id; });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = withModelTimeout(vscode, undefined, undefined, () => {
    started();
    return new Promise(() => {});
  });
  const rejected = assert.rejects(pending, /600 seconds.*Advanced settings.*No automatic retry/);
  await ready;
  assert.equal(delay, 600000);
  expire();
  await rejected;
  assert.equal(vscode.sources[0].token.isCancellationRequested, true);
  assert.equal(vscode.sources[0].disposed, true);
  assert.equal(cleared, 42);
});

test('cancellation interrupts unresponsive providers, removes listeners, and skips pre-cancelled work', async () => {
  const vscode = api();
  const parent = new vscode.CancellationTokenSource();
  let calls = 0;
  const pending = withModelTimeout(vscode, parent.token, 30, () => {
    calls++;
    return new Promise(() => {});
  });
  const rejected = assert.rejects(pending, vscode.CancellationError);
  await Promise.resolve();
  parent.cancel();
  await rejected;
  assert.equal(calls, 1);
  assert.equal(parent.listeners.size, 0);
  await assert.rejects(withModelTimeout(vscode, parent.token, 30, () => { calls++; }), vscode.CancellationError);
  assert.equal(calls, 1);
});

test('successful work and provider errors dispose timers without hiding errors or retrying', async t => {
  const vscode = api();
  const parent = new vscode.CancellationTokenSource();
  let cleared = 0;
  const realClear = global.clearTimeout;
  t.mock.method(global, 'clearTimeout', timer => { cleared++; realClear(timer); });
  assert.equal(await withModelTimeout(vscode, parent.token, 30, async () => 'ok'), 'ok');
  const error = new Error('quota exceeded');
  let calls = 0;
  await assert.rejects(withModelTimeout(vscode, parent.token, 30, () => { calls++; throw error; }), value => value === error);
  assert.equal(calls, 1);
  assert.equal(cleared, 2);
  assert.equal(parent.listeners.size, 0);
  assert.ok(vscode.sources.slice(1).every(source => source.disposed));
  for (const seconds of [0, 29, 3601, 60.5, '600', null, NaN]) {
    await assert.rejects(withModelTimeout(vscode, undefined, seconds, () => { calls++; }), /30 and 3600/);
  }
  assert.equal(calls, 1);
});

for (const stage of ['input tokens', 'request', 'stream', 'mid-stream', 'output tokens']) {
  test('configured timeout interrupts stalled ' + stage, async t => {
    const vscode = api();
    let expire, delay, reached;
    const ready = new Promise(resolve => { reached = resolve; });
    t.mock.method(global, 'setTimeout', (callback, ms) => { expire = callback; delay = ms; return 1; });
    t.mock.method(global, 'clearTimeout', () => {});
    const stall = () => { reached(); return new Promise(() => {}); };
    let counts = 0, requests = 0;
    const model = { id: 'slow-model', maxInputTokens: 10000,
      countTokens: async () => {
        counts++;
        return (stage === 'input tokens' && counts === 1) || (stage === 'output tokens' && counts === 2) ? stall() : 10;
      },
      sendRequest: async () => {
        requests++;
        if (stage === 'request') return stall();
        return { text: (async function* () {
          if (stage === 'stream') await stall();
          yield 'complete answer';
          if (stage === 'mid-stream') await stall();
        })() };
      }
    };
    const phases = [];
    const pending = runWithVsCode(vscode, { prompt: 'Hard coding problem' }, model, undefined,
      { timeoutSeconds: 900, onProgress: phase => phases.push(phase) });
    const expectedPhase = { 'input tokens': 'counting input tokens', request: 'waiting for provider response',
      stream: 'waiting for response stream', 'mid-stream': 'receiving response stream',
      'output tokens': 'counting output tokens' }[stage];
    const rejected = assert.rejects(pending, error => {
      assert.equal(error.code, 'COMPARELAB_MODEL_TIMEOUT');
      assert.ok(error.message.includes('slow-model (' + expectedPhase + ') timed out after 900 seconds'));
      return true;
    });
    await ready;
    assert.equal(delay, 900000);
    expire();
    await rejected;
    assert.ok(requests <= 1);
    assert.equal(phases.at(-1), expectedPhase);
    assert.equal(vscode.sources[0].token.isCancellationRequested, true);
  });
}
