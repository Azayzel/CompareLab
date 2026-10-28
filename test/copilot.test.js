const test = require('node:test');
const assert = require('node:assert/strict');
const { selectEvaluator, selectRunModel, resolveRunModels, runWithVsCode, evaluateWithCopilot, openReviewChat, evaluationKey } = require('../src/copilot');
const { REVIEW_CRITERIA } = require('../src/core');

const input = () => ({ prompt: 'Triage these failures.', evidence: 'HTTP 401 responses increased.',
  baseline: { model: 'hidden-model-one', response: 'Roll back.' },
  candidate: { model: 'hidden-model-two', response: 'Check authentication.' } });
const vscode = { LanguageModelChatMessage: { User: content => ({ role: 'user', content }) }, CancellationError: class extends Error {} };

function fakeModel(favorPosition = false, invalidCitationRequests = []) {
  const requests = [];
  return {
    id: 'reviewer', name: 'Reviewer', vendor: 'copilot', version: 'snapshot', maxInputTokens: 10000, requests,
    countTokens: async () => 100,
    async sendRequest(messages, options, token) {
      requests.push({ messages, options, token });
      const packet = JSON.parse(messages[1].content);
      const verdict = favorPosition || packet.B === 'Check authentication.' ? 'B' : 'A';
      const assessment = { verdict, summary: 'Authentication checks follow the evidence.', unknowns: [],
        criteria: REVIEW_CRITERIA.map(criterion => ({ criterion,
          verdict: criterion === 'grounding' && !packet.evidence ? 'insufficient_evidence' : verdict,
          rationale: 'HTTP 401 supports checking authentication.',
          citations: [{ source: 'A', quote: packet.A }, { source: 'B', quote: packet.B },
            ...(packet.evidence ? [{ source: 'evidence', quote: packet.evidence }] : [])] })) };
      if (invalidCitationRequests.includes(requests.length)) assessment.criteria[0].citations[2].quote = 'Invented evidence.';
      return { text: (async function* () { yield JSON.stringify(assessment); })() };
    }
  };
}

test('uses the same selected model for both orders, without tools or identity metadata', async () => {
  const model = fakeModel();
  const result = await evaluateWithCopilot(vscode, input(), model, { isCancellationRequested: false });
  assert.equal(result.verdict, 'candidate');
  assert.equal(result.orderConsistent, true);
  assert.equal(model.requests.length, 2);
  assert.deepEqual(model.requests[0].options, {});
  assert.doesNotMatch(JSON.stringify(model.requests), /hidden-model-one|hidden-model-two/);
  assert.equal(result.judgments[1].criteria[0].citations[0].source, 'candidate');
  assert.deepEqual(result.inputTokenEstimates, [200, 200]);
  assert.equal(result.requestCount, 2);
  assert.equal(result.citationRepairs, 0);
  assert.equal(result.model.version, 'snapshot');
  assert.equal(result.rubricVersion, 3);
  assert.match(model.requests[0].messages[0].content, /Never use insufficient_evidence as the overall verdict/);
});

test('both review orders preserve a provisional choice when grounding is unverified', async () => {
  const experiment = { ...input(), evidence: '' };
  const result = await evaluateWithCopilot(vscode, experiment, fakeModel(), { isCancellationRequested: false });
  assert.equal(result.verdict, 'candidate');
  assert.equal(result.orderConsistent, true);
  assert.match(result.summary, /Provisional recommendation \(low confidence\)/);
  assert.equal(result.criteria[0].verdict, 'insufficient_evidence');
  assert.ok(result.unknowns.some(unknown => unknown.includes('No source evidence')));
});

test('repairs citations once with the same model, source packet, and response ordering', async () => {
  for (const failingRequest of [1, 2]) {
    const model = fakeModel(false, [failingRequest]);
    const result = await evaluateWithCopilot(vscode, input(), model, { isCancellationRequested: false });
    assert.equal(result.verdict, 'candidate');
    assert.equal(result.orderConsistent, true);
    assert.equal(result.judgments.length, 2);
    assert.equal(result.requestCount, 3);
    assert.equal(result.citationRepairs, 1);
    assert.equal(result.inputTokenEstimates.length, 3);
    const original = model.requests[failingRequest - 1];
    const retry = model.requests[failingRequest];
    assert.equal(retry.messages[1].content, original.messages[1].content);
    assert.match(retry.messages[0].content, /Previous citation validation failed:.*grounding.*evidence/);
    assert.doesNotMatch(retry.messages[0].content, /Invented evidence/);
    assert.deepEqual(retry.options, {});
    assert.equal(retry.token, original.token);
  }
});

test('a single-order review records its extra citation request without claiming an order check', async () => {
  const experiment = { ...input(), review: { checkOrder: false } };
  const result = await evaluateWithCopilot(vscode, experiment, fakeModel(false, [1]), { isCancellationRequested: false });
  assert.equal(result.requestCount, 2);
  assert.equal(result.judgments.length, 1);
  assert.equal(result.orderConsistent, null);
});

test('citation repair is capped across both orders and persistent failures remain errors', async () => {
  for (const invalidRequests of [[1, 2], [1, 3]]) {
    const model = fakeModel(false, invalidRequests);
    await assert.rejects(evaluateWithCopilot(vscode, input(), model, { isCancellationRequested: false }), /Citation correction failed.*grounding.*evidence/);
    assert.equal(model.requests.length, invalidRequests[1]);
  }
});

test('citation repair respects cancellation and rechecks input capacity', async () => {
  const model = fakeModel(false, [1]);
  const token = { isCancellationRequested: false };
  await assert.rejects(evaluateWithCopilot(vscode, input(), model, token, message => {
    if (message.includes('Repairing')) token.isCancellationRequested = true;
  }), vscode.CancellationError);
  assert.equal(model.requests.length, 1);
  const limited = fakeModel(false, [1]);
  limited.countTokens = async message => message.content.includes('Previous citation validation failed') ? limited.maxInputTokens : 100;
  await assert.rejects(evaluateWithCopilot(vscode, input(), limited, { isCancellationRequested: false }), /input limit/);
  assert.equal(limited.requests.length, 1);
});

test('schema and provider failures do not trigger citation retries', async () => {
  for (const failure of ['schema', 'provider']) {
    const model = fakeModel();
    let requests = 0;
    model.sendRequest = async () => {
      requests++;
      if (failure === 'provider') throw new Error('Quota exceeded');
      return { text: (async function* () { yield '{}'; })() };
    };
    await assert.rejects(evaluateWithCopilot(vscode, input(), model, { isCancellationRequested: false }), /invalid assessment schema|Quota exceeded/);
    assert.equal(requests, 1);
  }
});

test('recommends retaining the baseline provisionally on response-order bias', async () => {
  const result = await evaluateWithCopilot(vscode, input(), fakeModel(true), { isCancellationRequested: false });
  assert.equal(result.verdict, 'baseline');
  assert.match(result.summary, /retain the baseline \(low confidence\)/);
  assert.equal(result.orderConsistent, false);
  assert.ok(result.criteria.every(item => item.verdict === 'insufficient_evidence'));
});

test('can run one explicitly requested review without claiming an order check', async () => {
  const experiment = input();
  experiment.review = { checkOrder: false };
  const result = await evaluateWithCopilot(vscode, experiment, fakeModel(), { isCancellationRequested: false });
  assert.equal(result.orderConsistent, null);
  assert.equal(result.judgments.length, 1);
});

test('cancellation and oversized inputs never reach the model', async () => {
  const model = fakeModel();
  await assert.rejects(evaluateWithCopilot(vscode, input(), model, { isCancellationRequested: true }), vscode.CancellationError);
  model.maxInputTokens = 100;
  await assert.rejects(evaluateWithCopilot(vscode, input(), model, { isCancellationRequested: false }), /input limit/);
  const large = input();
  large.evidence = 'x'.repeat(150000);
  await assert.rejects(evaluateWithCopilot(vscode, large, model, { isCancellationRequested: false }), /150,000-character/);
  assert.equal(model.requests.length, 0);
});

test('bounds model output before parsing it', async () => {
  const model = fakeModel();
  model.sendRequest = async () => ({ text: (async function* () { yield 'x'.repeat(2 * 1024 * 1024 + 1); })() });
  await assert.rejects(evaluateWithCopilot(vscode, input(), model, { isCancellationRequested: false }), /safety limit/);
});

test('model selection handles missing access and user cancellation', async () => {
  await assert.rejects(selectEvaluator({}), /Language Model API/);
  await assert.rejects(selectEvaluator({ lm: { selectChatModels: async () => [] } }), /No Copilot models/);
  const model = fakeModel();
  assert.equal(await selectEvaluator({ lm: { selectChatModels: async () => [model] },
    window: { showQuickPick: async () => undefined } }), undefined);
});

test('chat handoff creates a fresh draft without automatically submitting or reading chat history', async () => {
  const calls = [];
  const commands = { getCommands: async () => ['workbench.action.chat.newChat', 'workbench.action.chat.open'],
    executeCommand: async (...args) => calls.push(args) };
  await openReviewChat({ commands }, input());
  assert.equal(calls[0][0], 'workbench.action.chat.newChat');
  assert.equal(calls[1][1].isPartialQuery, true);
  assert.equal(calls[1][1].mode, 'agent');
  assert.match(calls[1][1].query, /read-only tools/);
  assert.match(calls[1][1].query, /Never use insufficient_evidence as the overall verdict/);
  assert.match(calls[1][1].query, /State confidence/);
  assert.doesNotMatch(calls[1][1].query, /hidden-model-one|hidden-model-two|Return only JSON/);
  await assert.rejects(openReviewChat({ commands: { getCommands: async () => [] } }, input()), /Chat is unavailable/);
});

test('evaluation identity changes when evidence, responses, or order settings change', () => {
  const original = input();
  const key = evaluationKey(original);
  assert.notEqual(evaluationKey({ ...original, evidence: 'Other evidence' }), key);
  assert.notEqual(evaluationKey({ ...original, review: { checkOrder: false } }), key);
  assert.notEqual(evaluationKey({ ...original, candidate: { response: 'Other response' } }), key);
});

test('assessment identity uses effective prompts instead of invisible blank overrides', () => {
  const original = input();
  const key = evaluationKey(original);
  original.baseline.prompt = ' \t ';
  original.candidate.prompt = '\r\n';
  assert.equal(evaluationKey(original), key);
  original.candidate.prompt = 'Different task.';
  assert.notEqual(evaluationKey(original), key);
});

function generationApi() {
  class CancellationTokenSource {
    constructor() { this.callbacks = []; this.token = { isCancellationRequested: false,
      onCancellationRequested: callback => { this.callbacks.push(callback); return { dispose() {} }; } }; }
    cancel() { this.token.isCancellationRequested = true; for (const callback of this.callbacks) callback(); }
    dispose() {}
  }
  return { ...vscode, CancellationTokenSource };
}

test('VS Code generation discovers available models and rejects unavailable selections', async () => {
  const model = fakeModel();
  let selector;
  const api = { ...vscode, lm: { selectChatModels: async value => { selector = value; return [model]; } },
    window: { showQuickPick: async items => items[0] } };
  assert.equal(await selectRunModel(api), model);
  assert.deepEqual(selector, {});
  const selected = await resolveRunModels(api, { baseline: { provider: 'vscode', model: model.id, modelVendor: model.vendor } });
  assert.equal(selected.baseline, model);
  await assert.rejects(resolveRunModels(api, { candidate: { provider: 'vscode', model: 'missing' } }), /no longer available/);
});

test('VS Code generation uses only the selected model, records actual request roles, and labels usage unknown', async () => {
  const api = generationApi();
  const model = fakeModel();
  let request;
  model.sendRequest = async (messages, options) => { request = { messages, options }; return { text: (async function* () { yield 'Generated answer'; })() }; };
  const result = await runWithVsCode(api, { prompt: 'Incoming event', systemPrompt: 'Agent instructions' }, model);
  assert.deepEqual(request.messages.map(message => message.content), ['Agent instructions', 'Incoming event']);
  assert.deepEqual(request.options, {});
  assert.ok(result.requestMessages.every(message => message.role === 'user'));
  assert.equal(result.model, model.id);
  assert.equal(result.response, 'Generated answer');
  assert.equal(result.estimatedInputTokens, 200);
  assert.equal(result.inputTokens, null);
  assert.equal(result.outputTokens, null);
});

test('VS Code generation rejects cancellation, oversized inputs, and empty output', async () => {
  const api = generationApi();
  const model = fakeModel();
  const cancelled = new api.CancellationTokenSource();
  cancelled.cancel();
  await assert.rejects(runWithVsCode(api, { prompt: 'Task' }, model, cancelled.token), api.CancellationError);
  model.maxInputTokens = 50;
  await assert.rejects(runWithVsCode(api, { prompt: 'Task' }, model), /input limit/);
  assert.equal(model.requests.length, 0);
  model.maxInputTokens = 10000;
  model.sendRequest = async () => ({ text: (async function* () { yield ''; })() });
  await assert.rejects(runWithVsCode(api, { prompt: 'Task' }, model), /no visible response/);
});
