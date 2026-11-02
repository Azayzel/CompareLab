'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveReview } = require('../src/comparison/review-resolution');
const { assessmentDecision } = require('../src/comparison/decision');
const { reviewPacket, compare, asMarkdown } = require('../src/comparison/core');
const { asHtml } = require('../src/reporting/html');
const { createTestPlan, orchestrateTest, validateTestRecord, summarizeTest } = require('../src/comparison/orchestration');
const { digest } = require('../src/comparison/verification');

const source = () => ({ prompt: 'Return the correct result.', evidence: 'The result must be 42.',
  review: { checkOrder: true, decisionPolicy: 'best-supported', resolveEvidence: true },
  test: { repetitions: 1 }, baseline: { provider: 'ollama', model: 'one', response: '41' },
  candidate: { provider: 'ollama', model: 'two', response: '42' } });
const assessment = () => ({ verdict: 'candidate', preferenceEstablished: true, orderConsistent: false,
  criteria: [{ criterion: 'grounding', verdict: 'insufficient_evidence', rationale: 'Order disagreement.', citations: [] },
    { criterion: 'reasoning', verdict: 'candidate', rationale: 'Correct arithmetic.', citations: [] }],
  judgments: [{ verdict: 'candidate', summary: 'Candidate follows the contract.', unknowns: [],
    criteria: [{ criterion: 'grounding', verdict: 'candidate', citations: [] }] },
    { verdict: 'baseline', summary: 'No established advantage.', unknowns: [],
      criteria: [{ criterion: 'grounding', verdict: 'tie', citations: [] }] }],
  unknowns: [], summary: 'Candidate follows the task.', requestCount: 2, citationRepairs: 0,
  inputTokenEstimates: [10, 10], usageTurns: [], inputFingerprint: 'original',
  model: { id: 'judge', name: 'Judge' } });

test('one resolution round gathers targeted evidence without regenerating or rewriting either answer', async () => {
  const input = source(), calls = [], collected = [];
  const initial = assessment();
  const result = await resolveReview(input, {
    evaluate: async packet => {
      calls.push(structuredClone(packet));
      return calls.length === 1 ? initial : { ...assessment(), orderConsistent: null, requestCount: 1,
        criteria: [{ criterion: 'grounding', verdict: 'candidate', rationale: 'Verified result.', citations: [] }] };
    },
    collectEvidence: async (packet, disputes) => {
      collected.push(disputes);
      assert.equal(packet.baseline.response, '41');
      return { evidence: 'Observed result: 42', collection: { modelRequestCount: 1, usageTurns: [] } };
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(collected.length, 1);
  assert.equal(calls[1].review.checkOrder, false);
  assert.equal(calls[1].resolutionEvidence, 'Observed result: 42');
  assert.deepEqual(calls.map(packet => [packet.baseline.response, packet.candidate.response]), [['41', '42'], ['41', '42']]);
  assert.equal(result.resolution.initial, initial);
  assert.equal(result.resolution.status, 'completed');
  assert.equal(result.orderConsistent, false, 'Adjudication cannot erase the original order disagreement');
  assert.equal(result.requestCount, 4);
  assert.equal(result.inputFingerprint, 'original');
  assert.equal(assessmentDecision(result).status, 'provisional');
  assert.equal(assessmentDecision(result).preference, 'candidate');
  assert.equal(assessmentDecision(result).confidence, 'low');
  assert.equal(input.resolutionEvidence, undefined);
});

test('unavailable evidence stays explicit and a genuine tie is not forced into a winner', async () => {
  let calls = 0;
  const result = await resolveReview(source(), {
    evaluate: async () => { calls++; return { ...assessment(), verdict: 'baseline', preferenceEstablished: false }; }
  });
  assert.equal(calls, 2);
  assert.equal(result.resolution.evidenceStatus, 'unavailable');
  assert.match(result.unknowns.join(' '), /No additional/);
  assert.equal(assessmentDecision(result).preference, null);
});

test('resolution failures are retained and cancellation never becomes a provisional success', async () => {
  const messages = [];
  const services = { evaluate: async () => assessment(), progress: message => messages.push(message),
    collectEvidence: async () => { throw new Error('Evidence server unavailable'); } };
  const result = await resolveReview(source(), services);
  assert.equal(result.resolution.status, 'failed');
  assert.match(result.resolution.error, /server unavailable/);
  assert.ok(messages.some(message => /resolution failed/.test(message)));
  await assert.rejects(resolveReview(source(), { ...services, cancelled: () => true }), /server unavailable/);
});

test('stable reviews and disabled follow-up do not incur extra requests', async () => {
  for (const resolveEvidence of [false, true]) {
    let requests = 0;
    await resolveReview({ ...source(), review: { resolveEvidence } }, {
      evaluate: async () => { requests++; return { ...assessment(), orderConsistent: true,
        judgments: [], criteria: [{ criterion: 'grounding', verdict: 'candidate' }] }; },
      collectEvidence: async () => { assert.fail('No collection should be needed'); }
    });
    assert.equal(requests, 1);
  }
});

test('best-supported picks preserve acceptance, correctness regressions and strict-policy behavior', () => {
  const result = { ...assessment(), decisionPolicy: 'best-supported' };
  assert.equal(assessmentDecision(result).preference, 'candidate');
  assert.match(assessmentDecision(result).reasons.join(' '), /Grounding judgment changed/);
  assert.equal(assessmentDecision(result, { policy: 'strict' }).preference, null);
  assert.equal(assessmentDecision(result, { checks: [{ phrase: 'required', candidate: false }] }).status, 'blocked');
  assert.equal(assessmentDecision({ ...result, criteria: [...result.criteria,
    { criterion: 'actionability', verdict: 'baseline' }] }).status, 'blocked');
  assert.equal(assessmentDecision({ ...result, criteria: [{ criterion: 'clarity', verdict: 'candidate' }] }).preference, null);
});

test('executable observations are bound to both outputs and relabeled for reversed blind reviews', async () => {
  const input = { ...source(), verification: { kind: 'node-commonjs', name: 'checker.cjs',
    source: 'trusted checker', timeoutSeconds: 30 } };
  const observations = { image: 'sha256:' + 'a'.repeat(64), checkerHash: digest(input.verification.source),
    baseline: { status: 'failed', responseHash: digest('41'), detail: 'Wrong result' },
    candidate: { status: 'passed', responseHash: digest('42'), detail: 'One passing test',
      tests: 1, passed: 1, failed: 0, exitCode: 0 } };
  let seen;
  const result = await resolveReview({ ...input, review: { resolveEvidence: false } }, {
    verify: async () => observations,
    evaluate: async packet => { seen = packet; return assessment(); }
  });
  assert.equal(result.verification, observations);
  const original = JSON.parse(reviewPacket(seen).evidence.split('\n').at(-1));
  const reversed = JSON.parse(reviewPacket(seen, true).evidence.split('\n').at(-1));
  assert.equal(original.A.status, 'failed');
  assert.equal(reversed.A.status, 'passed');
  assert.equal(Object.hasOwn(original, 'baseline'), false);
  assert.equal(assessmentDecision({ ...result, verdict: 'baseline' }, { verificationInput: input }).status, 'blocked');
  const stale = { ...observations, candidate: { ...observations.candidate, responseHash: digest('other output') } };
  await assert.rejects(resolveReview(input, { verify: async () => stale, evaluate: async () => assessment() }), /do not match/);
});

test('completed verification survives an evaluator failure in the saved pair', async () => {
  const input = { ...source(), verification: { kind: 'node-commonjs', name: 'checker.cjs',
    source: 'trusted checker', timeoutSeconds: 30 }, test: { repetitions: 1 } };
  const record = await orchestrateTest(input, {
    comparePair: () => ({ checks: [], fairness: { warnings: [], unknowns: [] } }),
    runVariant: async (request, side) => ({ ...request, response: side + ' answer' }),
    evaluatePair: pair => resolveReview(pair, {
      verify: async verifiedInput => {
        const observation = (side, status) => ({ status,
          responseHash: digest(verifiedInput[side].response), detail: status === 'passed' ? 'One passing test' : 'Failed check',
          ...(status === 'passed' ? { tests: 1, passed: 1, failed: 0, exitCode: 0 } : {}) });
        return { image: 'sha256:' + 'b'.repeat(64), checkerHash: digest(verifiedInput.verification.source),
          baseline: observation('baseline', 'failed'), candidate: observation('candidate', 'passed') };
      },
      evaluate: async () => { throw new Error('Evaluator quota exceeded'); }
    })
  });
  const pair = record.pairs[0];
  assert.equal(pair.evaluationStatus, 'failed');
  assert.equal(pair.evaluation, null);
  assert.equal(pair.verification.baseline.status, 'failed');
  assert.equal(pair.verification.candidate.status, 'passed');
  const saved = validateTestRecord(JSON.parse(JSON.stringify(record)));
  assert.deepEqual(saved.pairs[0].verification, pair.verification);
});

test('oversized verification observations are omitted and stop later pairs', async () => {
  const input = { ...source(), verification: { kind: 'node-commonjs', name: 'checker.cjs',
    source: 'trusted checker', timeoutSeconds: 30 }, test: { repetitions: 2 } };
  let generated = 0;
  const record = await orchestrateTest(input, {
    comparePair: () => ({ checks: [], fairness: { warnings: [], unknowns: [] } }),
    runVariant: async (request, side) => {
      generated++;
      return { ...request, response: 'x'.repeat(4_100_000) };
    },
    evaluatePair: async pair => {
      const observation = side => ({ status: 'failed',
        responseHash: digest(pair[side].response), detail: 'x'.repeat(65536) });
      const error = new Error('Evaluator quota exceeded');
      error.partialVerification = { image: 'sha256:' + 'c'.repeat(64),
        checkerHash: digest(input.verification.source), baseline: observation('baseline'), candidate: observation('candidate') };
      throw error;
    }
  });
  assert.equal(generated, 2);
  assert.equal(record.pairs.length, 1);
  assert.equal(record.pairs[0].verification, undefined);
  assert.match(record.pairs[0].evaluationError, /observations exceeded.*omitted/);
  assert.deepEqual(validateTestRecord(JSON.parse(JSON.stringify(record))), JSON.parse(JSON.stringify(record)));
});

test('Markdown reports aggregate confidence separately from the last pair assessment', async () => {
  const input = { ...source(), review: { decisionPolicy: 'best-supported' }, test: { repetitions: 3 } };
  let review = 0;
  const record = await orchestrateTest(input, {
    comparePair: () => ({ checks: [], fairness: { warnings: [] } }),
    runVariant: async (request, side) => ({ ...request, response: side + ' answer' }),
    evaluatePair: async () => {
      const provisional = ++review < 3;
      return { verdict: 'candidate', preferenceEstablished: true, orderConsistent: true,
        summary: 'Candidate answer follows the evidence.', criteria: [
          { criterion: 'grounding', verdict: provisional ? 'insufficient_evidence' : 'candidate', rationale: 'Grounding review.', citations: [] },
          { criterion: 'reasoning', verdict: 'candidate', rationale: 'Supported reasoning.', citations: [] }
        ], unknowns: [], judgments: [], inputTokenEstimates: [], usageTurns: [], requestCount: 1,
        citationRepairs: 0, elapsedMs: 1, rubricVersion: 1, model: { name: 'Reviewer', id: 'reviewer' } };
    }
  });
  const report = compare({ ...input, baseline: { ...input.baseline, response: 'baseline answer' },
    candidate: { ...input.candidate, response: 'candidate answer' } });
  report.testRun = record;
  report.testSummary = summarizeTest(record);
  report.evaluation = record.pairs.at(-1).evaluation;
  const markdown = asMarkdown(report);
  assert.equal(report.testSummary.confidence, 'low');
  assert.match(markdown, /Aggregate recommendation confidence: \*\*low\*\*\. Provisional pick, not a proven improvement\./);
  assert.match(markdown, /Recommendation confidence: medium\./);
});

test('review policy and checker survive plan validation and exported provisional decisions show uncertainty', async () => {
  const input = source();
  const record = await orchestrateTest(input, { comparePair: compare,
    runVariant: async (request, side) => ({ ...request, response: input[side].response }),
    evaluatePair: async () => ({ ...assessment(), decisionPolicy: 'best-supported' }) });
  assert.equal(validateTestRecord(record).plan.review.decisionPolicy, 'best-supported');
  assert.equal(summarizeTest(record).preference, 'candidate');
  assert.equal(summarizeTest(record).confidence, 'low');
  const value = { ...compare(input), evaluation: { ...assessment(), decisionPolicy: 'best-supported' } };
  assert.match(asMarkdown(value), /Provisional pick, not a proven improvement/);
  assert.match(asHtml(value, { css: '', markdownScript: '' }), /Provisional pick, not a proven improvement/);
  assert.throws(() => createTestPlan({ ...input, review: { resolveEvidence: 'yes' } }), /boolean/);
});
