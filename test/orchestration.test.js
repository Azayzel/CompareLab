const test = require('node:test');
const assert = require('node:assert/strict');
const { composeAgentTask, createTestPlan, pairEvidence, orchestrateTest, summarizeTest, validateTestRecord } = require('../src/orchestration');
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

test('end-to-end plans do not require evidence and do not claim live tools are unavailable', () => {
  const input = { ...experiment(), comparisonMode: 'end-to-end', evidence: '' };
  const plan = createTestPlan(input);
  assert.equal(plan.comparisonMode, 'end-to-end');
  assert.equal(plan.investigationMode, 'full-agent');
  assert.equal(plan.evidence, '');
  assert.match(plan.requestPrompt, /approved Datadog MCP tools/);
  assert.match(plan.requestPrompt, /targeted list_datadog_skills query/);
  assert.match(plan.requestPrompt, /required telemetry/);
  assert.doesNotMatch(plan.requestPrompt, /No live tools are available/);
  assert.doesNotMatch(plan.requestPrompt, /at most 8|reserve the final request/);
  assert.throws(() => createTestPlan({ ...input, comparisonMode: 'model-prompt-only' }), /requires Source evidence/);
  const alertPlan = createTestPlan({ ...input, incomingMessage: '{"eventId":"123","monitorId":"456"}' });
  assert.match(alertPlan.systemPrompt, /approved Datadog MCP tools/);
  assert.match(alertPlan.requestPrompt, /Supplied reference evidence/);
});

test('end-to-end results require real tool evidence before review and validate on import', async () => {
  const input = { ...experiment(), comparisonMode: 'end-to-end', evidence: '', test: { repetitions: 1 } };
  const runner = runners();
  const generate = runner.runVariant;
  const failed = await orchestrateTest(input, runner);
  assert.equal(failed.status, 'partial');
  assert.equal(runner.reviews.length, 0);
  assert.match(failed.pairs[0].baseline.error, /valid Datadog MCP evidence/);
  runner.runVariant = async (input, side) => ({ ...await generate(input, side),
    toolEvidence: [{ tool: 'datadog-search_logs', input: { query: side }, collectedAt: new Date().toISOString(), content: side + ' logs' }] });
  const record = await orchestrateTest(input, runner);
  assert.equal(record.status, 'completed');
  assert.deepEqual(validateTestRecord(record), record);
  assert.match(runner.reviews[0].evidence, /baseline logs/);
  assert.match(runner.reviews[0].evidence, /candidate logs/);
  assert.equal(summarizeTest(record).preference, 'candidate');
  const tampered = structuredClone(record);
  tampered.pairs[0].baseline.result.toolEvidence = [];
  assert.throws(() => validateTestRecord(tampered), /Invalid controlled-test record/);
  const guide = { tool: 'mcp_observability_load_datadog_skill', input: { skill_name: 'datadog/logs' },
    collectedAt: new Date().toISOString(), content: 'GUIDANCE_ONLY: use valid query syntax' };
  record.pairs[0].baseline.result.toolEvidence.unshift(guide);
  assert.deepEqual(validateTestRecord(record), record);
  assert.doesNotMatch(pairEvidence(record.plan, record.pairs[0]), /GUIDANCE_ONLY/);
  assert.match(pairEvidence(record.plan, record.pairs[0]), /baseline logs/);
  tampered.pairs[0].baseline.result.toolEvidence = [guide];
  assert.throws(() => validateTestRecord(tampered), /Invalid controlled-test record/);
  record.pairs[0].baseline.result.toolEvidence[1].tool = 'mcp_observability_aggregate_spans';
  assert.deepEqual(validateTestRecord(record), record);
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

test('full-agent records retain more than eight queries and 50,000 evidence characters through import', async () => {
  const input = { ...experiment(), comparisonMode: 'end-to-end', evidence: '', test: { repetitions: 1 } };
  const runner = runners();
  runner.runVariant = async input => ({ ...input, response: 'Answer.', elapsedMs: 20,
    estimatedInputTokens: 123, estimatedOutputTokens: 45, inputTokens: null, outputTokens: null,
    toolEvidence: Array.from({ length: 10 }, () => ({ tool: 'datadog-search_datadog_logs', input: { query: '401' },
      collectedAt: new Date().toISOString(), content: 'x'.repeat(7000) })) });
  const record = await orchestrateTest(input, runner);
  assert.equal(record.status, 'completed');
  const saved = JSON.parse(JSON.stringify(record));
  assert.deepEqual(validateTestRecord(saved), saved);
  const summary = summarizeTest(record);
  assert.equal(summary.metrics.baseline.estimatedInputTokens, 123);
  assert.equal(summary.metrics.baseline.estimatedOutputTokens, 45);
  assert.equal(summary.metrics.baseline.inputTokens, null);
});

test('historical budget-limited records keep their original fingerprints, warnings, and evidence on reopen', async () => {
  const { DATADOG_LIMITS } = require('../src/datadog');
  const input = { ...experiment(), comparisonMode: 'end-to-end', evidence: '', test: { repetitions: 1 } };
  const runner = runners();
  runner.runVariant = async input => ({ ...input, response: 'Limited answer.', toolEvidence: [{
    tool: 'datadog-search_datadog_logs', input: { query: '401' }, collectedAt: new Date().toISOString(),
    content: 'HTTP 401', truncated: true, originalCharacters: 10000, retainedCharacters: 8
  }] });
  const record = await orchestrateTest(input, runner);
  record.plan = createTestPlan(input, { legacyBudget: true });
  assert.equal(record.plan.investigationMode, undefined);
  for (const side of ['baseline', 'candidate']) {
    const result = record.pairs[0][side].result;
    result.prompt = record.plan.requestPrompt;
    result.investigationBudget = { limits: DATADOG_LIMITS, modelRequests: 2, toolCalls: 1, skippedToolCalls: 0,
      evidenceCharacters: JSON.stringify(result.toolEvidence).length, limited: true, reasons: ['Tool result was truncated.'] };
  }
  assert.deepEqual(validateTestRecord(record), record);
  const displayed = { ...input, testRun: record,
    baseline: { ...record.plan.baseline, response: 'Limited answer.' },
    candidate: { ...record.plan.candidate, response: 'Limited answer.' } };
  assert.ok(compare(displayed).testRun, 'Reopening a historical record must not silently drop it');
  assert.equal(compare({ ...displayed, prompt: 'Edited task' }).testRun, null);
  const summary = summarizeTest(record);
  assert.equal(summary.preference, 'inconclusive');
  assert.equal(summary.counts.unresolved, 1);
  assert.match(summary.warnings.join(' '), /truncated/);
  for (const corrupt of [
    result => { result.toolEvidence[0].retainedCharacters++; },
    result => { result.investigationBudget.evidenceCharacters++; },
    result => { result.investigationBudget.toolCalls = 9; },
    result => { result.investigationBudget.limited = false; }
  ]) {
    const altered = structuredClone(record);
    corrupt(altered.pairs[0].baseline.result);
    assert.throws(() => validateTestRecord(altered), /Invalid controlled-test record/);
  }
});

test('prompt tests hold model settings fixed, send each exact prompt, and retain correct review tasks through import', async () => {
  const input = { prompt: '', incomingMessage: 'Alert 123', evidence: 'HTTP 401 increased.', comparisonKind: 'prompt',
    test: { repetitions: 2 }, baseline: { provider: 'ollama', model: 'shared-model', prompt: 'Investigate {{alert}}.' },
    candidate: { provider: 'ollama', model: 'shared-model', prompt: 'Verify authentication for {{alert}}.' } };
  const runner = runners();
  const record = await orchestrateTest(input, runner);
  assert.equal(record.status, 'completed');
  assert.equal(record.plan.comparisonKind, 'prompt');
  assert.equal(record.plan.prompts.baseline, input.baseline.prompt);
  assert.equal(record.plan.prompts.candidate, input.candidate.prompt);
  for (const { input: request, side } of runner.calls) {
    assert.equal(request.model, 'shared-model');
    assert.match(request.prompt, side === 'baseline' ? /Investigate Alert 123/ : /Verify authentication for Alert 123/);
    assert.doesNotMatch(request.prompt, side === 'baseline' ? /Verify authentication/ : /Investigate Alert 123/);
  }
  for (const review of runner.reviews) {
    assert.equal(review.comparisonKind, 'prompt');
    assert.equal(review.baseline.prompt, input.baseline.prompt);
    assert.equal(review.candidate.prompt, input.candidate.prompt);
  }
  assert.equal(summarizeTest(record).preference, 'candidate');
  assert.deepEqual(validateTestRecord(record), record);
  const pair = record.pairs.at(-1);
  const displayed = { ...input, testRun: record,
    baseline: { ...record.plan.baseline, prompt: input.baseline.prompt, response: pair.baseline.result.response },
    candidate: { ...record.plan.candidate, prompt: input.candidate.prompt, response: pair.candidate.result.response } };
  assert.ok(compare(displayed).testRun);
  assert.ok(!compare(displayed).fairness.warnings.some(warning => warning.code === 'prompt-variation'));
  assert.equal(compare({ ...displayed, candidate: { ...displayed.candidate, prompt: 'Edited instructions' } }).testRun, null);
  const altered = structuredClone(record);
  altered.plan.requests.candidate.prompt = 'Altered request';
  assert.throws(() => validateTestRecord(altered), /Invalid controlled-test record/);
  for (const changed of [{ model: 'other' }, { temperature: 0.5 }, { provider: 'openai' }, { endpoint: 'http://localhost:9999' }]) {
    const invalid = { ...input, candidate: { ...input.candidate, ...changed } };
    assert.throws(() => createTestPlan(invalid), /one shared model/);
    assert.throws(() => compare(invalid), /one shared model/);
  }
  assert.throws(() => createTestPlan({ ...input, candidate: { ...input.candidate, prompt: '' } }), /candidate prompt/);
});

test('prompt-specific agent instructions remain separate system messages for normalized alerts', async () => {
  const input = { prompt: '', comparisonKind: 'prompt', comparisonMode: 'end-to-end', evidence: '',
    incomingMessage: '{"eventId":"123","monitorId":"456"}', test: { repetitions: 1 },
    baseline: { provider: 'ollama', model: 'shared', prompt: 'Baseline agent instructions' },
    candidate: { provider: 'ollama', model: 'shared', prompt: 'Candidate agent instructions' } };
  const requests = [];
  const record = await orchestrateTest(input, { ...runners(), runVariant: async (request, side) => {
    requests.push(request);
    assert.match(request.systemPrompt, side === 'baseline' ? /^Baseline agent instructions/ : /^Candidate agent instructions/);
    assert.match(request.prompt, /^Analyze this Datadog alert event:/);
    return { ...request, response: side + ' answer', toolEvidence: [{
      tool: 'datadog-search_datadog_logs', input: { query: side }, content: 'HTTP 401', collectedAt: new Date().toISOString()
    }] };
  } });
  assert.equal(record.status, 'completed');
  assert.equal(requests.length, 2);
  assert.deepEqual(validateTestRecord(record), record);
});
