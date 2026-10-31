const test = require('node:test');
const assert = require('node:assert/strict');
const { usageTurn, validateUsageTurns, estimateTurn, usageReport, activity, efficiencyMetrics } = require('../src/metrics/usage');
const prices = require('../src/metrics/azure-prices');

test('verified Azure meters use USD per million, including normalized 1K meters', () => {
  assert.equal(Object.keys(prices.models).length, 21);
  assert.equal(prices.checkedAt, '2026-10-28');
  for (const [model, rates] of Object.entries(prices.models)) {
    const cost = estimateTurn(usageTurn({ model, inputTokens: 1000000, outputTokens: 1000000 }));
    assert.equal(cost.shortUsd, rates[0] + rates[1]);
    assert.equal(cost.longUsd, (rates[2] ?? rates[0]) + (rates[3] ?? rates[1]));
  }
  assert.equal(estimateTurn(usageTurn({ model: 'gpt-4.1-mini', inputTokens: 1000, outputTokens: 1000 })).shortUsd, 0.002);
});

test('costs preserve both context scenarios and sum each turn without premature rounding', () => {
  const turns = [usageTurn({ model: 'gpt-5.6-luna', estimatedInputTokens: 448206, estimatedOutputTokens: 13428 }),
    usageTurn({ model: 'gpt-6.1-sol', estimatedInputTokens: 1102049, estimatedOutputTokens: 31638 })];
  const report = usageReport(turns);
  assert.ok(Math.abs(estimateTurn(turns[0]).shortUsd - 0.1057548) < 1e-12);
  assert.equal(estimateTurn(turns[1]).shortUsd, 2.520478);
  assert.equal(estimateTurn(turns[1]).longUsd, 4.882766);
  assert.ok(Math.abs(report.shortUsd - (0.1057548 + 2.520478)) < 1e-12);
  assert.equal(report.rows[0].input, '~448,206');
  assert.match(report.hint, /short \/ long-context scenarios/);
  assert.match(report.note, /not Copilot or Azure billed cost/);
  assert.match(report.note, /not a billing range/);
  assert.equal(report.rows[1].short, '$2.520478');
});

test('actual counts win over estimates; unknown models and missing usage never become free requests', () => {
  const turn = usageTurn({ model: 'deployment-alias', reportedModel: 'gpt-4.1',
    inputTokens: 1000, outputTokens: 1000, estimatedInputTokens: 2000, estimatedOutputTokens: 2000 });
  assert.equal(estimateTurn(turn).shortUsd, 0.01);
  assert.equal(estimateTurn(usageTurn({ ...turn, model: 'custom-gpt-4.1' })).shortUsd, null);
  assert.equal(estimateTurn(usageTurn({ ...turn, model: '__proto__' })).shortUsd, null);
  assert.equal(estimateTurn(usageTurn({ model: 'gpt-4.1', inputTokens: 1000 })).shortUsd, null);
  assert.equal(estimateTurn(usageTurn({ model: 'gpt-4.1', inputTokens: 0, outputTokens: 0 })).shortUsd, 0);
  const report = usageReport([turn, usageTurn({ model: 'Unknown' })]);
  assert.equal(report.complete, false);
  assert.equal(report.total, 'Unknown');
  assert.equal(report.shortUsd, null);
  assert.match(report.rows[1].note, /No verified exact/);
  assert.match(usageReport().hint, /No per-turn usage recorded/);
  assert.equal(usageReport([turn], { missingRuns: true }).total, 'Unknown');
});

test('per-turn import validation rejects invalid counts and identities', () => {
  for (const value of [-1, 0.5, '100', NaN, Infinity]) {
    assert.throws(() => validateUsageTurns([{ model: 'gpt-4.1', inputTokens: value }]), /Invalid per-turn/);
  }
  for (const turns of [{}, [null], [{ model: '' }], [{ model: {} }]]) {
    assert.throws(() => validateUsageTurns(turns), /Invalid per-turn/);
  }
  assert.equal(validateUsageTurns(null), null);
});

test('activity uses recorded counts, supports old transcripts, and does not invent old full-agent turns', () => {
  assert.deepEqual(activity({ modelRequestCount: 2, toolCallCount: 9 }, true), { modelRequestCount: 2, toolCallCount: 9 });
  assert.deepEqual(activity({ requestMessages: [{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }],
    toolEvidence: [{}, {}] }, true), { modelRequestCount: 2, toolCallCount: 2 });
  assert.deepEqual(activity({}, true), { modelRequestCount: null, toolCallCount: null });
  assert.equal(activity({ usageTurns: [] }, true).modelRequestCount, null);
  assert.deepEqual(activity({}, false), { modelRequestCount: 1, toolCallCount: 0 });
});

test('relative metrics require complete comparable usage and handle zero, missing and mixed sources', () => {
  const a = { succeeded: 3, inputTokens: null, outputTokens: null, estimatedInputTokens: 448206,
    estimatedOutputTokens: 13428, medianLatencyMs: 51700 };
  const b = { succeeded: 3, inputTokens: null, outputTokens: null, estimatedInputTokens: 1102049,
    estimatedOutputTokens: 31638, medianLatencyMs: 113400 };
  const metrics = (left = a, right = b) => efficiencyMetrics({ baseline: left, candidate: right }, 3);
  assert.deepEqual(metrics().map(item => item.value), ['~2.46x baseline', '~2.36x baseline', '2.19x baseline']);
  assert.equal(metrics({ ...a, inputTokens: 448206 })[0].value, 'Not comparable');
  assert.equal(metrics({ ...a, estimatedInputTokens: 0 })[0].value, 'Not comparable');
  assert.equal(metrics(a, { ...b, estimatedInputTokens: null })[0].value, 'Not comparable');
  assert.equal(metrics(a, { ...b, succeeded: 2 })[0].value, 'Not comparable');
  assert.equal(metrics(a, { ...b, estimatedInputTokens: 0 })[0].value, '~0.00x baseline');
});
