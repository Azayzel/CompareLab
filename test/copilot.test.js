const test = require('node:test');
const assert = require('node:assert/strict');
const { selectEvaluator, selectRunModel, resolveRunModels } = require('../src/providers/vscode/models');
const { runWithVsCode } = require('../src/providers/vscode/generation');
const { evaluateWithCopilot, openReviewChat, evaluationKey } = require('../src/providers/vscode/review');
const { REVIEW_CRITERIA } = require('../src/comparison/core');

const input = () => ({ prompt: 'Triage these failures.', evidence: 'HTTP 401 responses increased.',
  baseline: { model: 'hidden-model-one', response: 'Roll back.' },
  candidate: { model: 'hidden-model-two', response: 'Check authentication.' } });
const vscode = { LanguageModelChatMessage: { User: content => ({ role: 'user', content }),
  Assistant: content => ({ role: 'assistant', content }) }, CancellationError: class extends Error {} };

test('VS Code tool rounds preserve tool calls and results while tolerating reasoning and future parts', async t => {
  class LanguageModelTextPart { constructor(value) { this.value = value; } }
  class LanguageModelThinkingPart { constructor(value) { this.value = value; } }
  class FuturePart { constructor() { this.data = 'private provider metadata'; } }
  const warnings = [];
  t.mock.method(console, 'debug', message => warnings.push(message));
  class LanguageModelToolCallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
  class LanguageModelToolResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
  class CancellationTokenSource {
    constructor() { this.token = { isCancellationRequested: false }; }
    dispose() {}
  }
  const api = { ...vscode, LanguageModelTextPart, LanguageModelThinkingPart, LanguageModelToolCallPart, LanguageModelToolResultPart, CancellationTokenSource,
    LanguageModelChatMessage: { ...vscode.LanguageModelChatMessage, Assistant: content => ({ role: 'assistant', content }) } };
  const model = { id: 'tool-model', maxInputTokens: 10000, countTokens: async () => 10,
    sendRequest: async (messages, options) => {
      assert.equal(messages[0].role, 'user');
      assert.ok(messages[1].content[0] instanceof LanguageModelToolCallPart);
      assert.ok(messages[2].content[0] instanceof LanguageModelToolResultPart);
      assert.equal(options.tools[0].name, 'datadog-search_logs');
      return { stream: (async function* () {
        yield new LanguageModelThinkingPart('private reasoning');
        yield new FuturePart();
        yield new FuturePart();
        yield new LanguageModelToolCallPart('next', 'datadog-search_logs', { query: '401' });
      })() };
    } };
  const result = await runWithVsCode(api, { prompt: 'Investigate', systemPrompt: 'Instructions' }, model, undefined, {
    tools: [{ name: 'datadog-search_logs', description: 'Search', inputSchema: { type: 'object' } }],
    conversation: [{ role: 'system', content: 'Instructions' },
      { role: 'assistant', content: '', toolCalls: [{ callId: 'first', name: 'datadog-search_logs', input: {} }] },
      { role: 'tool', toolCallId: 'first', content: '401 increased' }]
  });
  assert.equal(result.response, '');
  assert.equal(result.toolCalls[0].name, 'datadog-search_logs');
  assert.equal(result.requestMessages[0].role, 'user');
  assert.equal(result.estimatedInputTokens, 40);
  assert.equal(result.estimatedOutputTokens, 10);
  assert.deepEqual(warnings, ['CompareLab: skipped optional provider response part (FuturePart); continuing with text and tool calls.']);
  assert.doesNotMatch(JSON.stringify(result), /private reasoning|private provider metadata/);

  model.sendRequest = async (messages, options) => {
    assert.deepEqual(options, {}, 'Reserved final requests must not offer tools');
    return { stream: (async function* () {
    yield new LanguageModelThinkingPart(['private', 'reasoning']);
    yield new LanguageModelTextPart('Observed HTTP 401.');
    })() };
  };
  const final = await runWithVsCode(api, { prompt: 'Investigate' }, model, undefined, { tools: [] });
  assert.equal(final.response, 'Observed HTTP 401.');
  assert.deepEqual(final.toolCalls, []);

  model.sendRequest = async () => ({ stream: (async function* () { yield new LanguageModelThinkingPart('No final answer'); })() });
  await assert.rejects(runWithVsCode(api, { prompt: 'Investigate' }, model, undefined, { tools: [] }), /no visible response/);
  model.sendRequest = async () => ({ stream: (async function* () { yield new LanguageModelThinkingPart('x'.repeat(2 * 1024 * 1024)); })() });
  await assert.rejects(runWithVsCode(api, { prompt: 'Investigate' }, model, undefined, { tools: [] }), /2 MiB/);
});

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
          citations: [{ source: 'A', quote: packet.A.slice(0, 200) }, { source: 'B', quote: packet.B.slice(0, 200) },
            ...(packet.evidence ? [{ source: 'evidence', quote: packet.evidence.slice(0, 200) }] : [])] })) };
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
    assert.equal(result.usageTurns.length, 3);
    assert.ok(result.usageTurns.every(turn => turn.estimatedInputTokens === 200 && turn.estimatedOutputTokens === 100));
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
  await assert.rejects(evaluateWithCopilot(vscode, large, model, { isCancellationRequested: false }), /needs 200 input tokens.*input limit of 100/);
  assert.equal(model.requests.length, 0);
});

test('large full-evidence reviews use the model token limit in both orders and citation correction', async () => {
  const experiment = {
    prompt: 'Instructions: ' + 'i'.repeat(29547),
    evidence: 'Observed source: ' + 'e'.repeat(750000) + ' EVIDENCE_TAIL',
    baseline: { response: 'Baseline report: ' + 'a'.repeat(4500) + ' BASELINE_TAIL' },
    candidate: { response: 'Candidate report: ' + 'b'.repeat(5900) + ' CANDIDATE_TAIL' }
  };
  const model = fakeModel(false, [1]);
  model.maxInputTokens = 1000000;
  model.countTokens = async message => Math.ceil(message.content.length / 4);
  const result = await evaluateWithCopilot(vscode, experiment, model, { isCancellationRequested: false });
  assert.equal(result.requestCount, 3);
  assert.equal(result.citationRepairs, 1);
  assert.ok(result.inputTokenEstimates.every(count => count > 150000 && count < model.maxInputTokens));
  for (const [index, request] of model.requests.entries()) {
    assert.ok(request.messages[1].content.length > 769000, 'Covers the observed failed packet sizes');
    const packet = JSON.parse(request.messages[1].content);
    assert.equal(packet.evidence, experiment.evidence);
    assert.equal(packet.taskA, experiment.prompt);
    assert.equal(packet.taskB, experiment.prompt);
    assert.equal(packet.A, index === 2 ? experiment.candidate.response : experiment.baseline.response);
    assert.equal(packet.B, index === 2 ? experiment.baseline.response : experiment.candidate.response);
  }
});

test('review input limits accept the exact token boundary and reject one token over before sending', async () => {
  for (const limit of [199, 200]) {
    const model = fakeModel();
    model.maxInputTokens = limit;
    const run = evaluateWithCopilot(vscode, { ...input(), review: { checkOrder: false } }, model, { isCancellationRequested: false });
    if (limit === 200) {
      assert.deepEqual((await run).inputTokenEstimates, [200]);
      assert.equal(model.requests.length, 1);
    } else {
      await assert.rejects(run, /needs 200 input tokens.*reviewer.*input limit of 199.*larger-context.*nothing was truncated/);
      assert.equal(model.requests.length, 0);
    }
  }
});

test('reviews require a usable model limit and valid counts instead of assuming oversized input fits', async () => {
  for (const limit of [undefined, 10000.5]) {
    const model = fakeModel();
    model.maxInputTokens = limit;
    await assert.rejects(evaluateWithCopilot(vscode, input(), model, { isCancellationRequested: false }), /usable input-token limit/);
    assert.equal(model.requests.length, 0);
  }
  for (const count of [0, -1, NaN, Infinity, 0.5]) {
    const model = fakeModel();
    model.countTokens = async () => count;
    await assert.rejects(evaluateWithCopilot(vscode, input(), model, { isCancellationRequested: false }), /invalid input-token count/);
    assert.equal(model.requests.length, 0);
  }
});

test('Chat draft handoff remains bounded separately from direct evaluator reviews', async () => {
  await assert.rejects(openReviewChat({}, { ...input(), evidence: 'x'.repeat(150000) }),
    /Chat review draft.*150,000-character.*Evaluate with Copilot/);
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

test('generation and evaluator pickers exclude core-only models and saved selections fail before requests', async () => {
  const model = fakeModel();
  const internal = ['copilot-dictation-cleanup-nano', 'copilot-dictation-cleanup-luna'].map(id => ({ ...model, id }));
  const api = { ...vscode, lm: { selectChatModels: async () => [...internal, model] },
    window: { showQuickPick: async items => {
      assert.deepEqual(items.map(item => item.model.id), [model.id]);
      return items[0];
    } } };
  assert.equal(await selectRunModel(api), model);
  assert.equal(await selectEvaluator(api), model);
  for (const item of internal) {
    await assert.rejects(resolveRunModels(api, { baseline: { provider: 'vscode', model: item.id } }), /baseline.*reserved for VS Code core.*Select model/);
  }
  assert.equal(model.requests.length, 0);
  api.lm.selectChatModels = async () => internal;
  await assert.rejects(selectRunModel(api), /No VS Code models/);
  await assert.rejects(selectEvaluator(api), /No Copilot models/);
});

test('new provider-only restrictions give an actionable error without substituting another model', async () => {
  const model = fakeModel();
  let requests = 0;
  model.sendRequest = async () => {
    requests++;
    throw new Error('Model internal-new-model is only available to VS Code core.');
  };
  await assert.rejects(runWithVsCode(generationApi(), { prompt: 'Task' }, model), /reserved for VS Code core.*Select model/);
  assert.equal(requests, 1);
});

test('pickers exclude session-only models and setup placeholders, not real provider models', async () => {
  const direct = fakeModel();
  const foundry = { ...direct, vendor: 'aitk-foundry', id: 'project/deployment' };
  const routed = { ...direct, id: 'auto' };
  const excluded = [
    { ...direct, vendor: 'copilotcli', id: 'auto', maxInputTokens: 0 },
    { ...direct, vendor: 'agent-host-copilotcli', id: 'concrete-model', maxInputTokens: 128000 },
    { ...direct, vendor: 'agent-host-claude', id: 'concrete-model', maxInputTokens: 128000 },
    { ...direct, vendor: 'aitk-foundry', id: 'aitk-foundry/__no-project__', maxInputTokens: 1 },
    { ...direct, vendor: 'other', id: 'not-ready', maxInputTokens: 0 },
    { ...direct, vendor: 'other', id: 'invalid-limit', maxInputTokens: NaN }
  ];
  const api = { lm: { selectChatModels: async selector => {
    const all = [...excluded, direct, foundry, routed];
    return selector.vendor ? all.filter(model => model.vendor === selector.vendor) : all;
  } }, window: { showQuickPick: async items => {
    assert.ok(items.every(item => !excluded.includes(item.model)));
    assert.ok(items.some(item => item.model === routed), 'A real direct-provider Auto entry is not a session placeholder');
    return items[0];
  } } };
  assert.equal(await selectRunModel(api), direct);
  assert.equal(await selectEvaluator(api), direct);
  for (const model of excluded) {
    await assert.rejects(resolveRunModels(api, { candidate: { provider: 'vscode', model: model.id, modelVendor: model.vendor } }),
      /candidate.*(session-only|placeholder|not ready).*Select model/);
    await assert.rejects(runWithVsCode(generationApi(), { prompt: 'Task' }, model), /Select model/);
    await assert.rejects(evaluateWithCopilot(vscode, input(), model, { isCancellationRequested: false }), /Select model/);
  }
  assert.equal(direct.requests.length, 0);
});

test('unavailable catalogs offer explicit retry without showing unusable picker entries', async () => {
  const model = fakeModel();
  let queries = 0;
  let picks = 0;
  const api = { lm: { selectChatModels: async () => ++queries === 1
    ? [{ ...model, vendor: 'copilotcli', id: 'auto', maxInputTokens: 0 },
      { ...model, vendor: 'aitk-foundry', id: '__no-project__', maxInputTokens: 1 }] : [model] },
    window: {
      showWarningMessage: async (message, ...actions) => {
        assert.match(message, /copilotcli\/auto: a session-only/);
        assert.match(message, /project-selection placeholder/);
        assert.match(message, /in this window/);
        assert.ok(actions.includes('Retry'));
        return 'Retry';
      },
      showQuickPick: async items => { picks++; return items[0]; }
    } };
  assert.equal(await selectRunModel(api), model);
  assert.equal(queries, 2);
  assert.equal(picks, 1);
  assert.equal(model.requests.length, 0);
});

test('empty model discovery supports provider setup and cancellation without guessing a model', async () => {
  const commands = [];
  let action;
  const api = { lm: { selectChatModels: async () => [] },
    commands: { executeCommand: async (...args) => commands.push(args) },
    window: {
      showWarningMessage: async () => action,
      showQuickPick: async () => assert.fail('An empty catalog must not open a model picker')
    } };
  assert.equal(await selectRunModel(api), undefined);
  assert.equal(commands.length, 0);
  action = 'Open Copilot extension';
  assert.equal(await selectEvaluator(api), undefined);
  assert.deepEqual(commands, [['extension.open', 'GitHub.copilot-chat']]);
});

test('model discovery activates an installed inactive Copilot provider once before retrying', async () => {
  const model = fakeModel();
  let active = false;
  let activations = 0;
  let queries = 0;
  const api = { lm: { selectChatModels: async () => { queries++; return active ? [model] : []; } },
    extensions: { getExtension: id => {
      assert.equal(id, 'GitHub.copilot-chat');
      return { isActive: active, activate: async () => { activations++; active = true; } };
    } },
    window: { showQuickPick: async items => items[0] } };
  assert.equal(await selectRunModel(api), model);
  assert.equal(activations, 1);
  assert.equal(queries, 2);
  assert.equal(await selectEvaluator(api), model);
  assert.equal(activations, 1);
  api.extensions.getExtension = () => ({ isActive: false, activate: async () => { throw new Error('Provider activation failed'); } });
  api.lm.selectChatModels = async () => [];
  await assert.rejects(selectRunModel(api), /Provider activation failed/);
});

test('Datadog preflight rejects declared lack of tool support but preserves ordinary runs and older models', async () => {
  const model = fakeModel();
  const api = { lm: { selectChatModels: async () => [model] } };
  const variants = { candidate: { provider: 'vscode', model: model.id } };
  for (const capabilities of [{ supportsToolCalling: false }, { toolCalling: false }, { toolCalling: 0 }]) {
    model.capabilities = capabilities;
    await assert.rejects(resolveRunModels(api, variants, { requireTools: true }), /candidate.*does not support tool calling/);
    assert.equal((await resolveRunModels(api, variants)).candidate, model);
  }
  delete model.capabilities;
  assert.equal((await resolveRunModels(api, variants, { requireTools: true })).candidate, model);
  assert.equal(model.requests.length, 0);
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
  assert.equal(result.estimatedOutputTokens, 100);
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

test('frozen prompt generation sizes complete messages by tokens rather than characters', async () => {
  const api = generationApi();
  const prompt = 'Complete evidence snapshot. '.repeat(10000);
  const model = fakeModel();
  const requests = [];
  model.sendRequest = async messages => {
    requests.push(messages);
    return { text: (async function* () { yield 'Grounded answer'; })() };
  };
  model.maxInputTokens = 200;
  const request = { prompt, systemPrompt: 'Original instructions' };
  const result = await runWithVsCode(api, request, model, undefined, { tokenAwareInput: true });
  assert.equal(result.estimatedInputTokens, 200);
  assert.equal(requests[0][1].content, prompt);
  assert.equal(result.prompt, prompt);
  model.maxInputTokens = 199;
  await assert.rejects(runWithVsCode(api, request, model, undefined, { tokenAwareInput: true }),
    /needs 200 tokens.*input limit of 199.*nothing was truncated/);
  assert.equal(requests.length, 1);
  for (const limit of [undefined, NaN, 1.5]) {
    model.maxInputTokens = limit;
    await assert.rejects(runWithVsCode(api, request, model, undefined, { tokenAwareInput: true }), /usable input-token limit|not ready/);
  }
  model.maxInputTokens = 10000;
  for (const count of [NaN, 0, -1, 0.5]) {
    model.countTokens = async () => count;
    await assert.rejects(runWithVsCode(api, request, model, undefined, { tokenAwareInput: true }), /invalid input-token count/);
  }
  await assert.rejects(runWithVsCode(api, request, model), /150,000-character limit/);
  assert.equal(requests.length, 1);
});
