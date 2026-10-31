const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTrace, summarizeTrace, importRun } = require('../src/records/traces');
const { compare, asMarkdown } = require('../src/comparison/core');

const hash = 'a'.repeat(64);
function trace() {
  const event = (sequence, kind, outcome, extra = {}) => ({ sequence, id: 'trace:' + sequence,
    operationId: kind === 'tool' ? 'tool-1' : 'model-1', kind, outcome, content: [], ...extra });
  return {
    schemaVersion: 1, id: 'trace', runId: 'run', attempt: 2, outcome: 'Completed',
    captureCompleteness: 'complete', contentSnapshotsEnabled: false,
    requestedDeployment: 'deployment-alias', runtimeVersion: 'build-1', agentDefinitionSha256: hash,
    events: [
      event(1, 'context', 'Captured', { content: [{ kind: 'user-message', text: null, sha256: hash,
        originalCharacters: 20, redacted: false, truncated: false }] }),
      event(2, 'model', 'Started'),
      event(3, 'model', 'Returned', { reportedModel: 'actual-model', inputTokens: 100, outputTokens: 20,
        cachedInputTokens: 10, reasoningTokens: 5 }),
      event(4, 'tool', 'Requested', { toolCallId: 'provider-call', parentOperationId: 'model-1', name: 'read_tool' }),
      event(5, 'tool', 'Started', { name: 'read_tool' }),
      event(6, 'tool', 'Returned', { name: 'read_tool' })
    ]
  };
}
function exportedRun() {
  return { schemaVersion: 1, kind: 'codemind-agent-run', variant: {
    model: 'deployment-alias', provider: 'manual', runId: 'run', prompt: '', response: 'Answer',
    executionTrace: trace()
  } };
}

test('imports a single CodeMind attempt into either side and preserves the other side', () => {
  for (const side of ['baseline', 'candidate']) {
    const other = side === 'baseline' ? 'candidate' : 'baseline';
    const existing = { prompt: 'Task', evidence: 'Frozen evidence', [other]: { response: 'Original' } };
    const imported = importRun(exportedRun(), existing, side);
    assert.equal(imported[other].response, 'Original');
    assert.equal(imported.evidence, 'Frozen evidence');
    const result = compare(imported);
    assert.deepEqual(result[side].executionTrace, trace());
    assert.deepEqual(compare(JSON.parse(JSON.stringify(result)))[side].executionTrace, trace());
    assert.match(asMarkdown(result), /deployment-alias/);
    assert.match(asMarkdown(result), /Content snapshots are unavailable/);
  }
});

test('reports per-request usage without double-counting cached or reasoning subsets', () => {
  const summary = summarizeTrace(validateTrace(trace()));
  assert.equal(summary.inputTokens, 100);
  assert.equal(summary.outputTokens, 20);
  assert.equal(summary.modelCalls, 1);
  assert.equal(summary.requestedTools, 1);
  assert.equal(summary.executedTools, 1);
  assert.equal(summary.failedTools, 0);
});

test('preserves the registry attempt number without assuming one-based indexing', () => {
  const input = trace();
  input.attempt = 0;
  assert.equal(validateTrace(input).attempt, 0);
});

test('missing calls or usage stay unknown while known subtotals are retained', () => {
  const input = trace();
  input.events.push({ sequence: 7, id: 'trace:7', operationId: 'model-2', kind: 'model', outcome: 'Started', content: [] });
  let summary = summarizeTrace(validateTrace(input));
  assert.equal(summary.inputTokens, null);
  assert.equal(summary.knownInputTokens, 100);
  assert.equal(summary.missingUsageCalls, 1);
  input.captureCompleteness = 'partial';
  input.outcome = 'Processing';
  summary = summarizeTrace(validateTrace(input));
  assert.match(summary.warnings.join(' '), /partial.*Processing/);
});

test('denied or malformed calls are not counted as executions and pending calls are visible', () => {
  const input = trace();
  input.events = input.events.filter(event => event.sequence !== 5);
  input.events[4].outcome = 'Denied';
  let summary = summarizeTrace(validateTrace(input));
  assert.equal(summary.requestedTools, 1);
  assert.equal(summary.executedTools, 0);
  assert.equal(summary.rejectedTools, 1);
  input.events.pop();
  summary = summarizeTrace(validateTrace(input));
  assert.match(summary.warnings.join(' '), /no recorded terminal outcome/);
});

test('validates version, identity, sequences, token types, and bounded opt-in content', () => {
  const invalid = [
    input => { input.schemaVersion = 2; },
    input => { input.events[1].sequence = 1; },
    input => { input.events[2].inputTokens = '100'; },
    input => { input.events[0].content[0].text = 'secret'; },
    input => { input.contentSnapshotsEnabled = true; input.events[0].content[0].text = 'x'.repeat(16001); },
    input => { input.events = Array.from({ length: 513 }, () => input.events[0]); }
  ];
  for (const mutate of invalid) {
    const input = trace();
    mutate(input);
    assert.throws(() => validateTrace(input), /trace|retention/);
  }
  const run = exportedRun();
  run.variant.runId = 'other-run';
  assert.throws(() => importRun(run), /identities/);
});

test('preserves bounded redacted snapshots and warns about replay limitations', () => {
  const input = trace();
  input.contentSnapshotsEnabled = true;
  Object.assign(input.events[0].content[0], { text: 'token=[redacted]', redacted: true, truncated: true });
  assert.deepEqual(validateTrace(input), input);
  assert.match(summarizeTrace(input).warnings.join(' '), /redactions.*truncated/);
});

test('model/prompt-only mode warns about unfrozen evidence and trace differences', () => {
  const baseline = { response: 'A', executionTrace: trace() };
  const candidate = structuredClone(baseline);
  candidate.executionTrace.events[0].content[0].sha256 = 'b'.repeat(64);
  const result = compare({ comparisonMode: 'model-prompt-only', baseline, candidate });
  assert.equal(result.fairness.status, 'limited');
  assert.ok(result.fairness.warnings.some(warning => warning.code === 'execution-confounder'));
  assert.ok(result.fairness.warnings.some(warning => warning.code === 'replay-unverified'));
});
