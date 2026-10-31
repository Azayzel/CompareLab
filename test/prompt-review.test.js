const test = require('node:test');
const assert = require('node:assert/strict');
const { compare, diffText, changePassages, reviewPacket, parseAssessment, REVIEW_CRITERIA, asMarkdown } = require('../src/comparison/core');
const { evaluateWithCopilot } = require('../src/providers/vscode/review');
const { promptDecision } = require('../src/comparison/prompt-review');
const { optimizerRequest, parseOptimizerDraft } = require('../src/comparison/prompt-optimizer');
const { collectionRequest, freezeEvidence } = require('../src/comparison/prompt-evidence');
const { orchestrateTest, summarizeTest, validateTestRecord } = require('../src/comparison/orchestration');
const { asHtml } = require('../src/reporting/html');

const input = () => ({
  comparisonKind: 'prompt', comparisonMode: 'model-prompt-only', incomingMessage: 'Investigate service:example',
  evidence: 'HTTP 401 increased.', test: { repetitions: 1 },
  baseline: { provider: 'vscode', model: 'shared-model', prompt: 'Investigate.', response: 'Roll back.' },
  candidate: { provider: 'vscode', model: 'shared-model', prompt: 'Investigate. Cite evidence.', response: 'HTTP 401 supports checking authentication.' }
});
const change = () => ({ change: 'Added evidence requirement', effect: 'improvement', impact: 'The edited output supports its next step with an observation.',
  recommendation: 'Keep the evidence requirement.',
  citations: [{ source: 'promptB', quote: 'Cite evidence.' }, { source: 'A', quote: 'Roll back.' },
    { source: 'B', quote: 'HTTP 401 supports checking authentication.' }] });
function assessment(packet, reversed = false) {
  const c = change();
  return { verdict: reversed ? 'A' : 'B', summary: 'The evidence requirement improves the observed recommendation.', unknowns: [],
    criteria: REVIEW_CRITERIA.map(criterion => ({ criterion, verdict: reversed ? 'A' : 'B', rationale: 'The recommendation follows observed evidence.',
      citations: [{ source: 'A', quote: packet.A }, { source: 'B', quote: packet.B }, { source: 'evidence', quote: packet.evidence }] })),
    promptChanges: reversed ? [{ ...c, effect: 'regression',
      citations: [{ source: 'promptA', quote: 'Cite evidence.' }, { source: 'B', quote: 'Roll back.' },
        { source: 'A', quote: 'HTTP 401 supports checking authentication.' }] }] : [c] };
}
async function reviewed() {
  const model = { id: 'reviewer', name: 'Reviewer', vendor: 'copilot', maxInputTokens: 10000,
    countTokens: async () => 10,
    sendRequest: async (messages, options) => {
      assert.deepEqual(options, {});
      assert.match(messages[0].content, /PROMPT EDIT review/);
      const packet = JSON.parse(messages[1].content);
      const reversed = packet.A === input().candidate.response;
      return { text: (async function* () { yield JSON.stringify(assessment(packet, reversed)); })() };
    } };
  const api = { LanguageModelChatMessage: { User: content => ({ content }), Assistant: content => ({ content }) } };
  return evaluateWithCopilot(api, input(), model, { isCancellationRequested: false });
}

test('prompt diff preserves small changes inside long instruction templates', () => {
  const prefix = 'Preserve this instruction. '.repeat(1000);
  const suffix = 'Keep this constraint. '.repeat(1000);
  const spans = diffText(prefix + 'Guess. ' + suffix, prefix + 'Verify. ' + suffix);
  assert.deepEqual(spans.filter(span => span.type !== 'equal'), [
    { type: 'add', text: 'Verify.' }, { type: 'remove', text: 'Guess.' }
  ]);
  assert.equal(spans.filter(span => span.type !== 'add').map(span => span.text).join(''), prefix + 'Guess. ' + suffix);
  assert.equal(spans.filter(span => span.type !== 'remove').map(span => span.text).join(''), prefix + 'Verify. ' + suffix);
});

test('changed passages join related word edits and retain full local lines without unrelated sections', () => {
  const original = '# Instructions\n\nPrioritize the action owner, verdict, and confidence.\nKeep this entire section unchanged.\n\nOmit the footer.';
  const edited = '# Instructions\n\nKeep the saved analysis concise and self-contained.\nKeep this entire section unchanged.\n\nPreserve the CTA.';
  const passages = changePassages(diffText(original, edited));
  assert.equal(passages.length, 2);
  const text = spans => spans.map(span => span.text).join('');
  assert.equal(text(passages[0].original), 'Prioritize the action owner, verdict, and confidence.');
  assert.equal(text(passages[0].edited), 'Keep the saved analysis concise and self-contained.');
  assert.equal(text(passages[1].original), 'Omit the footer.');
  assert.equal(text(passages[1].edited), 'Preserve the CTA.');
  assert.doesNotMatch(JSON.stringify(passages), /entire section unchanged|# Instructions/);
  assert.deepEqual(changePassages(diffText('same', 'same')), []);
});

test('changed passages support insertion, deletion, adjacent edited lines, whitespace and untrusted markup', () => {
  for (const [left, right] of [
    ['', 'New instructions'], ['Removed instructions', ''], ['One\nTwo', 'First\nSecond'],
    ['Keep   spaces', 'Keep spaces'], ['<script>before</script>', '<img src=x onerror=alert(1)>']
  ]) {
    const passages = changePassages(diffText(left, right));
    assert.equal(passages.length, 1);
    assert.equal(passages[0].original.map(span => span.text).join(''), left);
    assert.equal(passages[0].edited.map(span => span.text).join(''), right);
  }
  const source = input();
  source.candidate.prompt = '<img src=x onerror=alert(1)>';
  const html = asHtml(compare(source), { css: '', markdownScript: '' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});

test('raw prompt metadata stays available for change review even when stripped from the executable alert task', () => {
  const source = input();
  source.incomingMessage = '{"eventId":"example","monitorId":"123"}';
  source.baseline.prompt = '---\nname: original\n---\nInvestigate.';
  source.candidate.prompt = '---\nname: revised\n---\nInvestigate.';
  const packet = reviewPacket(source);
  assert.doesNotMatch(packet.taskB, /name: revised/);
  assert.match(packet.promptB, /name: revised/);
  const output = assessment(packet);
  output.promptChanges[0] = { ...change(), effect: 'uncertain', impact: 'Only metadata changed; no executable instruction changed.',
    recommendation: 'Do not treat metadata edits as an output improvement.',
    citations: [{ source: 'promptB', quote: 'revised' }, { source: 'A', quote: packet.A }, { source: 'B', quote: packet.B }] };
  assert.equal(parseAssessment(JSON.stringify(output), packet).promptChanges[0].effect, 'uncertain');
});

test('review compares the instruction diff, maps reversed change directions, and verifies output quotes', async () => {
  const result = await reviewed();
  assert.equal(result.verdict, 'candidate');
  assert.equal(result.orderConsistent, true);
  assert.equal(result.promptChanges[0].effect, 'improvement');
  assert.deepEqual(result.judgments[1].promptChanges, result.promptChanges);
  const packet = reviewPacket(input());
  for (const corrupt of [
    value => { delete value.promptChanges; },
    value => { value.promptChanges = 'invalid'; },
    value => { value.promptChanges[0].citations = 'invalid'; },
    value => { value.promptChanges[0].citations[0].quote = 'Invented edit'; },
    value => { value.promptChanges[0].citations[0] = { source: 'taskA', quote: 'Investigate.' }; },
    value => { value.promptChanges[0].citations.pop(); },
    value => { value.promptChanges[0].recommendation = 'x'.repeat(401); }
  ]) {
    const invalid = assessment(packet);
    corrupt(invalid);
    assert.throws(() => parseAssessment(JSON.stringify(invalid), packet), /prompt change/);
  }
});

test('invalid prompt-change quotes use the existing bounded citation correction path', async () => {
  let requests = 0;
  const model = { id: 'reviewer', name: 'Reviewer', vendor: 'copilot', maxInputTokens: 10000, countTokens: async () => 10,
    sendRequest: async messages => {
      requests++;
      const packet = JSON.parse(messages[1].content);
      const output = assessment(packet, packet.A === input().candidate.response);
      if (requests === 1) output.promptChanges[0].citations[0].quote = 'Invented prompt edit';
      if (requests === 2) assert.match(messages[0].content, /Previous citation validation failed/);
      return { text: (async function* () { yield JSON.stringify(output); })() };
    } };
  const api = { LanguageModelChatMessage: { User: content => ({ content }), Assistant: content => ({ content }) } };
  const result = await evaluateWithCopilot(api, input(), model, { isCancellationRequested: false });
  assert.equal(result.citationRepairs, 1);
  assert.equal(result.requestCount, 3);
  assert.equal(result.promptChanges[0].effect, 'improvement');
});

test('prompt recommendations accept exact contextual edit quotes across diff spans in both orders', () => {
  const source = input();
  source.baseline.prompt = 'Investigate alerts. Guess facts. Preserve output.';
  source.candidate.prompt = 'Investigate alerts. Verify facts. Preserve output.';
  for (const reversed of [false, true]) {
    const packet = reviewPacket(source, reversed);
    const output = assessment(packet, reversed);
    output.promptChanges[0].citations = [
      { source: reversed ? 'promptA' : 'promptB', quote: 'Verify facts.' },
      { source: 'A', quote: packet.A }, { source: 'B', quote: packet.B }
    ];
    assert.ok(!packet.promptDiff.some(span => span.type !== 'equal' && span.text.includes('Verify facts.')),
      'Reproduces the false rejection when a quote includes unchanged words');
    const parsed = parseAssessment(JSON.stringify(output), packet, reversed);
    assert.equal(parsed.promptChanges[0].citations[0].source, 'candidatePrompt');
    assert.equal(parsed.promptChanges[0].citations[0].quote, 'Verify facts.');
    output.promptChanges[0].citations[0] = { source: reversed ? 'promptB' : 'promptA', quote: 'Guess facts.' };
    assert.equal(parseAssessment(JSON.stringify(output), packet, reversed).promptChanges[0].citations[0].source, 'baselinePrompt');
    output.promptChanges[0].citations[0].source = reversed ? 'promptA' : 'promptB';
    for (const quote of ['Investigate alerts.', 'Preserve output.']) {
      output.promptChanges[0].citations[0].quote = quote;
      assert.throws(() => parseAssessment(JSON.stringify(output), packet, reversed), /includes added or removed text/);
    }
  }
});

test('each recommendation still requires both exact output quotes, with actionable bounded correction', async () => {
  let requests = 0;
  const source = { ...input(), review: { checkOrder: false } };
  const model = { id: 'reviewer', maxInputTokens: 10000, countTokens: async () => 10,
    sendRequest: async messages => {
      requests++;
      const packet = JSON.parse(messages[1].content);
      const output = assessment(packet);
      if (requests === 1) output.promptChanges[0].citations.pop();
      else {
        assert.match(messages[0].content, /Recommendation 1 needs exact quotes from both outputs/);
        assert.match(messages[0].content, /Criteria citations do not count/);
      }
      return { text: (async function* () { yield JSON.stringify(output); })() };
    } };
  const api = { LanguageModelChatMessage: { User: content => ({ content }), Assistant: content => ({ content }) } };
  const result = await evaluateWithCopilot(api, source, model, { isCancellationRequested: false });
  assert.equal(result.citationRepairs, 1);
  assert.equal(requests, 2);
  const packet = reviewPacket(source);
  const output = assessment(packet);
  output.promptChanges.push({ ...change(), citations: [{ source: 'promptB', quote: 'Cite evidence.' }, { source: 'A', quote: packet.A }] });
  assert.throws(() => parseAssessment(JSON.stringify(output), packet), /Recommendation 2 needs exact quotes from both outputs/);
  requests = 0;
  model.sendRequest = async () => {
    requests++;
    return { text: (async function* () { yield JSON.stringify(output); })() };
  };
  await assert.rejects(evaluateWithCopilot(api, source, model, { isCancellationRequested: false }),
    /Citation correction failed.*Recommendation 2 needs exact quotes from both outputs/);
  assert.equal(requests, 2, 'Persistent unsupported advice stays blocked after one correction request');
});

test('prompt decisions distinguish better, worse, uncertain, incomplete and unsafe edits', async () => {
  const result = { ...compare(input()), evaluation: await reviewed(), fairness: { warnings: [] } };
  assert.equal(promptDecision(result).verdict, 'Better');
  for (const alter of [
    r => { r.evaluation.orderConsistent = false; },
    r => { r.evaluation.orderConsistent = null; },
    r => { r.evaluation.preferenceEstablished = false; },
    r => { r.evaluation.promptChanges = []; },
    r => { r.evaluation.promptChanges[0].effect = 'uncertain'; },
    r => { r.evaluation.judgments[1].promptChanges[0].effect = 'uncertain'; },
    r => { r.evaluation.criteria[0].verdict = 'insufficient_evidence'; },
    r => { r.evaluation.criteria.find(c => c.criterion === 'actionability').verdict = 'baseline'; },
    r => { r.promptComparison.spans = [{ type: 'equal', text: 'Same' }]; }
  ]) {
    const unsafe = structuredClone(result);
    alter(unsafe);
    assert.equal(promptDecision(unsafe).verdict, 'No clear improvement');
  }
  const worse = structuredClone(result);
  worse.evaluation.verdict = 'baseline';
  for (const a of [worse.evaluation, ...worse.evaluation.judgments]) {
    for (const c of a.criteria) c.verdict = 'baseline';
    a.promptChanges[0].effect = 'regression';
  }
  assert.equal(promptDecision(worse).verdict, 'Worse');
  assert.match(promptDecision(result).caveat, /representative inputs/);
  result.comparisonMode = 'end-to-end';
  assert.match(promptDecision(result).caveat, /different evidence/);
});

test('prompt recommendations survive frozen tests, import, Markdown and safe HTML export', async () => {
  const source = input();
  const record = await orchestrateTest(source, {
    comparePair: compare, runVariant: async (request, side) => ({ ...request, response: source[side].response }),
    evaluatePair: reviewed
  });
  assert.equal(record.status, 'completed');
  const serialized = JSON.parse(JSON.stringify(record));
  assert.deepEqual(validateTestRecord(serialized), serialized);
  const result = { ...compare({ ...source, testRun: record }), evaluation: record.pairs[0].evaluation };
  assert.equal(result.testSummary.preference, 'candidate');
  assert.equal(promptDecision(result).verdict, 'Better');
  assert.match(asMarkdown(result), /Keep the evidence requirement/);
  const html = asHtml(result, { css: '', markdownScript: '' });
  assert.match(html, /PROMPT EDIT REVIEW/);
  assert.match(html, /What changed in the prompt/);
  assert.match(html, /class="change-pair"/);
  assert.match(html, /class="change-label">Original/);
  assert.match(html, /class="change-label">Edited/);
  assert.match(html, /<summary>Show full prompt diff<\/summary>/);
  assert.match(html, /<summary>Show full output diff<\/summary>/);
  assert.match(html, /Full outputs, reviews and technical details/);
  assert.doesNotMatch(html, /<h2>Candidate preferred for this task/);
  serialized.pairs[0].evaluation.promptChanges[0].citations[0].quote = 'Not in prompt';
  assert.throws(() => validateTestRecord(serialized), /Invalid controlled-test record/);
  record.pairs[0].evaluationStatus = 'failed'; record.status = 'partial';
  assert.equal(promptDecision({ ...result, testRun: record, testSummary: summarizeTest(record) }).verdict, 'No clear improvement');
});

test('guided rewriting is bounded, preserves source text as data and rejects malformed drafts', () => {
  const request = optimizerRequest(input(), { goal: 'Ground findings', preserve: '{{message}}', success: 'Cite observations' });
  const data = JSON.parse(request.prompt.slice(request.prompt.indexOf('\n\n') + 2));
  assert.equal(data.original, input().baseline.prompt);
  assert.equal(data.preserve, '{{message}}');
  assert.doesNotMatch(request.prompt, /HTTP 401/);
  assert.throws(() => optimizerRequest({}), /Enter the original/);
  assert.throws(() => optimizerRequest(input(), { goal: 'x'.repeat(100000) }), /limit/);
  const draft = parseOptimizerDraft({ response: JSON.stringify({ prompt: 'Edited {{message}}', summary: 'Preserves the placeholder.' }),
    model: 'writer', usageTurns: [{ model: 'writer', estimatedInputTokens: 10 }] });
  assert.equal(draft.prompt, 'Edited {{message}}');
  assert.equal(draft.usageTurns.length, 1);
  for (const response of ['not json', '{}', '{"prompt":"","summary":"x"}', JSON.stringify({ prompt: 'x', summary: 'x'.repeat(401) })]) {
    assert.throws(() => parseOptimizerDraft({ response }), /Your prompts were not changed/);
  }
});

test('shared evidence contains successful raw data only and retains separate collection usage', () => {
  const source = input();
  assert.match(collectionRequest(source).prompt, /without preferring either/);
  assert.throws(() => collectionRequest({ ...source, incomingMessage: '' }), /shared input/);
  const result = { model: 'collector', elapsedMs: 200, modelRequestCount: 2, toolCallCount: 3,
    usageTurns: [{ model: 'collector', estimatedInputTokens: 20 }],
    toolEvidence: [
      { tool: 'read_guidance', content: 'Guide' },
      { tool: 'query_events', content: 'Argument error', isError: true },
      { tool: 'query_events', input: { query: 'example' }, content: 'Unmodified raw result' }
    ] };
  const snapshot = freezeEvidence(result);
  assert.equal(JSON.parse(snapshot.evidence).results.length, 2);
  assert.match(snapshot.evidence, /Unmodified raw result/);
  assert.equal(snapshot.evidenceCollection.toolCallCount, 3);
  assert.equal(snapshot.evidenceCollection.usageTurns[0].model, 'collector');
  assert.throws(() => freezeEvidence({ ...result, toolEvidence: [result.toolEvidence[1]] }), /no successful/);
});

test('large shared snapshots survive prompt planning, replay and import without truncation', async () => {
  const source = input();
  source.evidence = 'Evidence that must be preserved. '.repeat(10000);
  const seen = [];
  const record = await orchestrateTest(source, {
    comparePair: compare, evaluatePair: reviewed,
    runVariant: async (request, side) => {
      const packet = JSON.parse(request.prompt.slice(request.prompt.indexOf('{')));
      seen.push(packet.evidence);
      return { ...request, response: source[side].response };
    }
  });
  assert.equal(record.status, 'completed');
  assert.deepEqual(seen, [source.evidence, source.evidence]);
  assert.equal(record.plan.evidence, source.evidence);
  assert.deepEqual(validateTestRecord(JSON.parse(JSON.stringify(record))), JSON.parse(JSON.stringify(record)));
  const { createTestPlan } = require('../src/comparison/orchestration');
  assert.throws(() => createTestPlan({ ...source, comparisonKind: 'model', prompt: 'Investigate',
    baseline: { provider: 'vscode', model: 'shared' }, candidate: { provider: 'vscode', model: 'shared' } }), /150,000-character/);
  assert.throws(() => createTestPlan({ ...source,
    baseline: { ...source.baseline, provider: 'ollama' }, candidate: { ...source.candidate, provider: 'ollama' } }), /150,000-character/);
});
