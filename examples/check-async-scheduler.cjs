'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

if (process.argv.length !== 3) {
  console.error('Usage: node examples/check-async-scheduler.cjs /absolute/path/to/solution.cjs');
  process.exit(1);
}
const { runTasks } = require(path.resolve(process.argv[2]));
assert.equal(typeof runTasks, 'function', 'Export module.exports = { runTasks }');
const check = (name, fn) => test(name, { timeout: 2000 }, fn);
const fulfilled = value => ({ status: 'fulfilled', value });
const rejected = reason => ({ status: 'rejected', reason });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

check('validation rejects through a Promise before starting ANY task', async () => {
  let calls = 0;
  const task = () => { calls++; };
  const aborted = new AbortController();
  aborted.abort();
  const inputs = [
    [null], [{}], [[task, null]], [[task, , task]],
    [[task], null], [[task], []], [[task], 'options'],
    ...[0, -1, 1.5, NaN, Infinity, '2', Number.MAX_SAFE_INTEGER + 1]
      .map(concurrency => [[task], { concurrency }]),
    [[task], { signal: {} }], [[], { concurrency: 0 }],
    [[task, null], { signal: aborted.signal }]
  ];
  for (const args of inputs) {
    let result;
    assert.doesNotThrow(() => { result = runTasks(...args); });
    assert.ok(result instanceof Promise, 'Invalid input must still return a Promise');
    await assert.rejects(result, TypeError);
  }
  assert.equal(calls, 0);
});

check('empty input resolves with no results', async () => {
  assert.deepEqual(await runTasks([]), []);
});

check('fills two slots by default and refills a free slot out of order', async () => {
  const gates = Array.from({ length: 4 }, deferred);
  const started = [];
  let active = 0, peak = 0;
  const pending = runTasks(gates.map((gate, index) => async signal => {
    assert.equal(signal, undefined);
    started.push(index);
    peak = Math.max(peak, ++active);
    try { return await gate.promise; } finally { active--; }
  }));
  await tick();
  assert.deepEqual(started, [0, 1]);
  gates[1].resolve('one');
  await tick();
  assert.deepEqual(started, [0, 1, 2], 'Task 2 must start before task 0 finishes');
  gates[2].resolve('two');
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[3].resolve('three');
  gates[0].resolve('zero');
  assert.deepEqual(await pending, ['zero', 'one', 'two', 'three'].map(fulfilled));
  assert.equal(peak, 2);
});

check('honors explicit concurrency one and above the roster length', async () => {
  for (const concurrency of [1, 10]) {
    const gates = Array.from({ length: 3 }, deferred);
    const started = [];
    const pending = runTasks(gates.map((gate, i) => () => {
      started.push(i);
      return gate.promise;
    }), { concurrency });
    await tick();
    assert.deepEqual(started, concurrency === 1 ? [0] : [0, 1, 2]);
    for (let i = 0; i < gates.length; i++) {
      gates[i].resolve(i);
      await tick();
      if (concurrency === 1) assert.deepEqual(started, [0, 1, 2].slice(0, i + 2));
    }
    assert.deepEqual(await pending, [0, 1, 2].map(fulfilled));
  }
});

check('handles throws, rejections, values, and hostile thenables without stopping', async () => {
  const reason = new Error('task failure');
  const value = { ok: true };
  const badThen = Object.defineProperty({}, 'then', { get() { throw reason; } });
  const result = await runTasks([
    () => { throw reason; },
    () => Promise.reject(reason),
    () => value,
    () => ({ then(resolve, reject) { resolve('first'); reject(reason); resolve('last'); } }),
    () => badThen,
    () => undefined
  ], { concurrency: 2 });
  assert.deepEqual(result, [rejected(reason), rejected(reason), fulfilled(value),
    fulfilled('first'), rejected(reason), fulfilled(undefined)]);
  assert.equal(result[0].reason, reason);
  assert.equal(result[2].value, value);
});

check('pre-aborted input skips all tasks and preserves the exact reason', async () => {
  for (const reason of [undefined, { code: 'cancelled' }]) {
    const controller = new AbortController();
    controller.abort(reason);
    let calls = 0;
    const result = await runTasks([() => calls++, () => calls++], { signal: controller.signal });
    assert.equal(calls, 0);
    assert.deepEqual(result, [rejected(controller.signal.reason), rejected(controller.signal.reason)]);
    assert.equal(result[0].reason, controller.signal.reason);
    if (reason === undefined) assert.equal(result[0].reason.name, 'AbortError');
    assert.deepEqual(await runTasks([], { signal: controller.signal }), []);
  }
});

check('synchronous abort inside a task prevents even the next initial launch', async () => {
  const controller = new AbortController();
  const reason = { stop: true };
  let skippedCalls = 0;
  const value = { completed: true };
  const result = await runTasks([
    signal => { assert.equal(signal, controller.signal); controller.abort(reason); return value; },
    () => skippedCalls++,
    () => skippedCalls++
  ], { concurrency: 3, signal: controller.signal });
  assert.equal(skippedCalls, 0);
  assert.deepEqual(result, [fulfilled(value), rejected(reason), rejected(reason)]);
});

check('abort waits for active work and keeps its actual success and failure', async () => {
  const controller = new AbortController();
  const first = deferred(), second = deferred();
  const reason = new Error('cancel queued work');
  const taskFailure = new Error('active task failed');
  const started = [];
  const pending = runTasks([first, second, deferred()].map((gate, i) => signal => {
    assert.equal(signal, controller.signal);
    started.push(i);
    return gate.promise;
  }), { concurrency: 2, signal: controller.signal });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await tick();
  assert.deepEqual(started, [0, 1]);
  controller.abort(reason);
  await tick();
  assert.equal(settled, false);
  first.resolve('finished despite abort');
  await tick();
  assert.equal(settled, false);
  second.reject(taskFailure);
  assert.deepEqual(await pending, [fulfilled('finished despite abort'),
    rejected(taskFailure), rejected(reason)]);
  assert.deepEqual(started, [0, 1]);
});

check('abort after a completed task preserves its result and skips queued work', async () => {
  const controller = new AbortController();
  const gate = deferred();
  let skippedCalls = 0;
  const pending = runTasks([() => 'done', () => gate.promise, () => skippedCalls++],
    { concurrency: 1, signal: controller.signal });
  await tick();
  controller.abort('stop');
  gate.resolve('also done');
  assert.deepEqual(await pending, [fulfilled('done'), fulfilled('also done'), rejected('stop')]);
  assert.equal(skippedCalls, 0);
});

check('does not mutate frozen input and supports repeated independent runs', async () => {
  const tasks = Object.freeze([() => 1, () => 2]);
  const options = Object.freeze({ concurrency: 1 });
  const result = await Promise.all([runTasks(tasks, options), runTasks(tasks, options)]);
  assert.deepEqual(result, [[fulfilled(1), fulfilled(2)], [fulfilled(1), fulfilled(2)]]);
});

check('large synchronous batches invoke each task once without stack overflow', async () => {
  const size = 20000;
  const calls = new Uint8Array(size);
  const result = await runTasks(Array.from({ length: size }, (_, i) => () => {
    calls[i]++;
    return i;
  }), { concurrency: 4 });
  assert.equal(result.length, size);
  for (let i = 0; i < size; i++) {
    assert.equal(calls[i], 1);
    assert.deepEqual(result[i], fulfilled(i));
  }
});
