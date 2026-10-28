const test = require('node:test');
const assert = require('node:assert/strict');
const { composeAgentTask, createTestPlan, orchestrateTest, summarizeTest, validateTestRecord } = require('../src/orchestration');
const { compare } = require('../src/core');
const { codeMindAlert } = require('../src/inputs');

const experiment = () => ({ prompt: 'Diagnose the failed requests.', evidence: 'HTTP 401 increased; no deployment occurred.',
  baseline: { provider: 'ollama', model: 'baseline-model', response: 'Old response', executionTrace: { stale: true } },
  candidate: { provider: 'openai', model: 'candidate-model', endpoint: 'https://models.example.test/v1' } });

test('controlled test freezes one task/evidence packet and excludes prior outputs and traces', () => {
  const input = experiment();
  const plan = createTestPlan(input);
  assert.equal(plan.repetitions, 3);
  assert.equal(plan.baseline.endpoint, 'http://127.0.0.1:11434');
  assert.equal(plan.candidate.endpoint, input.candidate.endpoint);
  assert.match(plan.requestPrompt, /No live tools are available/);
  assert.deepEqual(JSON.parse(plan.requestPrompt.slice(plan.requestPrompt.indexOf('{'))), { task: input.prompt, evidence: input.evidence });
  assert.equal(plan.baseline.response, undefined);
  assert.equal(plan.baseline.executionTrace, undefined);
  input.evidence = 'Changed evidence';
  assert.notEqual(plan.evidence, input.evidence);
  assert.notEqual(plan.inputFingerprint, createTestPlan(input).inputFingerprint);
});

test('controlled test rejects missing evidence, invalid providers, and mismatched task overrides before requests', () => {
  const input = experiment();
  assert.throws(() => createTestPlan({ ...input, evidence: ' ' }), /requires Source evidence/);
  assert.throws(() => createTestPlan({ ...input, prompt: '' }), /requires a Shared prompt/);
  assert.throws(() => createTestPlan({ ...input, candidate: { ...input.candidate, provider: 'manual' } }), /provider for candidate/);
  assert.throws(() => createTestPlan({ ...input, baseline: { ...input.baseline, prompt: 'Different task' } }), /Clear the differing baseline/);
  assert.doesNotThrow(() => createTestPlan({ ...input, baseline: { ...input.baseline, prompt: ' \t ' } }));
  assert.throws(() => createTestPlan({ ...input, candidate: { ...input.candidate, maxOutputTokens: -1 } }), /Output cap/);
  assert.throws(() => createTestPlan({ ...input, candidate: { ...input.candidate, temperature: 4 } }), /Temperature/);
  for (const repetitions of [0, 6, 1.5, 'invalid']) assert.throws(() => createTestPlan({ ...input, test: { repetitions } }), /paired runs/);
});

function runners(options = {}) {
  const calls = [];
  const reviews = [];
  return { calls, reviews, comparePair: compare,
    runVariant: async (input, side) => {
      calls.push({ input, side });
      if (options.fail === side) throw new Error('Endpoint unavailable');
      return { ...input, response: side === 'baseline' ? 'Roll back.' : 'Check authentication.', reportedModel: input.model,
        elapsedMs: side === 'baseline' ? 100 : 150, inputTokens: 40, outputTokens: options.missingUsage ? null : 20, finishReason: 'stop' };
    },
    evaluatePair: async input => {
      reviews.push(input);
      return { verdict: 'candidate', summary: 'Check authentication.', orderConsistent: options.unstable ? false : true,
        criteria: [{ criterion: 'grounding', verdict: options.ungrounded ? 'insufficient_evidence' : 'candidate', citations: [] }],
        requestCount: 2, judgments: [], unknowns: [], inputTokenEstimates: [], model: { name: 'Reviewer' } };
    }
  };
}

test('runs fresh paired generations in alternating order and evaluates identical frozen inputs', async () => {
  const runner = runners();
  const record = await orchestrateTest(experiment(), runner);
  assert.equal(record.status, 'completed');
  assert.deepEqual(runner.calls.map(call => call.side), ['baseline', 'candidate', 'candidate', 'baseline', 'baseline', 'candidate']);
  assert.equal(new Set(runner.calls.map(call => call.input.prompt)).size, 1);
  assert.equal(runner.reviews.length, 3);
  assert.ok(runner.reviews.every(input => input.evidence === record.plan.evidence && input.prompt === record.plan.task));
  assert.equal(summarizeTest(record).preference, 'candidate');
  assert.equal(summarizeTest(record).evaluatorRequests, 6);
  assert.equal(summarizeTest(record).metrics.baseline.inputTokens, 120);
  assert.equal(summarizeTest(record).metrics.candidate.medianLatencyMs, 150);
  assert.deepEqual(validateTestRecord(record), record);
});

test('failures retain real attempts without judging stale outputs or declaring a completed test', async () => {
  const runner = runners({ fail: 'baseline', missingUsage: true });
  const record = await orchestrateTest(experiment(), runner);
  assert.equal(record.status, 'partial');
  assert.equal(runner.reviews.length, 0);
  assert.ok(record.pairs.every(pair => !pair.baseline.result && pair.candidate.status === 'succeeded'));
  const summary = summarizeTest(record);
  assert.equal(summary.preference, 'inconclusive');
  assert.equal(summary.metrics.candidate.outputTokens, null);
  assert.equal(summary.metrics.candidate.medianLatencyMs, null);
});

test('cancellation retains partial progress and prevents subsequent calls', async () => {
  const controller = new AbortController();
  const runner = runners();
  const record = await orchestrateTest(experiment(), { ...runner, signal: controller.signal, onUpdate: record => {
    if (record.pairs[0]?.baseline.status === 'succeeded') controller.abort();
  } });
  assert.equal(record.status, 'cancelled');
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.reviews.length, 0);
  assert.equal(record.pairs[0].candidate.status, 'not-started');
});

test('order bias and ungrounded defaults are unresolved rather than counted as model wins', async () => {
  for (const options of [{ unstable: true }, { ungrounded: true }]) {
    const record = await orchestrateTest(experiment(), runners(options));
    const summary = summarizeTest(record);
    assert.equal(summary.preference, 'inconclusive');
    assert.equal(summary.counts.unresolved, 3);
  }
});

test('test imports reject altered frozen inputs and invalid usage', async () => {
  const record = await orchestrateTest(experiment(), runners());
  const altered = structuredClone(record);
  altered.plan.evidence = 'Different evidence';
  assert.throws(() => validateTestRecord(altered), /Invalid controlled-test record/);
  record.pairs[0].baseline.result.inputTokens = -1;
  assert.throws(() => validateTestRecord(record), /Invalid controlled-test record/);
});

test('incoming trigger is inserted literally, once per placeholder, without interpreting its contents', () => {
  const message = '{"alert":"HTTP 401", "value":"$& {{message}}"}';
  assert.equal(composeAgentTask('Instructions\n{{alert}}', message), 'Instructions\n' + message);
  assert.equal(composeAgentTask('Instructions\n{{ message }}', message), 'Instructions\n' + message);
  assert.equal(composeAgentTask('Instructions', message), 'Instructions\n\n## Incoming message\n\n' + message);
  assert.equal(composeAgentTask('Instructions', ''), 'Instructions');
  assert.throws(() => composeAgentTask('Instructions {{alert}}', ' '), /Incoming message/);
});

test('controlled tests preserve the agent file and trigger separately while sending the same compiled task', async () => {
  const input = { ...experiment(), prompt: 'Agent instructions\nAlert: {{alert}}', incomingMessage: '{"monitor":123,"state":"Warn"}' };
  const runner = runners();
  const record = await orchestrateTest(input, runner);
  assert.equal(record.plan.instructions, input.prompt);
  assert.equal(record.plan.incomingMessage, input.incomingMessage);
  assert.equal(record.plan.task, 'Agent instructions\nAlert: ' + input.incomingMessage);
  assert.equal(runner.reviews[0].incomingMessage, input.incomingMessage);
  assert.equal(compare(runner.reviews[0]).baseline.prompt, record.plan.task);
  assert.ok(runner.calls.every(call => call.input.prompt === record.plan.requestPrompt));
  assert.deepEqual(validateTestRecord(record), record);
  assert.notEqual(createTestPlan({ ...input, incomingMessage: 'Another alert' }).inputFingerprint, record.plan.inputFingerprint);
});

test('CodeMind mapped alerts follow the normalized agent-input contract and separate message roles', async () => {
  const message = { sendAlert: true, rawEventRef: { topic: 'synthetic-alerts', partition: 0, offset: 42 }, alertEvent: {
    eventName: 'monitor', shortDescription: 'High latency', description: 'Synthetic alert body', state: 'Triggered', severity: 'P3',
    environment: 'production', ci: 'orders-api', catalog_owner: 'example-owner', standardized: { id: 'event-123', state: 'open',
      severity: 'warning', priority: 1, startTime: '2026-10-28T00:00:00Z' }, sourceSystem: { name: 'Datadog', id: 'fallback' },
    additionalDetails: { alert_id: 987654, alert_query: 'max:metric{service:orders}', service: 'orders' } } };
  const input = { ...experiment(), prompt: '---\nname: Example Agent\n---\nInvestigate {{alert}}.', incomingMessage: JSON.stringify(message) };
  const record = await orchestrateTest(input, runners());
  assert.equal(record.plan.normalizedAlert.eventId, 'event-123');
  assert.equal(record.plan.normalizedAlert.monitorId, '987654');
  assert.equal(record.plan.normalizedAlert.alertStatus, 'open');
  assert.equal(record.plan.normalizedAlert.priority, 1);
  assert.equal(record.plan.normalizedAlert.service, 'orders');
  assert.match(record.plan.systemPrompt, /^Investigate \{\{alert\}\}\./);
  assert.doesNotMatch(record.plan.systemPrompt, /name: Example Agent/);
  assert.match(record.plan.requestPrompt, /^Analyze this Datadog alert event:/);
  assert.doesNotMatch(record.plan.requestPrompt, /rawEventRef|sendAlert/);
  assert.deepEqual(validateTestRecord(record), record);
  const normalized = codeMindAlert(JSON.stringify(record.plan.normalizedAlert));
  assert.deepEqual(normalized.alert, record.plan.normalizedAlert);
  assert.throws(() => codeMindAlert('{"EventId":"123","Analysis":"Already generated"}'), /agent response/);
});

test('retaining the baseline by default is not counted as a supported preference', async () => {
  const record = await orchestrateTest(experiment(), runners());
  for (const pair of record.pairs) pair.evaluation.preferenceEstablished = false;
  assert.equal(summarizeTest(record).counts.unresolved, 3);
  assert.equal(summarizeTest(record).preference, 'inconclusive');
});

test('changing displayed responses or the trigger invalidates a saved controlled test', async () => {
  const input = { ...experiment(), incomingMessage: 'Original trigger' };
  const record = await orchestrateTest(input, runners());
  const pair = record.pairs.at(-1);
  const displayed = { ...input, testRun: record,
    baseline: { ...record.plan.baseline, response: pair.baseline.result.response },
    candidate: { ...record.plan.candidate, response: pair.candidate.result.response } };
  assert.ok(compare(displayed).testRun);
  assert.ok(!compare({ ...displayed, comparisonMode: 'model-prompt-only' }).fairness.warnings.some(warning => warning.code === 'replay-unverified'));
  assert.ok(compare({ ...displayed, testRun: null, comparisonMode: 'model-prompt-only' }).fairness.warnings.some(warning => warning.code === 'replay-unverified'));
  assert.equal(compare({ ...displayed, incomingMessage: 'Changed trigger' }).testRun, null);
  assert.equal(compare({ ...displayed, candidate: { ...displayed.candidate, response: 'Edited answer' } }).testRun, null);
});

test('VS Code plans require no endpoints and reject unsupported generation parameters', () => {
  const input = { ...experiment(), baseline: { provider: 'vscode', model: 'baseline' }, candidate: { provider: 'vscode', model: 'candidate' } };
  const plan = createTestPlan(input);
  assert.equal(plan.baseline.endpoint, undefined);
  assert.equal(plan.candidate.temperature, null);
  assert.throws(() => createTestPlan({ ...input, candidate: { ...input.candidate, temperature: 0.5 } }), /VS Code manages generation settings/);
});
