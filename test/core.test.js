const test = require('node:test');
const assert = require('node:assert/strict');
const { compare, diffText, asMarkdown, responseContent, reviewPacket, parseAssessment, CitationValidationError, REVIEW_CRITERIA } = require('../src/comparison/core');

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

function reviewFixture() {
  const input = { prompt: 'Triage the errors.', evidence: 'Requests returned HTTP 401.',
    baseline: { model: 'hidden-baseline', response: 'Roll back the deployment.' },
    candidate: { model: 'hidden-candidate', response: 'Check authentication.' } };
  const packet = reviewPacket(input);
  const assessment = { verdict: 'B', summary: 'Authentication checks are supported; a rollback is not.', unknowns: [],
    criteria: REVIEW_CRITERIA.map(criterion => ({ criterion, verdict: 'B', rationale: 'HTTP 401 supports checking authentication.',
      citations: [{ source: 'A', quote: packet.A }, { source: 'B', quote: packet.B }, { source: 'evidence', quote: packet.evidence }] })) };
  return { input, packet, assessment };
}

test('review packets omit model identities and reverse tasks with responses', () => {
  const { input, packet } = reviewFixture();
  assert.doesNotMatch(JSON.stringify(packet), /hidden-baseline|hidden-candidate/);
  input.candidate.prompt = 'A different task';
  const reversed = reviewPacket(input, true);
  assert.equal(reversed.A, input.candidate.response);
  assert.equal(reversed.taskA, 'A different task');
});

test('extracts readable triage fields without volatile metadata', () => {
  const text = responseContent(JSON.stringify({ EventId: 'hidden-event', Analysis: '# Findings\nHTTP 401',
    Recommendation: 'Check authentication.', CompletedAt: '2026-10-28', Impact: ['Failed requests'] }));
  assert.match(text, /# Findings\nHTTP 401/);
  assert.match(text, /Failed requests/);
  assert.doesNotMatch(text, /hidden-event|CompletedAt/);
  assert.equal(responseContent('{not JSON}'), '{not JSON}');
  assert.equal(responseContent('{"other":123}'), '{"other":123}');
});

test('maps evaluator verdicts and citations back to the real response sides', () => {
  const { packet, assessment } = reviewFixture();
  assert.equal(parseAssessment(JSON.stringify(assessment), packet).verdict, 'candidate');
  const reversed = parseAssessment(JSON.stringify(assessment), packet, true);
  assert.equal(reversed.verdict, 'baseline');
  assert.equal(reversed.criteria[0].citations[0].source, 'candidate');
});

test('rejects invented quotations and incomplete rubrics', () => {
  const { packet, assessment } = reviewFixture();
  assessment.criteria[0].citations[2].quote = 'The deployment caused the incident.';
  assert.throws(() => parseAssessment(JSON.stringify(assessment), packet), { name: 'CitationValidationError', message: /grounding citation:.*does not match evidence/ });
  assessment.criteria.pop();
  assert.throws(() => parseAssessment(JSON.stringify(assessment), packet), /invalid assessment schema/);
});

test('matches whitespace-only quote changes and retains the original source passage', () => {
  const { packet, assessment } = reviewFixture();
  packet.A = 'Roll\r\n\tback  the deployment.';
  const result = parseAssessment(JSON.stringify(assessment), packet, true);
  assert.equal(result.criteria[0].citations[0].quote, packet.A);
  assert.equal(result.criteria[0].citations[0].source, 'candidate');
});

test('citation matching preserves Markdown, punctuation, numbers, and literal regex characters', () => {
  const { packet, assessment } = reviewFixture();
  const original = '**HTTP 401**: inspect [auth](logs), not HTTP 403. (a+b)* $1 ^x? \\path {2}';
  packet.B = original;
  for (const item of assessment.criteria) item.citations[1].quote = original.replaceAll(' ', '\n');
  assert.equal(parseAssessment(JSON.stringify(assessment), packet).criteria[0].citations[1].quote, original);
  for (const modified of [original.replaceAll('**', ''), original.replace('401', '403'), original.replace('not ', ''), original.replace('inspect', 'check'), 'HTTP 401 ... HTTP 403']) {
    assessment.criteria[0].citations[1].quote = modified;
    assert.throws(() => parseAssessment(JSON.stringify(assessment), packet), CitationValidationError);
  }
});

test('citation failures identify invalid sources, empty quotes, and oversized quotes', () => {
  const { packet, assessment } = reviewFixture();
  const citation = assessment.criteria[0].citations[0];
  citation.source = 'baseline';
  assert.throws(() => parseAssessment(JSON.stringify(assessment), packet), /grounding citation: use source A, B/);
  citation.source = 'A';
  for (const invalid of ['', '  ', 'x'.repeat(601)]) {
    citation.quote = invalid;
    assert.throws(() => parseAssessment(JSON.stringify(assessment), packet), /quote from A must contain 1 to 600 characters/);
  }
});

test('citations match decoded triage JSON instead of its escaped wire representation', () => {
  const { input, assessment } = reviewFixture();
  input.candidate.response = '{"Analysis":"**Verdict:** \\u0060uncertain\\u0060\\n\\nLag: 6,953."}';
  const packet = reviewPacket(input);
  for (const item of assessment.criteria) item.citations[1].quote = '**Verdict:** `uncertain` Lag: 6,953.';
  const result = parseAssessment(JSON.stringify(assessment), packet);
  assert.equal(result.criteria[0].citations[1].quote, '**Verdict:** `uncertain`\n\nLag: 6,953.');
});

test('missing evidence preserves a supported provisional recommendation', () => {
  const { packet, assessment } = reviewFixture();
  packet.evidence = '';
  for (const criterion of assessment.criteria) criterion.citations.pop();
  assessment.criteria[0].verdict = 'insufficient_evidence';
  const result = parseAssessment(JSON.stringify(assessment), packet);
  assert.equal(result.verdict, 'candidate');
  assert.equal(result.criteria[0].verdict, 'insufficient_evidence');
  assert.match(result.summary, /Provisional recommendation \(low confidence\)/);
  assert.match(result.unknowns[0], /No source evidence/);
});

test('ties and abstentions retain the real baseline regardless of response order', () => {
  for (const verdict of ['tie', 'insufficient_evidence']) {
    for (const reversed of [false, true]) {
      const { packet, assessment } = reviewFixture();
      assessment.verdict = verdict;
      for (const criterion of assessment.criteria) criterion.verdict = verdict;
      const result = parseAssessment(JSON.stringify(assessment), packet, reversed);
      assert.equal(result.verdict, 'baseline');
      assert.match(result.summary, /retain the baseline \(low confidence\)/);
      assert.match(result.summary, /not proof/);
    }
  }
});

test('requires original tasks and both outputs', () => {
  assert.throws(() => reviewPacket({}), /original task/);
  assert.throws(() => reviewPacket({ prompt: 'Task' }), /both responses/);
});

test('blank prompt overrides use the populated shared prompt for both responses', () => {
  const { input } = reviewFixture();
  input.evidence = '';
  for (const override of [undefined, null, '', ' \t ', '\n\r\n', '\u00a0\u2003']) {
    input.baseline.prompt = override;
    input.candidate.prompt = override;
    const packet = reviewPacket(input);
    assert.equal(packet.taskA, input.prompt);
    assert.equal(packet.taskB, input.prompt);
    const result = compare(input);
    assert.equal(result.baseline.prompt, input.prompt);
    assert.equal(result.candidate.prompt, input.prompt);
    assert.ok(!result.fairness.warnings.some(warning => warning.code === 'prompt-variation'));
  }
});

test('real prompt overrides retain their exact text and missing tasks identify the affected side', () => {
  const { input } = reviewFixture();
  input.candidate.prompt = ' \nA different candidate task.\n ';
  assert.equal(reviewPacket(input).taskB, input.candidate.prompt);
  assert.equal(compare(input).candidate.prompt, input.candidate.prompt);
  assert.equal(reviewPacket(input, true).taskA, input.candidate.prompt);
  input.prompt = ' \t ';
  assert.throws(() => reviewPacket(input), /original task for Baseline\. Enter a Shared prompt/);
  input.baseline.prompt = 'Original baseline task.';
  assert.equal(reviewPacket(input).taskA, input.baseline.prompt);
  input.candidate.prompt = '';
  assert.throws(() => reviewPacket(input), /original task for Candidate\. Enter a Shared prompt/);
});

test('reports lead with the assessment and retain its evidence, evaluator identity, and run metrics', () => {
  const { input, packet, assessment } = reviewFixture();
  input.baseline.elapsedMs = 123;
  const result = compare(input);
  const judgment = parseAssessment(JSON.stringify(assessment), packet);
  result.evaluation = { ...judgment, model: { name: 'Reviewer', id: 'reviewer', version: 'snapshot' }, rubricVersion: 1,
    orderConsistent: null, judgments: [judgment], elapsedMs: 200, inputTokenEstimates: [100, 150], requestCount: 2, citationRepairs: 1, note: 'Not verified ground truth.' };
  const report = asMarkdown(result);
  assert.ok(report.includes('**Recommend Candidate**'));
  assert.ok(report.indexOf('**Recommend Candidate**') < report.indexOf('## Recorded runs'));
  assert.match(report, /version snapshot/);
  assert.match(report, /HTTP 401/);
  assert.match(report, /Latency \(ms\) \| 123/);
  assert.match(report, /Source: evidence/);
  assert.match(report, /Requests: 2\. Citation repairs: 1\./);
  assert.match(report, /Not verified ground truth/);
  delete result.evaluation.requestCount;
  delete result.evaluation.citationRepairs;
  assert.match(asMarkdown(result), /Requests: 1\. Citation repairs: 0\./);
  delete result.evaluation;
  assert.match(asMarkdown(result), /Not evaluated/);
});

test('exported response fences cannot be closed by embedded response text', () => {
  const report = asMarkdown(compare({ baseline: { response: '~~~\nUntrusted text' } }));
  assert.match(report, /~~~~text\n~~~\nUntrusted text\n~~~~/);
});
