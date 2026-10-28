const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { evaluationKey } = require('../src/copilot');
const { reviewPacket } = require('../src/core');

function host(overrides = {}, providerOverrides = {}) {
  const messages = [];
  const files = [];
  const errors = [];
  let handler;
  let open;
  let markup;
  let evaluations = 0;
  const disposable = { dispose() {} };
  class CancellationTokenSource {
    constructor() { this.listeners = []; this.token = { isCancellationRequested: false,
      onCancellationRequested: listener => { this.listeners.push(listener); return disposable; } }; }
    cancel() { this.token.isCancellationRequested = true; for (const listener of this.listeners) listener(); }
    dispose() {}
  }
  const vscode = {
    commands: { registerCommand: (name, callback) => { open = callback; return disposable; } },
    window: {
      createWebviewPanel: () => ({ onDidDispose: () => disposable, webview: {
        set html(value) { markup = value; },
        cspSource: 'self', asWebviewUri: uri => uri, postMessage: async message => messages.push(message),
        onDidReceiveMessage: callback => { handler = callback; }
      } }),
      showErrorMessage: message => errors.push(message), showSaveDialog: async () => 'report.md',
      withProgress: async (options, callback) => callback({ report() {} }, { onCancellationRequested: () => disposable })
    },
    workspace: { fs: { writeFile: async (uri, bytes) => files.push(bytes.toString()) } },
    ViewColumn: { One: 1 }, ProgressLocation: { Notification: 1 }, CancellationTokenSource, CancellationError: class extends Error {},
    Uri: { joinPath: (...parts) => parts.join('/') }
  };
  const copilot = {
    ...require('../src/copilot'),
    evaluationKey, selectEvaluator: async () => ({ name: 'Reviewer' }), openReviewChat: async () => {},
    evaluateWithCopilot: async (api, input) => {
      evaluations++;
      return { inputFingerprint: evaluationKey(input), verdict: 'tie', summary: 'No decisive difference.',
        note: 'Not verified ground truth.', criteria: [], unknowns: [], judgments: [], model: { name: 'Reviewer', id: 'reviewer', version: 'v1' },
        inputTokenEstimates: [], orderConsistent: null, rubricVersion: 1, elapsedMs: 1 };
    }, ...overrides
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8'), {
    module, Buffer, setTimeout, clearTimeout, AbortController,
    require: name => name === 'vscode' ? vscode : name === './copilot' ? copilot
      : name === './providers' ? { ...require('../src/providers'), ...providerOverrides }
      : name.startsWith('./') ? require('../src/' + name.slice(2)) : require(name)
  });
  module.exports.activate({ subscriptions: [], extensionUri: '/extension', secrets: { get: async () => undefined } });
  open();
  return { messages, files, errors, vscode, markup, send: message => handler(message), evaluations: () => evaluations };
}

const experiment = () => ({ prompt: 'Review this task.', evidence: 'Shared source.',
  baseline: { response: 'First answer.' }, candidate: { response: 'Second answer.' } });

test('prompt override fields preserve multiline agent instructions in the real HTML', () => {
  const instance = host();
  assert.match(instance.markup, /<textarea id="a-prompt"/);
  assert.match(instance.markup, /<textarea id="b-prompt"/);
  assert.doesNotMatch(instance.markup, /<input id="[ab]-prompt"/);
});

function webview(initialState) {
  const elements = new Map();
  const messages = [];
  let state = initialState;
  let onMessage;
  const node = () => ({
    value: '', checked: true, listeners: new Map(), children: [],
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    closest: () => ({}), addEventListener(type, callback) { this.listeners.set(type, callback); }
  });
  const field = id => {
    if (!elements.has(id)) elements.set(id, { ...node(), id });
    return elements.get(id);
  };
  for (const prefix of ['a', 'b']) {
    for (const key of ['model', 'prompt', 'response', 'provider', 'endpoint', 'tokenLimitField', 'reportedModel',
      'modelVersion', 'contextWindowTokens', 'contextWindowSource', 'inputTokens', 'outputTokens', 'maxOutputTokens',
      'finishReason', 'temperature']) field(prefix + '-' + key);
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/app.js'), 'utf8'), {
    document: { getElementById: field, createElement: node, querySelectorAll: () => [...elements.values()] },
    window: { addEventListener(type, listener) { if (type === 'message') onMessage = listener; } },
    acquireVsCodeApi: () => ({ getState: () => state, setState: value => { state = value; }, postMessage: message => messages.push(message) })
  });
  return { field, messages, state: () => state, click: id => field(id).listeners.get('click')(),
    receive: data => onMessage({ data }) };
}

function runExport() {
  return { schemaVersion: 1, kind: 'codemind-agent-run', variant: {
    model: 'deployment', provider: 'manual', runId: 'run-1', response: 'Saved answer', prompt: '',
    executionTrace: { schemaVersion: 1, id: 'run-1:1', runId: 'run-1', attempt: 1,
      outcome: 'Failed', captureCompleteness: 'partial', contentSnapshotsEnabled: false, events: [] }
  } };
}

test('imports a single CodeMind run without losing the opposite side and preserves trace through panel exports', async () => {
  const instance = host();
  instance.vscode.window.showOpenDialog = async () => ['run.json'];
  instance.vscode.window.showQuickPick = async () => 'Candidate';
  instance.vscode.workspace.fs.readFile = async () => Buffer.from(JSON.stringify(runExport()));
  await instance.send({ type: 'import', experiment: experiment() });
  assert.equal(instance.errors.length, 0);
  const imported = instance.messages.findLast(message => message.type === 'imported').experiment;
  assert.equal(imported.baseline.response, 'First answer.');
  assert.equal(imported.candidate.response, 'Saved answer');
  const panel = webview(imported);
  panel.click('export');
  const request = panel.messages.at(-1);
  assert.equal(request.experiment.candidate.executionTrace.outcome, 'Failed');
  await instance.send(request);
  assert.equal(JSON.parse(instance.files[0]).candidate.executionTrace.runId, 'run-1');
  assert.equal(instance.evaluations(), 0);
  panel.click('compare');
  const comparisonRequest = panel.messages.at(-1);
  await instance.send(comparisonRequest);
  panel.receive(instance.messages.findLast(message => message.type === 'result'));
  assert.ok(panel.field('traces').children.length > 0);
  panel.field('b-response').value = 'Edited answer';
  panel.field('b-response').listeners.get('input')();
  assert.equal(panel.state().candidate.executionTrace, undefined);
});

test('rejects invalid trace imports visibly and does not replace the current experiment', async () => {
  const instance = host();
  instance.vscode.window.showOpenDialog = async () => ['run.json'];
  instance.vscode.window.showQuickPick = async () => 'Baseline';
  const input = runExport();
  input.variant.executionTrace.schemaVersion = 2;
  instance.vscode.workspace.fs.readFile = async () => Buffer.from(JSON.stringify(input));
  await instance.send({ type: 'import', experiment: experiment() });
  assert.match(instance.errors[0], /invalid CodeMind execution trace/);
  assert.equal(instance.messages.some(message => message.type === 'imported'), false);
});

test('webview submits the visible shared prompt and ignores blank overrides without requiring evidence', async () => {
  for (const override of ['', ' \t ', '\u00a0']) {
    const input = experiment();
    input.prompt = '';
    input.evidence = '';
    input.baseline.prompt = override;
    input.candidate.prompt = override;
    const panel = webview(input);
    panel.field('prompt').value = '# Diagnostics agent\n\nTriage this alert.';
    panel.click('evaluate');
    const request = panel.messages.at(-1);
    assert.equal(request.type, 'evaluate');
    assert.equal(request.experiment.prompt, panel.field('prompt').value);
    assert.equal(request.experiment.baseline.prompt, undefined);
    assert.equal(request.experiment.candidate.prompt, undefined);
    assert.equal(panel.state().prompt, panel.field('prompt').value);
    const instance = host();
    await instance.send(request);
    assert.equal(instance.evaluations(), 1);
    assert.equal(instance.errors.length, 0);
    const result = instance.messages.findLast(message => message.type === 'result').result;
    assert.equal(result.baseline.prompt, panel.field('prompt').value);
    assert.equal(result.candidate.prompt, panel.field('prompt').value);
    panel.click('chat');
    const packet = reviewPacket(panel.messages.at(-1).experiment);
    assert.equal(packet.taskA, panel.field('prompt').value);
    assert.equal(packet.taskB, panel.field('prompt').value);
  }
});

test('webview retains meaningful overrides and reports genuinely missing tasks before model selection', async () => {
  const panel = webview(experiment());
  panel.field('b-prompt').value = '  Different candidate task.  ';
  panel.field('prompt').value = ' \t ';
  panel.click('evaluate');
  const request = panel.messages.at(-1);
  assert.equal(request.experiment.candidate.prompt, '  Different candidate task.  ');
  const instance = host();
  await instance.send(request);
  assert.equal(instance.evaluations(), 0);
  assert.match(instance.errors[0], /original task for Baseline\. Enter a Shared prompt/);
});

test('comparison is offline; evaluation is explicit and reused for report export', async () => {
  const instance = host();
  const input = experiment();
  await instance.send({ type: 'compare', experiment: input, revision: 1 });
  assert.equal(instance.evaluations(), 0);
  assert.equal(instance.messages.at(-1).result.evaluation, null);
  await instance.send({ type: 'evaluate', experiment: input, revision: 1 });
  assert.equal(instance.evaluations(), 1);
  assert.equal(instance.messages.findLast(message => message.type === 'result').result.evaluation.verdict, 'tie');
  await instance.send({ type: 'report', experiment: input });
  assert.equal(instance.evaluations(), 1);
  assert.match(instance.files[0], /\*\*Tie\*\*/);
  assert.equal(instance.messages.at(-1).value, false);
});

test('changed source evidence cannot reuse a cached assessment', async () => {
  const instance = host();
  const input = experiment();
  await instance.send({ type: 'evaluate', experiment: input, revision: 1 });
  input.evidence = 'Different evidence.';
  await instance.send({ type: 'compare', experiment: input, revision: 2 });
  assert.equal(instance.messages.at(-1).result.evaluation, null);
  assert.equal(instance.messages.at(-1).revision, 2);
  await instance.send({ type: 'report', experiment: input });
  assert.match(instance.files[0], /Not evaluated/);
});

test('cancelled selection and model failures always release busy state', async () => {
  const cancelled = host({ selectEvaluator: async () => undefined });
  await cancelled.send({ type: 'evaluate', experiment: experiment() });
  assert.equal(cancelled.messages.at(-1).value, false);
  assert.ok(cancelled.messages.some(message => message.message === 'Evaluation cancelled.'));
  const failed = host({ evaluateWithCopilot: async () => { throw new Error('No permission'); } });
  await failed.send({ type: 'evaluate', experiment: experiment() });
  assert.equal(failed.messages.at(-1).value, false);
  assert.match(failed.errors[0], /No permission/);
});

test('cancelling during model selection prevents the evaluation request', async () => {
  let started;
  let select;
  const ready = new Promise(resolve => { started = resolve; });
  const selection = new Promise(resolve => { select = resolve; });
  const instance = host({ selectEvaluator: async () => { started(); return selection; } });
  const request = instance.send({ type: 'evaluate', experiment: experiment() });
  await ready;
  await instance.send({ type: 'cancelReview' });
  select({ name: 'Reviewer' });
  await request;
  assert.equal(instance.evaluations(), 0);
  assert.equal(instance.messages.at(-1).value, false);
  assert.ok(instance.messages.some(message => message.message === 'Evaluation cancelled.'));
});

test('cancelling an active review propagates the cancellation token', async () => {
  let started;
  let finish;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const instance = host({ evaluateWithCopilot: async (api, input, model, token) => {
    started();
    await pending;
    assert.equal(token.isCancellationRequested, true);
    throw new api.CancellationError();
  } });
  const request = instance.send({ type: 'evaluate', experiment: experiment() });
  await ready;
  await instance.send({ type: 'cancelReview' });
  finish();
  await request;
  assert.equal(instance.messages.at(-1).value, false);
  assert.equal(instance.errors.length, 0);
});

test('Orchestrate Test runs fresh pairs, persists its record, and exports without more model requests', async () => {
  const calls = [];
  const instance = host({}, { runModel: async (input, options) => {
    calls.push(input);
    assert.ok(options.signal);
    return { ...input, response: input.model + ' answer', reportedModel: input.model, inputTokens: 10, outputTokens: 4, elapsedMs: 20 };
  } });
  const input = { ...experiment(), prompt: 'Instructions\n{{alert}}', incomingMessage: 'Incoming alert 123', test: { repetitions: 2 },
    baseline: { provider: 'ollama', model: 'baseline' }, candidate: { provider: 'ollama', model: 'candidate' } };
  await instance.send({ type: 'orchestrate', experiment: input });
  assert.equal(instance.errors.length, 0);
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map(call => call.prompt)).size, 1);
  assert.equal(instance.evaluations(), 2);
  const completed = instance.messages.findLast(message => message.type === 'testFinished').experiment;
  assert.equal(completed.testRun.status, 'completed');
  assert.equal(completed.prompt, input.prompt);
  assert.equal(completed.incomingMessage, input.incomingMessage);
  assert.equal(completed.testRun.plan.task, 'Instructions\nIncoming alert 123');
  const panel = webview(completed);
  panel.click('report');
  await instance.send(panel.messages.at(-1));
  assert.match(instance.files[0], /Orchestrated test/);
  assert.match(instance.files[0], /Frozen inputs and complete test record/);
  panel.click('export');
  await instance.send(panel.messages.at(-1));
  assert.equal(JSON.parse(instance.files[1]).testRun.pairs.length, 2);
  assert.equal(JSON.parse(instance.files[1]).incomingMessage, input.incomingMessage);
  assert.equal(calls.length, 4);
  assert.equal(instance.evaluations(), 2);
});

test('Orchestrate Test rejects missing evidence and cancelled selection before generation', async () => {
  let calls = 0;
  const instance = host({ selectEvaluator: async () => undefined }, { runModel: async () => { calls++; } });
  const input = { ...experiment(), baseline: { provider: 'ollama', model: 'baseline' }, candidate: { provider: 'ollama', model: 'candidate' } };
  await instance.send({ type: 'orchestrate', experiment: { ...input, evidence: '' } });
  assert.match(instance.errors[0], /requires Source evidence/);
  await instance.send({ type: 'orchestrate', experiment: input });
  assert.equal(calls, 0);
  assert.equal(instance.messages.at(-1).value, false);
});

test('agent-file loading changes only instructions and makes no model calls', async () => {
  const instance = host();
  instance.vscode.window.showOpenDialog = async () => ['agent.md'];
  instance.vscode.workspace.fs.readFile = async () => Buffer.from('Agent instructions\n{{message}}');
  await instance.send({ type: 'loadInstructions' });
  const panel = webview({ ...experiment(), incomingMessage: 'Trigger payload' });
  panel.receive(instance.messages.at(-1));
  assert.equal(panel.state().prompt, 'Agent instructions\n{{message}}');
  assert.equal(panel.state().incomingMessage, 'Trigger payload');
  assert.equal(panel.state().baseline.response, 'First answer.');
  assert.equal(instance.evaluations(), 0);
});

test('ordinary model reruns preserve the template and inject the incoming message only once', async () => {
  const calls = [];
  const instance = host({}, { runModel: async input => { calls.push(input.prompt); return { ...input, response: 'Generated answer', elapsedMs: 1 }; } });
  const panel = webview({ ...experiment(), incomingMessage: 'Trigger payload', baseline: { provider: 'ollama', model: 'model' } });
  for (let attempt = 0; attempt < 2; attempt++) {
    panel.click('a-run');
    await instance.send(panel.messages.at(-1));
    panel.receive(instance.messages.findLast(message => message.type === 'runResult'));
  }
  assert.deepEqual(calls, ['Review this task.\n\n## Incoming message\n\nTrigger payload', 'Review this task.\n\n## Incoming message\n\nTrigger payload']);
});

test('orchestration cancellation aborts an active provider and saves its partial record', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const instance = host({}, { runModel: async (input, { signal }) => {
    calls++;
    started();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
  } });
  const input = { ...experiment(), baseline: { provider: 'ollama', model: 'baseline' }, candidate: { provider: 'ollama', model: 'candidate' } };
  const request = instance.send({ type: 'orchestrate', experiment: input });
  await ready;
  await instance.send({ type: 'cancelReview' });
  await request;
  assert.equal(calls, 1);
  assert.equal(instance.evaluations(), 0);
  assert.equal(instance.messages.findLast(message => message.type === 'testFinished').experiment.testRun.status, 'cancelled');
  assert.equal(instance.messages.at(-1).value, false);
});

test('ordinary CodeMind-shaped runs separate the agent instructions and normalized event', async () => {
  let sent;
  const instance = host({}, { runModel: async input => { sent = input; return { ...input, response: 'Answer', elapsedMs: 1 }; } });
  await instance.send({ type: 'run', side: 'a', experiment: { ...experiment(), prompt: 'Instructions {{alert}}',
    incomingMessage: '{"eventId":"event-123","monitorId":"123","body":"Failed requests"}', baseline: { provider: 'ollama', model: 'model' } } });
  assert.equal(sent.systemPrompt, 'Instructions {{alert}}');
  assert.match(sent.prompt, /^Analyze this Datadog alert event:/);
  assert.match(sent.prompt, /"eventId":"event-123"/);
  assert.equal(instance.errors.length, 0);
});

test('the VS Code model picker uses available models and clears incompatible endpoint settings', async () => {
  const instance = host();
  instance.vscode.lm = { selectChatModels: async () => [{ id: 'available-model', name: 'Available Model', vendor: 'copilot', version: 'v1', maxInputTokens: 10000 }] };
  instance.vscode.window.showQuickPick = async items => items[0];
  await instance.send({ type: 'selectModel', side: 'a' });
  const panel = webview({ ...experiment(), baseline: { provider: 'ollama', model: 'old', maxOutputTokens: 100, temperature: 0 } });
  panel.receive(instance.messages.findLast(message => message.type === 'modelSelected'));
  assert.equal(panel.state().baseline.provider, 'vscode');
  assert.equal(panel.state().baseline.model, 'available-model');
  assert.equal(panel.state().baseline.modelVendor, 'copilot');
  assert.equal(panel.state().baseline.maxOutputTokens, undefined);
  assert.equal(panel.field('a-model').readOnly, true);
});

test('orchestration uses selected VS Code models without calling HTTP endpoints', async () => {
  const calls = [];
  const instance = host({}, { runModel: async () => { throw new Error('HTTP must not be called'); } });
  const models = ['baseline-model', 'candidate-model'].map(id => ({ id, name: id, vendor: 'copilot', version: 'v1', maxInputTokens: 10000,
    countTokens: async () => 50, sendRequest: async messages => { calls.push({ id, messages }); return { text: (async function* () { yield id + ' answer'; })() }; } }));
  instance.vscode.lm = { selectChatModels: async () => models };
  instance.vscode.LanguageModelChatMessage = { User: content => ({ content }) };
  await instance.send({ type: 'orchestrate', experiment: { ...experiment(), test: { repetitions: 2 },
    baseline: { provider: 'vscode', model: 'baseline-model' }, candidate: { provider: 'vscode', model: 'candidate-model' } } });
  assert.equal(instance.errors.length, 0);
  assert.deepEqual(calls.map(call => call.id), ['baseline-model', 'candidate-model', 'candidate-model', 'baseline-model']);
  const record = instance.messages.findLast(message => message.type === 'testFinished').experiment.testRun;
  assert.equal(record.status, 'completed');
  assert.equal(record.pairs[0].baseline.result.inputTokens, null);
  assert.equal(record.pairs[0].baseline.result.estimatedInputTokens, 50);
});
