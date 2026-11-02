'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateChecks, assessmentDecision, comparisonDecision } = require('../src/comparison/decision');
const { compare, asMarkdown } = require('../src/comparison/core');
const { orchestrateTest, summarizeTest, validateTestRecord } = require('../src/comparison/orchestration');
const { promptDecision } = require('../src/comparison/prompt-review');
const { asHtml } = require('../src/reporting/html');

const review = (verdict = 'candidate') => ({
  verdict, preferenceEstablished: true, orderConsistent: true, summary: 'Cited evidence supports this response.',
  criteria: [{ criterion: 'grounding', verdict, rationale: 'Supported by the evidence.', citations: [] }],
  model: { name: 'Evaluator', id: 'evaluator' }, judgments: [], unknowns: [], inputTokenEstimates: []
});
const input = () => ({
  prompt: 'Investigate.', evidence: 'HTTP 401 increased.', test: { repetitions: 3 },
  checks: { requiredPhrases: ['401'] },
  baseline: { provider: 'ollama', model: 'one', response: 'HTTP 401 observed.' },
  candidate: { provider: 'ollama', model: 'two', response: 'Check authentication.' }
});
const run = (source, assessment = review()) => orchestrateTest(source, {
  comparePair: compare, evaluatePair: async () => assessment,
  runVariant: async (request, side) => ({ ...request, response: source[side].response, elapsedMs: 100 })
});

test('required checks inspect visible response content, not provider envelope metadata', () => {
  const checks = evaluateChecks({ response: 'HTTP 401 observed.' },
    { response: JSON.stringify({ model: '401', analysis: 'Authentication issue.' }) },
    { requiredPhrases: ['http', '401', '', 12] });
  assert.deepEqual(checks, [{ phrase: 'http', baseline: true, candidate: false },
    { phrase: '401', baseline: true, candidate: false }]);
});

test('a failed required check blocks the judged winner without awarding the opponent', () => {
  for (const winner of ['baseline', 'candidate']) {
    const checks = [{ phrase: '401', baseline: true, candidate: true }];
    assert.equal(assessmentDecision(review(winner), { checks }).preference, winner);
    checks[0][winner] = false;
    const decision = assessmentDecision(review(winner), { checks });
    assert.equal(decision.status, 'blocked');
    assert.equal(decision.preference, null);
    assert.match(decision.reasons.join(' '), /failed required checks.*401/);
    assert.equal(assessmentDecision(review(winner === 'baseline' ? 'candidate' : 'baseline'), { checks }).status, 'preferred');
  }
});

test('baseline retention, order disagreement and unsupported judgments do not become preferences', () => {
  for (const update of [
    { verdict: 'baseline', preferenceEstablished: false }, { verdict: 'tie' },
    { orderConsistent: false }, { orderConsistent: null }, { criteria: [] }
  ]) {
    const decision = assessmentDecision({ ...review(update.verdict || 'candidate'), ...update });
    assert.equal(decision.preference, null);
    assert.equal(decision.status, 'inconclusive');
    assert.ok(decision.reasons.length);
  }
});

test('direct review exports preserve the judge but suppress recommendations that fail acceptance', () => {
  const result = { ...compare(input()), evaluation: review() };
  assert.equal(comparisonDecision(result).preference, null);
  const markdown = asMarkdown(result);
  assert.match(markdown, /failed required checks/);
  assert.doesNotMatch(markdown, /\*\*Recommend Candidate\*\*/);
  assert.match(markdown, /Evaluator judgment.*Candidate/);
  const html = asHtml(result, { css: '', markdownScript: '' });
  assert.match(html, /failed required checks/);
  assert.doesNotMatch(html, /★ Preferred|<h3 class="verdict">Recommend Candidate/);
  assert.match(html, /Evaluator judgment.*candidate/);
  assert.equal(result.evaluation.verdict, 'candidate');
});

test('repeated and imported decisions recompute acceptance from outputs rather than saved check booleans', async () => {
  const source = input();
  const record = await run(source);
  assert.equal(record.status, 'completed');
  const initial = summarizeTest(record);
  assert.deepEqual(initial.acceptance.candidate, { passed: 0, failed: 3, total: 3 });
  assert.equal(initial.preference, 'inconclusive');
  assert.equal(initial.counts.candidate, 0);
  assert.equal(initial.counts.unresolved, 3);
  assert.ok(initial.pairDecisions.every(decision => decision.status === 'blocked'));
  for (const pair of record.pairs) pair.checks = [{ phrase: '401', baseline: true, candidate: true }];
  const reopened = validateTestRecord(JSON.parse(JSON.stringify(record)));
  assert.deepEqual(summarizeTest(reopened).acceptance, initial.acceptance);
  const result = compare({ ...source, testRun: reopened });
  assert.match(asMarkdown(result), /candidate 0\/3/);
  const html = asHtml(result, { css: '', markdownScript: '' });
  assert.doesNotMatch(html, /★ Preferred/);
});

test('a passing winner remains eligible when only its opponent fails required checks', async () => {
  const source = input();
  source.baseline.response = 'Roll back.';
  source.candidate.response = 'HTTP 401 supports checking authentication.';
  const summary = summarizeTest(await run(source));
  assert.equal(summary.preference, 'candidate');
  assert.equal(summary.acceptance.baseline.failed, 3);
  assert.equal(summary.acceptance.candidate.passed, 3);
  assert.equal(summary.blockers.length, 0);
  assert.ok(summary.warnings.some(warning => warning.includes('baseline failed required')));
});

test('metadata-only edits cannot be promoted in direct or repeated prompt reviews', async () => {
  const source = { ...input(), comparisonKind: 'prompt', incomingMessage: '{"eventId":"example","monitorId":"123"}',
    baseline: { provider: 'ollama', model: 'one', prompt: '---\nname: original\n---\nInvestigate.', response: '401' },
    candidate: { provider: 'ollama', model: 'one', prompt: '---\nname: edited\n---\nInvestigate.', response: '401' } };
  const assessment = { ...review(), promptChanges: [{ change: 'Renamed metadata', effect: 'improvement', citations: [] }] };
  const direct = { ...compare(source), evaluation: assessment, fairness: { warnings: [] } };
  assert.equal(direct.promptComparison.effectiveChanged, false);
  assert.equal(promptDecision(direct).verdict, 'No clear improvement');
  assert.match(promptDecision(direct).reason, /effective model instructions are identical/);
  const record = await run(source, assessment);
  assert.equal(summarizeTest(record).preference, 'inconclusive');
  assert.ok(summarizeTest(record).pairDecisions.every(decision => decision.status === 'blocked'));
});

test('a majority cannot hide a required-check failure in a losing pair', async () => {
  const source = input();
  source.candidate.response = 'HTTP 401 supports checking authentication.';
  const record = await run(source);
  record.pairs[1].candidate.result.response = 'Missing required phrase.';
  record.pairs[1].evaluation = review('baseline');
  const summary = summarizeTest(record);
  assert.equal(summary.counts.candidate, 2);
  assert.equal(summary.counts.baseline, 1);
  assert.equal(summary.acceptance.candidate.failed, 1);
  assert.equal(summary.preference, 'inconclusive');
  assert.match(summary.warnings.join(' '), /cannot be recommended/);
});

test('timing ratios require observations for every pair, excluding incomplete and negative timings', async () => {
  const source = input();
  source.checks.requiredPhrases = [];
  const record = await run(source);
  assert.equal(summarizeTest(record).efficiency[2].value, '1.00x baseline');
  for (const value of [undefined, -1]) {
    record.pairs[1].baseline.result.elapsedMs = value;
    const summary = summarizeTest(record);
    assert.equal(summary.metrics.baseline.latencySamples, 2);
    assert.equal(summary.metrics.candidate.latencySamples, 2);
    assert.equal(summary.efficiency[2].value, 'Not comparable');
  }
});
