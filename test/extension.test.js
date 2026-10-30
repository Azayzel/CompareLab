const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { evaluationKey } = require('../src/copilot');
const { reviewPacket } = require('../src/core');
const { AGENT_PROMPT } = require('../src/tool-agent');

function host(overrides = {}, providerOverrides = {}, historyOverrides = {}) {
  const messages = [];
  const files = [];
  const errors = [];
  let handler;
  let open;
  let markup;
  let evaluations = 0;
  let onDispose;
  const historyEntries = [];
  const history = {
    async save(experiment, evaluation) {
      const entry = { id: 'history-' + (historyEntries.length + 1), savedAt: new Date().toISOString(),
        experiment: structuredClone(experiment), evaluation: structuredClone(evaluation) };
      historyEntries.push(entry);
      return { entry, removed: 0 };
    },
    async list() { return { entries: historyEntries.map(entry => ({ id: entry.id, savedAt: entry.savedAt, title: entry.experiment.prompt,
      status: entry.experiment.testRun?.status || 'saved', baseline: entry.experiment.baseline.model, candidate: entry.experiment.candidate.model })),
      totalBytes: 100, maxEntries: 50, maxBytes: 100 * 1024 * 1024 }; },
    async get(id) { return structuredClone(historyEntries.find(entry => entry.id === id)); },
    async delete(id) { historyEntries.splice(historyEntries.findIndex(entry => entry.id === id), 1); },
    async clear() { historyEntries.length = 0; },
    ...historyOverrides
  };
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
      createWebviewPanel: () => ({ onDidDispose: callback => { onDispose = callback; return disposable; }, webview: {
        set html(value) { markup = value; },
        cspSource: 'self', asWebviewUri: uri => uri, postMessage: async message => messages.push(message),
        onDidReceiveMessage: callback => { handler = callback; }
      } }),
      showErrorMessage: message => errors.push(message), showSaveDialog: async () => 'report.md',
      showQuickPick: async items => items.filter(item => item.tool),
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
      : name === './history' ? { createHistory: () => history }
      : name.startsWith('./') ? require('../src/' + name.slice(2)) : require(name)
  });
  module.exports.activate({ subscriptions: [], extensionUri: '/extension', globalStorageUri: { fsPath: '/history' }, secrets: { get: async () => undefined } });
  open();
  return { messages, files, errors, vscode, markup, historyEntries, dispose: () => onDispose(),
    send: message => handler(message), evaluations: () => evaluations };
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
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const node = () => ({
    value: '', checked: true, listeners: new Map(), children: [],
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this[name] = value; },
    focus() { this.focused = true; },
    scrollIntoView() { this.scrolledIntoView = true; },
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
  for (const id of ['prompt', 'incomingMessage', 'evidence', 'comparisonMode', 'checks', 'testRepetitions', 'checkOrder',
    'optimizerGoal', 'optimizerPreserve', 'optimizerSuccess', 'optimizerDraft']) field(id);
  const scripts = ['markdown.js', 'app.js'].map(file => fs.readFileSync(path.join(__dirname, '../media/' + file), 'utf8')).join('\n');
  vm.runInNewContext(scripts, {
    URL,
    Date: class extends Date { static now() { return now; } },
    setInterval(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
    document: { getElementById: field, createElement: tag => ({ ...node(), tagName: tag.toUpperCase() }),
      createTextNode: text => ({ textContent: text, children: [] }), querySelectorAll: () => [...elements.values()] },
    window: { addEventListener(type, listener) { if (type === 'message') onMessage = listener; } },
    acquireVsCodeApi: () => ({ getState: () => state, setState: value => { state = value; }, postMessage: message => messages.push(message) })
  });
  return { field, messages, state: () => state, click: id => field(id).listeners.get('click')(),
    advanceTime(milliseconds) { now += milliseconds; for (const tick of timers.values()) tick(); },
    timerCount: () => timers.size,
    receive: data => onMessage({ data }) };
}

function runExport() {
  return { schemaVersion: 1, kind: 'codemind-agent-run', variant: {
    model: 'deployment', provider: 'manual', runId: 'run-1', response: 'Saved answer', prompt: '',
    executionTrace: { schemaVersion: 1, id: 'run-1:1', runId: 'run-1', attempt: 1,
      outcome: 'Failed', captureCompleteness: 'partial', contentSnapshotsEnabled: false, events: [] }
  } };
}

const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
const visibleText = node => [node.textContent || '', ...(node.children || []).map(visibleText)].join(' ');

test('native tool selection persists independent drafts and never invokes a tool or saves approval', async () => {
  const instance = host();
  instance.vscode.lm = { tools: [{ name: 'mcp_search', description: 'Search', inputSchema: { type: 'object' }, tags: ['mcp'] }],
    invokeTool: async () => { throw new Error('Selection must not invoke tools'); } };
  const panel = webview(experiment());
  panel.click('selectTools');
  await instance.send(panel.messages.at(-1));
  const selection = instance.messages.findLast(message => message.type === 'toolsSelected');
  panel.receive(selection);
  assert.deepEqual(Array.from(panel.state().toolSelection), ['mcp_search']);
  assert.match(panel.field('toolSelectionSummary').textContent, /Shared tools.*mcp_search/);
  panel.click('promptTab');
  panel.receive({ type: 'toolsSelected', names: ['workspace_read'] });
  panel.click('compareTab');
  assert.deepEqual(Array.from(panel.state().toolSelection), ['mcp_search']);
  const restored = webview(panel.state());
  assert.match(restored.field('toolSelectionSummary').textContent, /mcp_search/);
  assert.deepEqual(instance.errors, []);
  assert.equal(instance.evaluations(), 0);
  assert.doesNotMatch(JSON.stringify(restored.state()), /approvedReadOnlyTools|Approve for this test/);
});

test('changing selected tools clears collected snapshots but preserves manually supplied evidence', () => {
  const source = { ...experiment(), comparisonKind: 'prompt', comparisonMode: 'model-prompt-only',
    toolSelection: ['old_tool'], evidenceCollection: { model: 'collector' },
    baseline: { model: 'shared', prompt: 'Original', response: 'Previous output' },
    candidate: { model: 'shared', prompt: 'Edited', response: 'Previous output' } };
  const panel = webview(source);
  panel.receive({ type: 'toolsSelected', names: ['new_tool'] });
  assert.equal(panel.state().evidence, '');
  assert.equal(panel.state().evidenceCollection, undefined);
  assert.equal(panel.state().baseline.response, undefined);
  const manual = webview({ ...source, evidenceCollection: null });
  manual.receive({ type: 'toolsSelected', names: [] });
  assert.equal(manual.state().evidence, source.evidence);
});

test('missing saved selections fail without substitution or model generation', async () => {
  let calls = 0;
  const instance = host({}, { runModel: async () => { calls++; } });
  instance.vscode.lm = { tools: [{ name: 'available' }], invokeTool: async () => { throw new Error('Must not invoke'); } };
  await instance.send({ type: 'orchestrate', experiment: { ...experiment(), comparisonMode: 'end-to-end',
    toolSelection: ['missing'], baseline: { provider: 'ollama', model: 'one' }, candidate: { provider: 'ollama', model: 'two' } } });
  assert.match(instance.errors[0], /no longer available.*no tools were substituted/);
  assert.equal(calls, 0);
});

test('live runs and evidence collection exclude unverified tools and recheck saved declarations every test', async () => {
  for (const collect of [false, true]) {
    const requests = [];
    let certifications = 0;
    const instance = host({ resolveRunModels: async () => ({ baseline: {}, candidate: {} }),
      runWithVsCode: async (api, request, model, token, options) => {
        requests.push(options?.tools?.map(tool => tool.name));
        assert.doesNotMatch(request.prompt, /STALE_SNAPSHOT/);
        if (!options?.tools) return { ...request, response: 'Frozen evidence answer', elapsedMs: 1 };
        return options.conversation.some(message => message.role === 'tool')
          ? { ...request, response: 'Observed facts', elapsedMs: 1 }
          : { ...request, toolCalls: [{ callId: 'read', name: 'read_data', input: {} }] };
      } });
    class LanguageModelTextPart { constructor(value) { this.value = value; } }
    instance.vscode.LanguageModelTextPart = LanguageModelTextPart;
    const invocations = [];
    instance.vscode.lm = { tools: ['read_data', 'write_data'].map(name => ({ name, description: name, inputSchema: { type: 'object' } })),
      invokeTool: async name => { invocations.push(name); return { content: [new LanguageModelTextPart('Observed facts')] }; } };
    instance.vscode.window.showQuickPick = async (items, options) => {
      assert.match(options.title, /verified are read-only/);
      assert.ok(items.every(item => item.picked === false));
      certifications++;
      return [items.find(item => item.label === 'read_data')];
    };
    instance.vscode.window.showWarningMessage = async () => 'Allow request';
    const source = { prompt: 'Task', incomingMessage: 'Input', evidence: collect ? '' : 'STALE_SNAPSHOT',
      ...(!collect ? { evidenceCollection: { model: 'collector', collectedAt: new Date().toISOString(),
        elapsedMs: 1, modelRequestCount: 1, toolCallCount: 1, usageTurns: [] } } : {}),
      comparisonKind: collect ? 'prompt' : 'model', comparisonMode: collect ? 'model-prompt-only' : 'end-to-end',
      toolSelection: ['read_data', 'write_data'], test: { repetitions: 1 },
      baseline: { provider: 'vscode', model: 'shared', ...(collect ? { prompt: 'Original' } : {}) },
      candidate: { provider: 'vscode', model: 'shared', ...(collect ? { prompt: 'Edited' } : {}) } };
    await instance.send({ type: 'orchestrate', experiment: source });
    assert.deepEqual(instance.errors, []);
    assert.ok(requests.filter(Boolean).every(names => names.join(',') === 'read_data'));
    assert.ok(invocations.every(name => name === 'read_data'));
    const completed = instance.messages.findLast(message => message.type === 'testFinished').experiment;
    assert.deepEqual(completed.toolSelection, ['read_data']);
    assert.equal(collect ? completed.evidenceCollection.toolPolicy : completed.testRun.plan.toolPolicy,
      'verified-read-only-confirm-every-request');
    assert.deepEqual(require('../src/orchestration').validateTestRecord(completed.testRun), completed.testRun);
    const callsBefore = requests.length;
    instance.vscode.window.showQuickPick = async () => { certifications++; return []; };
    await instance.send({ type: 'orchestrate', experiment: {
      ...completed, ...(collect ? { evidence: '', evidenceCollection: undefined } : {}),
      readOnlyTools: ['read_data'], toolPolicy: 'verified-read-only-confirm-every-request'
    } });
    assert.equal(certifications, 2);
    assert.equal(requests.length, callsBefore);
    assert.match(instance.errors.at(-1), /No tools were verified read-only/);
  }
});

test('cancelling read-only verification stops before generation and leaves the saved selection intact', async () => {
  let runs = 0;
  const instance = host({}, { runModel: async () => { runs++; } });
  instance.vscode.lm = { tools: [{ name: 'read_data' }], invokeTool: async () => { throw new Error('Must not run'); } };
  instance.vscode.window.showQuickPick = async () => undefined;
  const source = { ...experiment(), comparisonMode: 'end-to-end', toolSelection: ['read_data'],
    baseline: { provider: 'ollama', model: 'one' }, candidate: { provider: 'ollama', model: 'two' } };
  await instance.send({ type: 'orchestrate', experiment: source });
  assert.deepEqual(instance.errors, []);
  assert.equal(runs, 0);
  assert.equal(instance.messages.some(message => message.type === 'toolsSelected'), false);
  assert.deepEqual(source.toolSelection, ['read_data']);
  assert.match(instance.messages.findLast(message => message.type === 'reviewStatus').message, /Read-only verification cancelled/);
});

test('imports reject malformed tool selections before they reach the webview', () => {
  const { compare } = require('../src/core');
  for (const names of ['tool_name', null, [{}], ['duplicate', 'duplicate']]) {
    assert.throws(() => compare({ ...experiment(), toolSelection: names }), /Invalid selected tool names/);
  }
});

test('manual history saving preserves and restores a review without calling models again', async () => {
  const instance = host();
  const input = experiment();
  await instance.send({ type: 'compare', experiment: input });
  assert.equal(instance.historyEntries.length, 0, 'Ordinary comparisons are not automatically saved');
  await instance.send({ type: 'evaluate', experiment: input });
  await instance.send({ type: 'historySave', experiment: input });
  assert.deepEqual(instance.errors, []);
  assert.equal(instance.historyEntries.length, 1);
  assert.equal(instance.historyEntries[0].evaluation.verdict, 'tie');
  input.baseline.response = 'Unsaved changes';
  instance.vscode.window.showWarningMessage = async () => 'Open comparison';
  await instance.send({ type: 'historyOpen', id: instance.historyEntries[0].id });
  const opened = instance.messages.findLast(message => message.type === 'historyOpened');
  assert.equal(opened.experiment.baseline.response, 'First answer.');
  const panel = webview(input);
  panel.receive(opened);
  await instance.send(panel.messages.at(-1));
  const result = instance.messages.findLast(message => message.type === 'result');
  panel.receive(result);
  assert.equal(result.result.evaluation.verdict, 'tie');
  assert.equal(panel.field('results').scrolledIntoView, true);
  assert.equal(panel.field('results').focused, true);
  assert.equal(instance.evaluations(), 1, 'Opening history does not run the evaluator again');
  const changed = structuredClone(opened.experiment);
  changed.candidate.response = 'Changed after opening';
  await instance.send({ type: 'compare', experiment: changed });
  assert.equal(instance.messages.findLast(message => message.type === 'result').result.evaluation, null);
  assert.equal(instance.historyEntries[0].experiment.candidate.response, 'Second answer.');
});

test('history deletion and clearing require confirmation and leave the current input alone', async () => {
  const instance = host();
  await instance.send({ type: 'historySave', experiment: experiment() });
  const id = instance.historyEntries[0].id;
  instance.vscode.window.showWarningMessage = async () => undefined;
  await instance.send({ type: 'historyDelete', id });
  assert.equal(instance.historyEntries.length, 1);
  await instance.send({ type: 'historyOpen', id });
  assert.ok(!instance.messages.some(message => message.type === 'historyOpened'));
  instance.vscode.window.showWarningMessage = async () => 'Delete comparison';
  await instance.send({ type: 'historyDelete', id });
  assert.equal(instance.historyEntries.length, 0);
  await instance.send({ type: 'historySave', experiment: experiment() });
  instance.vscode.window.showWarningMessage = async () => 'Clear history';
  await instance.send({ type: 'historyClear' });
  assert.equal(instance.historyEntries.length, 0);
  assert.ok(!instance.messages.some(message => ['imported', 'historyOpened'].includes(message.type)));
});

test('finished tests auto-save even when both models fail or the panel closes', async () => {
  for (const close of [false, true]) {
    const instance = host({}, { runModel: async () => {
      if (close) instance.dispose();
      throw new Error('Provider failed');
    } });
    await instance.send({ type: 'orchestrate', experiment: { ...experiment(), comparisonMode: 'model-prompt-only', test: { repetitions: 1 },
      baseline: { provider: 'ollama', model: 'baseline' }, candidate: { provider: 'ollama', model: 'candidate' } } });
    assert.deepEqual(instance.errors, []);
    assert.equal(instance.historyEntries.length, 1);
    assert.equal(instance.historyEntries[0].experiment.testRun.status, close ? 'cancelled' : 'partial');
  }
});

test('history write failures surface explicitly without losing completed test results', async () => {
  const instance = host({}, { runModel: async input => ({ ...input, response: 'Completed response', elapsedMs: 1 }) },
    { save: async () => { throw new Error('Disk full'); } });
  await instance.send({ type: 'orchestrate', experiment: { ...experiment(), comparisonMode: 'model-prompt-only', test: { repetitions: 1 },
    baseline: { provider: 'ollama', model: 'baseline' }, candidate: { provider: 'ollama', model: 'candidate' } } });
  assert.equal(instance.messages.findLast(message => message.type === 'testFinished').experiment.testRun.status, 'completed');
  assert.match(instance.messages.findLast(message => message.type === 'historyError').message, /Disk full.*Export JSON/);
  assert.match(instance.errors[0], /history save failed/);
});

test('a newly activated extension restores an automatically saved test from disk', async t => {
  const root = await fs.promises.mkdtemp(path.join(require('node:os').tmpdir(), 'comparelab-history-host-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const { createHistory } = require('../src/history');
  const first = host({}, { runModel: async input => ({ ...input, response: '# Retained report\n\nOriginal evidence-based answer.', elapsedMs: 1 }) },
    createHistory(root));
  await first.send({ type: 'orchestrate', experiment: { ...experiment(), comparisonMode: 'model-prompt-only', test: { repetitions: 1 },
    baseline: { provider: 'ollama', model: 'baseline' }, candidate: { provider: 'ollama', model: 'candidate' } } });
  assert.deepEqual(first.errors, []);
  const original = first.messages.findLast(message => message.type === 'testFinished').experiment;
  first.dispose();
  const second = host({}, {}, createHistory(root));
  await second.send({ type: 'historyList' });
  const entries = second.messages.findLast(message => message.type === 'historyList').entries;
  assert.equal(entries.length, 1);
  second.vscode.window.showWarningMessage = async () => 'Open comparison';
  await second.send({ type: 'historyOpen', id: entries[0].id });
  assert.deepEqual(second.errors, []);
  const restored = second.messages.findLast(message => message.type === 'historyOpened').experiment;
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), JSON.parse(JSON.stringify(original)));
  await second.send({ type: 'compare', experiment: restored });
  assert.equal(second.messages.findLast(message => message.type === 'result').result.evaluation.verdict, 'tie');
  assert.equal(second.evaluations(), 0);
});

test('history tab preserves the current form, renders safe metadata, and stays browsable during runs', () => {
  const panel = webview(experiment());
  panel.click('historyTab');
  assert.equal(panel.field('compareView').hidden, true);
  assert.equal(panel.field('historyView').hidden, false);
  assert.equal(panel.field('historyTab').ariaSelected, 'true');
  assert.equal(panel.messages.at(-1).type, 'historyList');
  panel.receive({ type: 'historyList', entries: [{ id: 'saved', title: '<img src=x>', savedAt: new Date().toISOString(),
    baseline: 'first', candidate: 'second', status: 'saved', bytes: 512 }], totalBytes: 512, maxEntries: 50, maxBytes: 104857600 });
  assert.match(visibleText(panel.field('historyList')), /<img src=x>/);
  assert.ok(!descendants(panel.field('historyList')).some(node => node.tagName === 'IMG'));
  assert.match(panel.field('historyUsage').textContent, /1 \/ 50 entries/);
  panel.receive({ type: 'busy', value: true, kind: 'test' });
  assert.equal(panel.field('historyTab').disabled, false);
  assert.equal(panel.field('historyRefresh').disabled, false);
  assert.ok(descendants(panel.field('historyList')).filter(node => node.tagName === 'BUTTON').every(node => node.disabled));
  panel.receive({ type: 'busy', value: false });
  panel.field('historyTab').listeners.get('keydown')({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(panel.field('compareView').hidden, false);
  assert.equal(panel.field('promptTab').focused, true);
  panel.click('compareTab');
  assert.equal(panel.field('a-response').value, 'First answer.');
  panel.receive({ type: 'historyOpened', savedAt: new Date().toISOString(), experiment: { ...experiment(), candidate: { response: 'Saved history response' } } });
  assert.equal(panel.field('b-response').value, 'Saved history response');
  assert.equal(panel.messages.at(-1).type, 'compare');
  assert.match(panel.field('historySaveStatus').textContent, /Editing will not change/);
});

test('response cards render readable reports with unchanged raw responses and exports', async () => {
  const input = experiment();
  input.baseline.model = 'gpt-5.6-luna';
  input.candidate.model = 'gpt-6.1-sol';
  input.baseline.response = '# Findings\n\n**Errors increased.**\n\n- Inspect traces\n- Check the rollout';
  input.candidate.response = '<img src=x onerror=alert(1)>\n\n[Logs](https://example.com/logs)';
  const instance = host();
  const panel = webview(input);
  await instance.send(panel.messages.at(-1));
  panel.receive(instance.messages.findLast(message => message.type === 'result'));
  const baseline = descendants(panel.field('baselineContent'));
  assert.ok(baseline.some(node => node.tagName === 'H3' && visibleText(node).includes('Findings')));
  assert.ok(baseline.some(node => node.tagName === 'STRONG' && node.textContent === 'Errors increased.'));
  assert.equal(baseline.find(node => node.className === 'markdown-body').tabIndex, 0, 'Report scrolling is keyboard-accessible');
  assert.equal(baseline.find(node => node.tagName === 'PRE').textContent, input.baseline.response);
  assert.equal(baseline.find(node => node.tagName === 'DETAILS').open, undefined, 'Raw response is collapsed by default');
  assert.ok(!descendants(panel.field('candidateContent')).some(node => node.tagName === 'IMG'));
  assert.match(visibleText(panel.field('candidateContent')), /<img src=x onerror=alert\(1\)>/);
  assert.match(visibleText(panel.field('evaluation')), /Ready for a quality review/);
  assert.equal(panel.field('baselineResponseModel').textContent, 'gpt-5.6-luna');
  assert.equal(panel.field('candidateResponseModel').textContent, 'gpt-6.1-sol');
  assert.equal(panel.field('baselineResponseRole').textContent, 'Baseline');
  assert.equal(panel.field('candidateResponseRole').textContent, 'Candidate');
  assert.match(instance.markup, /<h3 id="baselineResponseModel"><\/h3>/);
  panel.click('export');
  assert.equal(panel.messages.at(-1).experiment.baseline.response, input.baseline.response);
  assert.equal(panel.messages.at(-1).experiment.candidate.response, input.candidate.response);
  assert.match(instance.markup, /id="baselineContent" class="response-view"/);
  assert.ok(instance.markup.indexOf('media/markdown.js') < instance.markup.indexOf('media/app.js'));
});

test('ordinary recommendations highlight only the preferred model and clear stale highlights', () => {
  const input = experiment();
  const panel = webview(input);
  const result = require('../src/core').compare(input);
  for (const verdict of ['candidate', 'baseline', 'tie', null]) {
    result.evaluation = verdict ? { verdict, summary: 'Practical recommendation.', model: { name: 'Reviewer', version: 'v1' },
      criteria: [], unknowns: [], judgments: [], inputTokenEstimates: [], note: 'Human verification required.' } : null;
    panel.receive({ type: 'result', revision: panel.messages.at(-1).revision, result });
    for (const side of ['baseline', 'candidate']) {
      assert.equal(panel.field(side + 'ResponseCard').className,
        side === verdict ? 'response-card model-preferred' : 'response-card');
      assert.equal(visibleText(panel.field(side + 'ResponseStatus')).includes('★ Preferred'), side === verdict);
    }
  }
});

test('VS Code estimates survive a model run, webview restoration, export, and history', async () => {
  const input = { ...experiment(), baseline: { provider: 'vscode', model: 'model' } };
  const instance = host({ resolveRunModels: async () => ({ a: {} }), runWithVsCode: async () => ({
    provider: 'vscode', model: 'model', prompt: input.prompt, response: 'Answer.',
    inputTokens: null, outputTokens: null, estimatedInputTokens: 321, estimatedOutputTokens: 54, elapsedMs: 20
  }) });
  const panel = webview(input);
  panel.click('a-run');
  await instance.send(panel.messages.at(-1));
  panel.receive(instance.messages.findLast(message => message.type === 'runResult'));
  assert.match(panel.field('a-status').textContent, /~321 input \/ ~54 output tokens/);
  assert.match(panel.field('a-status').textContent, /not billed usage/);
  const restored = webview(panel.state());
  restored.click('export');
  await instance.send(restored.messages.at(-1));
  const exported = JSON.parse(instance.files[0]);
  assert.equal(exported.baseline.estimatedInputTokens, 321);
  assert.equal(exported.baseline.estimatedOutputTokens, 54);
  assert.equal(exported.baseline.inputTokens ?? null, null);
  assert.equal(exported.baseline.outputTokens ?? null, null);
  restored.click('historySave');
  await instance.send(restored.messages.at(-1));
  assert.equal(instance.historyEntries[0].experiment.baseline.estimatedOutputTokens, 54);
});

test('model and prompt tabs keep independent drafts and prompt exports use exactly one shared model', () => {
  const input = { ...experiment(), baseline: { provider: 'vscode', model: 'model-a', response: 'A report' },
    candidate: { provider: 'vscode', model: 'model-b', response: 'B report' } };
  const panel = webview(input);
  assert.equal(panel.field('compareTab').ariaSelected, 'true');
  assert.equal(panel.field('sharedInstructions').hidden, false);
  assert.equal(panel.field('a-promptSection').hidden, true);
  panel.click('promptTab');
  assert.equal(panel.field('promptTab').ariaSelected, 'true');
  assert.equal(panel.field('compareView')['aria-labelledby'], 'promptTab');
  assert.equal(panel.field('sharedInstructions').hidden, true);
  assert.equal(panel.field('b-modelSettings').hidden, true);
  assert.equal(panel.field('b-runner').hidden, true);
  assert.equal(panel.field('a-promptSection').open, true);
  assert.equal(panel.field('a-prompt').value, input.prompt);
  assert.equal(panel.field('a-response').value, '');
  assert.equal(panel.field('comparisonMode').value, 'model-prompt-only');
  assert.equal(panel.field('testRepetitions').value, 1);
  assert.equal(panel.field('promptAdvanced').open, false);
  assert.equal(panel.field('promptAudit').open, false);
  assert.equal(panel.field('promptTools').hidden, false);
  panel.field('b-prompt').value = 'Alternative instructions';
  panel.field('a-model').value = 'shared-model';
  panel.click('export');
  const exported = panel.messages.at(-1).experiment;
  assert.equal(exported.comparisonKind, 'prompt');
  assert.equal(exported.candidate.model, 'shared-model');
  assert.equal(exported.baseline.model, 'shared-model');
  assert.equal(exported.candidate.prompt, 'Alternative instructions');
  assert.equal(exported.comparisonDrafts, undefined, 'Exports must not leak the other tab draft');
  panel.click('compareTab');
  assert.equal(panel.field('a-response').value, 'A report');
  assert.equal(panel.field('b-model').value, 'model-b');
  panel.click('promptTab');
  assert.equal(panel.field('b-prompt').value, 'Alternative instructions');
  const restored = webview(panel.state());
  assert.equal(restored.field('promptTab').ariaSelected, 'true');
  restored.click('compareTab');
  assert.equal(restored.field('a-model').value, 'model-a');
  assert.equal(restored.field('b-response').value, 'B report');
  assert.match(host().markup, /<details class="raw-editor"><summary>Paste \/ edit raw response/);
});

test('guided prompt drafts require explicit application, preserve original, reject stale replies and never auto-test', async () => {
  const panel = webview(experiment());
  panel.click('promptTab');
  panel.click('generatePrompt');
  const message = panel.messages.at(-1);
  assert.equal(message.type, 'generatePrompt');
  panel.receive({ type: 'optimizerDraft', revision: message.revision, draft: { prompt: 'Draft instructions', summary: 'Specific edits.', usageTurns: [] } });
  assert.equal(panel.field('b-prompt').value, experiment().prompt);
  assert.equal(panel.field('optimizerPreview').hidden, false);
  panel.field('optimizerDraft').value = 'My reviewed draft';
  panel.click('applyPromptDraft');
  assert.equal(panel.field('a-prompt').value, experiment().prompt);
  assert.equal(panel.field('b-prompt').value, 'My reviewed draft');
  assert.equal(panel.field('b-response').value, '');
  assert.equal(panel.messages.some(m => m.type === 'orchestrate'), false);
  const restored = webview(panel.state());
  assert.equal(restored.field('optimizerDraft').value, 'My reviewed draft');
  panel.field('b-prompt').value = 'Newer edit';
  panel.field('b-prompt').listeners.get('input')();
  panel.receive({ type: 'optimizerDraft', revision: message.revision, draft: { prompt: 'Stale overwrite', summary: 'Old draft' } });
  assert.equal(panel.field('b-prompt').value, 'Newer edit');
  assert.equal(panel.field('optimizerDraft').value, 'My reviewed draft');
  panel.click('compareTab');
  panel.receive({ type: 'optimizerDraft', revision: panel.messages.at(-1).revision, draft: { prompt: 'Wrong tab', summary: 'Old draft' } });
  assert.equal(panel.field('optimizerDraft').value, '');
});

test('prompt view focuses on edit evidence and only permits adoption for a Better verdict', () => {
  const { compare } = require('../src/core');
  const source = { comparisonKind: 'prompt', comparisonMode: 'model-prompt-only',
    baseline: { provider: 'vscode', model: 'shared', prompt: 'Original instructions', response: 'Original output' },
    candidate: { provider: 'vscode', model: 'shared', prompt: 'Edited instructions', response: 'Edited output' } };
  for (const verdict of ['Better', 'Worse', 'No clear improvement']) {
    const panel = webview(source);
    const result = compare(source);
    result.evaluation = { verdict: 'candidate', summary: 'Reviewed output evidence.', model: { name: 'Reviewer' },
      criteria: [], unknowns: [], judgments: [], inputTokenEstimates: [] };
    result.promptDecision = { verdict, action: verdict === 'Better' ? 'Use edited prompt' : 'Keep original',
      reason: 'Test-specific conclusion', caveat: 'Verify on other inputs', changes: [{ change: 'Changed instructions', effect: 'uncertain',
        impact: 'Observed difference', recommendation: 'Keep the required constraints',
        citations: [{ source: 'candidateTask', quote: 'Edited instructions' }] }] };
    panel.receive({ type: 'result', revision: panel.messages.at(-1).revision, result });
    assert.equal(panel.field('promptResults').hidden, false);
    assert.equal(panel.field('promptAudit').open, false);
    assert.match(visibleText(panel.field('promptDiff')), /Edited/);
    assert.match(visibleText(panel.field('promptResults')), /Keep the required constraints/);
    const adopt = descendants(panel.field('promptResults')).find(node => node.id === 'adoptPrompt');
    assert.equal(adopt.disabled, verdict !== 'Better');
    adopt.listeners.get('click')();
    assert.equal(panel.field('a-prompt').value, verdict === 'Better' ? 'Edited instructions' : 'Original instructions');
    if (verdict === 'Better') {
      assert.equal(panel.field('a-response').value, '');
      assert.equal(panel.field('b-response').value, '');
      assert.ok(!panel.messages.some(message => message.type === 'orchestrate'));
    }
  }
});

test('prompt comparison has one primary review action and hides legacy model actions even with settings expanded', () => {
  const panel = webview(experiment());
  panel.click('promptTab');
  panel.field('promptAdvanced').open = true;
  for (const id of ['runBoth', 'compare', 'orchestrate', 'chat', 'evaluate', 'a-run']) {
    assert.equal(panel.field(id).hidden, true, id + ' is not part of the prompt workflow');
  }
  panel.click('promptTest');
  assert.equal(panel.messages.at(-1).type, 'orchestrate');
  panel.click('compareTab');
  for (const id of ['runBoth', 'compare', 'orchestrate', 'chat', 'evaluate', 'a-run']) {
    assert.equal(panel.field(id).hidden, false, id + ' remains available for model comparison');
  }
  assert.equal(panel.field('promptReviewOutputs').hidden, true);
  assert.match(host().markup, />Review prompt change<\/button>/);
});

test('prompt diff groups word edits into readable before/after passages with a collapsed full diff', () => {
  const { compare } = require('../src/core');
  for (const edited of ['Keep shared context. Verify facts. Preserve output.', 'Keep shared context. Guess facts. Preserve output.']) {
    const source = { comparisonKind: 'prompt',
      baseline: { prompt: 'Keep shared context. Guess facts. Preserve output.' }, candidate: { prompt: edited } };
    const panel = webview(source);
    panel.receive({ type: 'result', revision: panel.messages.at(-1).revision, result: compare(source) });
    const container = panel.field('promptDiff');
    const passages = container.children.filter(node => node.className === 'change-passage');
    const full = container.children.find(node => node.tagName === 'DETAILS');
    if (edited.includes('Verify')) {
      assert.equal(passages.length, 1);
      const versions = descendants(passages[0]).filter(node => node.className === 'change-version');
      assert.equal(versions.length, 2);
      assert.match(visibleText(versions[0]), /Original.*Keep shared context\..*Guess.*facts\. Preserve output\./);
      assert.doesNotMatch(visibleText(versions[0]), /Verify/);
      assert.match(visibleText(versions[1]), /Edited.*Keep shared context\..*Verify.*facts\. Preserve output\./);
      assert.doesNotMatch(visibleText(versions[1]), /Guess/);
      assert.equal(descendants(versions[0]).find(node => node.className === 'remove').textContent, 'Guess');
      assert.equal(descendants(versions[1]).find(node => node.className === 'add').textContent, 'Verify');
      assert.ok(!full.open);
      assert.match(visibleText(full), /shared context/);
      assert.match(visibleText(full), /Show full prompt diff/);
    } else {
      assert.equal(visibleText(container).trim(), 'No changes.');
      assert.equal(full, undefined);
    }
    panel.click('export');
    assert.equal(panel.messages.at(-1).experiment.candidate.prompt, edited);
  }
});

test('prompt review clearly reports running, completed and failed review states and reveals the final result', async () => {
  for (const fail of [false, true]) {
    const instance = host(fail ? { evaluateWithCopilot: async () => { throw new Error('Reviewer context limit exceeded'); } } : {},
      { runModel: async request => ({ ...request, response: request.prompt.includes('Original') ? 'Original output' : 'Edited output' }) });
    const source = { comparisonKind: 'prompt', comparisonMode: 'model-prompt-only', evidence: 'Shared facts',
      baseline: { provider: 'ollama', model: 'shared', prompt: 'Original instructions' },
      candidate: { provider: 'ollama', model: 'shared', prompt: 'Edited instructions' }, test: { repetitions: 1 } };
    const panel = webview(source);
    await instance.send({ type: 'orchestrate', experiment: source });
    panel.receive({ type: 'busy', value: true, kind: 'test' });
    const updates = instance.messages.filter(message => message.type === 'testUpdate');
    const reviewing = updates.find(message => message.record.pairs.some(pair => pair.evaluationStatus === 'running'));
    panel.receive(reviewing);
    assert.match(panel.field('reviewProgressTitle').textContent, /Reviewing both outputs/);
    assert.match(visibleText(panel.field('reviewSteps')), /Shared evidence/);
    assert.equal(panel.field('reviewProgress').hidden, false);
    panel.receive(instance.messages.findLast(message => message.type === 'testFinished'));
    await instance.send(panel.messages.at(-1));
    panel.receive(instance.messages.findLast(message => message.type === 'result'));
    const headings = descendants(panel.field('promptResults')).filter(node => node.tagName === 'H2').map(node => node.textContent);
    assert.deepEqual(headings, [fail ? 'Not reviewed' : 'No clear improvement']);
    const text = visibleText(panel.field('promptResults'));
    assert.match(text, fail ? /0 \/ 1 output pairs reviewed/ : /REVIEW COMPLETE/);
    if (fail) assert.match(text, /Reviewer context limit exceeded/);
    assert.equal(panel.field('promptResults').focused, true);
    assert.equal(panel.field('promptResults').scrolledIntoView, true);
    const status = instance.messages.findLast(message => message.type === 'reviewStatus').message;
    assert.match(status, fail ? /Review incomplete: 0 of 1/ : /Review complete/);
  }
});

test('prompt review exposes preparation and live evidence progress beside the action, with elapsed time and cancellation', () => {
  const panel = webview({ comparisonKind: 'prompt', comparisonMode: 'model-prompt-only',
    baseline: { prompt: 'Original' }, candidate: { prompt: 'Edited' } });
  panel.receive({ type: 'busy', value: true, kind: 'test' });
  assert.equal(panel.field('reviewProgress').hidden, false);
  assert.equal(panel.field('reviewProgress')['aria-busy'], 'true');
  assert.ok(panel.field('promptProgressSlot').children.includes(panel.field('reviewProgress')));
  assert.ok(panel.field('progressCancelSlot').children.includes(panel.field('cancelReview')));
  assert.equal(panel.field('promptTest').textContent, 'Review in progress...');
  assert.equal(panel.field('cancelReview').disabled, false);
  assert.equal(panel.field('cancelReview').hidden, false);
  assert.match(panel.field('reviewProgressTitle').textContent, /Preparing/);
  assert.match(panel.field('reviewProgressDetail').textContent, /Choose a model/);
  assert.match(visibleText(panel.field('reviewSteps')), /Collect evidence/);
  panel.advanceTime(65000);
  assert.equal(panel.field('reviewElapsed').textContent, '1:05 elapsed');
  panel.receive({ type: 'reviewStatus', phase: 'evidence', message: 'Shared evidence: model request 8 | Tool calls: 43' });
  assert.equal(panel.field('reviewProgressTitle').textContent, 'Collecting shared tool evidence');
  assert.match(panel.field('reviewProgressDetail').textContent, /Tool calls: 43/);
  assert.equal(panel.field('reviewSteps').children[0]['data-state'], 'complete');
  assert.equal(panel.field('reviewSteps').children[1]['aria-current'], 'step');
  panel.click('cancelReview');
  assert.equal(panel.messages.at(-1).type, 'cancelReview');
  assert.equal(panel.field('cancelReview').disabled, true);
  assert.equal(panel.field('reviewProgressTitle').textContent, 'Cancelling review...');
  panel.receive({ type: 'reviewStatus', message: 'Shared evidence collection cancelled. Neither prompt was tested.' });
  panel.receive({ type: 'busy', value: false });
  assert.equal(panel.field('reviewProgress').hidden, true);
  assert.equal(panel.field('reviewProgress')['aria-busy'], 'false');
  assert.equal(panel.field('reviewStatus').hidden, false);
  assert.match(panel.field('reviewStatus').textContent, /cancelled/);
  assert.equal(panel.field('promptTest').textContent, 'Review prompt change');
  assert.equal(panel.timerCount(), 0);
});

test('shared evidence, original, edited and review stages reflect actual run transitions, without changing model-mode controls', async () => {
  const instance = host({}, { runModel: async request => ({ ...request, response: 'Output' }) });
  const source = { comparisonKind: 'prompt', comparisonMode: 'model-prompt-only', evidence: 'Shared facts',
    baseline: { provider: 'ollama', model: 'shared', prompt: 'Original' },
    candidate: { provider: 'ollama', model: 'shared', prompt: 'Edited' }, test: { repetitions: 1 } };
  await instance.send({ type: 'orchestrate', experiment: source });
  const panel = webview(source);
  panel.receive({ type: 'busy', value: true, kind: 'test' });
  for (const [status, title] of [['baseline', 'Running original prompt'], ['candidate', 'Running edited prompt'], ['evaluationStatus', 'Reviewing both outputs']]) {
    const update = instance.messages.find(message => message.type === 'testUpdate' &&
      message.record.pairs.some(pair => status === 'evaluationStatus' ? pair[status] === 'running' : pair[status].status === 'running'));
    assert.ok(update);
    panel.receive(update);
    assert.match(panel.field('reviewProgressTitle').textContent, new RegExp(title + ' · Run 1 of 1'));
    assert.match(visibleText(panel.field('reviewSteps')), /Shared evidence/);
  }
  const reversed = structuredClone(instance.messages.find(message => message.type === 'testUpdate' &&
    message.record.pairs.some(pair => pair.baseline.status === 'running')));
  reversed.record.pairs[0].baseline.status = 'not-started';
  reversed.record.pairs[0].candidate.status = 'running';
  panel.receive(reversed);
  assert.equal(panel.field('reviewSteps').children[2]['data-state'], 'pending', 'An edited-first run must not claim the original is done');
  assert.equal(panel.field('reviewSteps').children[3]['data-state'], 'active');
  panel.receive({ type: 'reviewStatus', message: 'Review complete.' });
  panel.receive({ type: 'busy', value: false });
  assert.equal(panel.field('reviewStatus').textContent, 'Review complete.');
  assert.equal(panel.timerCount(), 0);
  const model = webview(experiment());
  model.receive({ type: 'busy', value: true, kind: 'test' });
  assert.equal(model.field('reviewProgress').hidden, true);
  assert.equal(model.field('cancelReview').hidden, false);
  assert.equal(model.timerCount(), 0);
});

test('rewriting uses a selected model without tools, and errors/cancellation leave prompt drafts unchanged', async () => {
  const requests = [];
  const instance = host({ selectRunModel: async () => ({ id: 'writer' }),
    runWithVsCode: async (api, request, model, token, options) => {
      requests.push({ request, options });
      return { model: model.id, response: JSON.stringify({ prompt: 'Edited draft', summary: 'Adds evidence grounding.' }), usageTurns: [] };
    } });
  const source = { ...experiment(), comparisonKind: 'prompt', baseline: { prompt: 'Original' }, candidate: { prompt: 'Edited' } };
  await instance.send({ type: 'generatePrompt', experiment: source, revision: 42, guidance: { goal: 'Ground findings' } });
  assert.deepEqual(instance.errors, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options, undefined);
  assert.equal(instance.evaluations(), 0);
  assert.equal(instance.historyEntries.length, 0);
  const draft = instance.messages.find(message => message.type === 'optimizerDraft');
  assert.equal(draft.revision, 42);
  assert.equal(draft.draft.prompt, 'Edited draft');
  assert.equal(source.baseline.prompt, 'Original');
  assert.ok(instance.messages.some(message => message.type === 'busy' && message.kind === 'optimizer'));
  const failed = host({ selectRunModel: async () => ({ id: 'writer' }),
    runWithVsCode: async () => { throw new Error('Writer unavailable'); } });
  await failed.send({ type: 'generatePrompt', experiment: source });
  assert.match(failed.messages.find(m => m.type === 'optimizerStatus').message, /Writer unavailable/);
  assert.ok(!failed.messages.some(m => m.type === 'optimizerDraft'));
  const cancelled = host({ selectRunModel: async () => undefined });
  await cancelled.send({ type: 'generatePrompt', experiment: source });
  assert.match(cancelled.messages.find(m => m.type === 'optimizerStatus').message, /cancelled/);
});

test('shared-evidence prompt tests collect once and replay exact raw results without tools to either variant', async () => {
  const requests = [];
  const requirements = [];
  const instance = host({
    resolveRunModels: async (api, variants, options) => {
      requirements.push(options.requireTools);
      return { baseline: { id: 'shared' }, candidate: { id: 'shared' } };
    },
    runWithVsCode: async (api, request, model, token, options) => {
      requests.push({ request, options });
      if (options?.tools) {
        return { ...request, model: 'shared', elapsedMs: 1, inputTokens: 10, outputTokens: 2,
          ...(options.conversation.some(m => m.role === 'tool') ? { response: 'Snapshot collected.' }
            : { toolCalls: [{ callId: 'snapshot', name: 'search_datadog_logs', input: { query: 'example' } }] }) };
      }
      assert.match(request.prompt, /RAW_SNAPSHOT_401/);
      assert.match(request.prompt, /No live tools are available/);
      assert.equal(options.tokenAwareInput, true);
      return { ...request, response: 'Output for ' + (request.prompt.includes('Original instructions') ? 'original' : 'edited'),
        elapsedMs: 1, inputTokens: 7, outputTokens: 3, usageTurns: [{ model: 'shared', inputTokens: 7, outputTokens: 3 }] };
    }
  });
  class LanguageModelTextPart { constructor(value) { this.value = value; } }
  instance.vscode.LanguageModelTextPart = LanguageModelTextPart;
  let toolCalls = 0;
  let approvals = 0;
  instance.vscode.lm = {
    tools: [{ name: 'search_datadog_logs', inputSchema: { type: 'object' } }],
    invokeTool: async () => { toolCalls++; return { content: [new LanguageModelTextPart('RAW_SNAPSHOT_401')] }; }
  };
  instance.vscode.window.showWarningMessage = async () => { approvals++; return 'Allow request'; };
  const source = { prompt: '', incomingMessage: 'Investigate service:example', comparisonKind: 'prompt', comparisonMode: 'model-prompt-only',
    evidence: '', baseline: { provider: 'vscode', model: 'shared', prompt: 'Original instructions' },
    candidate: { provider: 'vscode', model: 'shared', prompt: 'Edited instructions' }, test: { repetitions: 2 } };
  await instance.send({ type: 'orchestrate', experiment: source });
  assert.deepEqual(instance.errors, []);
  assert.equal(toolCalls, 1);
  assert.equal(approvals, 1);
  assert.equal(requests.filter(r => r.options?.tools).length, 2);
  assert.equal(requests.filter(r => !r.options?.tools).length, 4);
  const completed = instance.messages.findLast(m => m.type === 'testFinished').experiment;
  assert.equal(completed.comparisonMode, 'model-prompt-only');
  assert.equal(completed.evidenceCollection.modelRequestCount, 2);
  assert.equal(completed.evidenceCollection.toolCallCount, 1);
  assert.equal(completed.testRun.status, 'completed');
  const { summarizeTest, validateTestRecord } = require('../src/orchestration');
  const summary = summarizeTest(completed.testRun);
  assert.equal(summary.metrics.baseline.inputTokens, 14);
  assert.equal(summary.metrics.candidate.inputTokens, 14);
  assert.equal(summary.metrics.baseline.toolCallCount, 0);
  assert.equal(summary.metrics.candidate.toolCallCount, 0);
  assert.deepEqual(validateTestRecord(completed.testRun), completed.testRun);
  assert.equal(instance.historyEntries[0].experiment.evidenceCollection.toolCallCount, 1);
  await instance.send({ type: 'orchestrate', experiment: completed });
  assert.deepEqual(instance.errors, []);
  assert.deepEqual(requirements, [true, false]);
  assert.equal(toolCalls, 1, 'Replaying a saved snapshot must not query Datadog again');
  assert.equal(approvals, 1);
  const panel = webview(completed);
  panel.field('b-prompt').value = 'Another edit';
  panel.field('b-prompt').listeners.get('input')();
  assert.equal(panel.state().evidence, completed.evidence, 'Prompt edits reuse the frozen snapshot');
  panel.field('incomingMessage').value = 'A different alert';
  panel.field('incomingMessage').listeners.get('input')();
  assert.equal(panel.state().evidence, '', 'A new alert must not reuse the previous collected snapshot');
  assert.equal(panel.state().evidenceCollection, undefined);
  panel.click('promptFreshEvidence');
  assert.equal(panel.messages.at(-1).type, 'orchestrate');
  assert.equal(panel.messages.at(-1).experiment.evidence, '');
});

test('shared evidence collection errors and cancellation do not start either prompt', async () => {
  const source = { comparisonKind: 'prompt', comparisonMode: 'model-prompt-only', incomingMessage: 'Example alert',
    baseline: { provider: 'vscode', model: 'shared', prompt: 'Original' },
    candidate: { provider: 'vscode', model: 'shared', prompt: 'Edited' } };
  for (const cancel of [false, true]) {
    let runs = 0;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const instance = host({ resolveRunModels: async () => ({ baseline: {}, candidate: {} }),
      runWithVsCode: async (api, request, model, token, options) => {
        runs++;
        assert.ok(options.tools);
        started();
        if (!cancel) throw new Error('Datadog authentication failed');
        return new Promise((resolve, reject) => token.onCancellationRequested(() => reject(new api.CancellationError())));
      } });
    instance.vscode.lm = { tools: [{ name: 'search_datadog_logs' }], invokeTool: async () => { throw new Error('Must not execute'); } };
    instance.vscode.window.showWarningMessage = async () => 'Allow request';
    const running = instance.send({ type: 'orchestrate', experiment: source });
    await ready;
    if (cancel) await instance.send({ type: 'cancelReview' });
    await running;
    assert.equal(runs, 1);
    assert.equal(instance.evaluations(), 0);
    assert.equal(instance.messages.some(m => m.type === 'testFinished'), false);
    if (cancel) {
      assert.deepEqual(instance.errors, []);
      assert.match(instance.messages.findLast(m => m.type === 'reviewStatus').message, /Neither prompt was tested/);
    } else assert.match(instance.errors[0], /authentication failed/);
    assert.equal(instance.messages.at(-1).type === 'busy' ? instance.messages.at(-1).value : false, false);
  }
});

test('identical prompts and missing shared collection input fail before any model calls', async () => {
  let calls = 0;
  const instance = host({ resolveRunModels: async () => { calls++; } });
  const source = { comparisonKind: 'prompt', comparisonMode: 'model-prompt-only',
    baseline: { provider: 'vscode', model: 'shared', prompt: 'Same' }, candidate: { provider: 'vscode', model: 'shared', prompt: 'Same' } };
  await instance.send({ type: 'orchestrate', experiment: source });
  assert.match(instance.errors[0], /Identical prompts/);
  source.candidate.prompt = 'Different';
  await instance.send({ type: 'orchestrate', experiment: source });
  assert.match(instance.errors[1], /shared input/);
  assert.equal(calls, 0);
});

test('prompt-tab agent loading targets only the requested variant and tabs cannot change comparison type during a run', async () => {
  const panel = webview(experiment());
  panel.click('promptTab');
  panel.click('b-loadInstructions');
  assert.equal(panel.messages.at(-1).side, 'b');
  const instance = host();
  instance.vscode.window.showOpenDialog = async () => ['variant.md'];
  instance.vscode.workspace.fs.readFile = async () => Buffer.from('Candidate instructions');
  await instance.send(panel.messages.at(-1));
  panel.receive(instance.messages.at(-1));
  assert.equal(panel.field('b-prompt').value, 'Candidate instructions');
  assert.equal(panel.field('a-prompt').value, experiment().prompt);
  panel.receive({ type: 'busy', value: true, kind: 'test' });
  assert.equal(panel.field('compareTab').disabled, true);
  panel.click('compareTab');
  assert.equal(panel.field('promptTab').ariaSelected, 'true');
  panel.click('historyTab');
  panel.click('promptTab');
  assert.equal(panel.field('compareView').hidden, false);
});

test('editing a prompt keeps the selected shared model vendor rather than resolving an ambiguous model ID', () => {
  const panel = webview(experiment());
  panel.click('promptTab');
  panel.receive({ type: 'modelSelected', side: 'a', model: { id: 'shared-model', vendor: 'provider-one' } });
  panel.field('a-prompt').value = 'Edited baseline instructions';
  panel.field('a-prompt').listeners.get('input')();
  panel.click('export');
  const input = panel.messages.at(-1).experiment;
  assert.equal(input.baseline.modelVendor, 'provider-one');
  assert.equal(input.candidate.modelVendor, 'provider-one');
});

test('HTML export saves one offline report with bundled styling without calling models', async () => {
  const instance = host();
  instance.vscode.workspace.fs.readFile = async uri => fs.readFileSync(path.join(__dirname, '../media', path.basename(uri)));
  const panel = webview(experiment());
  panel.click('htmlReport');
  await instance.send(panel.messages.at(-1));
  assert.deepEqual(instance.errors, []);
  assert.equal(instance.files.length, 1);
  assert.match(instance.files[0], /<!doctype html>/);
  assert.match(instance.files[0], /Offline assessment report/);
  assert.match(instance.files[0], /First answer\./);
  assert.match(instance.files[0], /Second answer\./);
  assert.match(instance.files[0], /Content-Security-Policy/);
  assert.doesNotMatch(instance.files[0], /<script[^>]+src=|<link[^>]+href=/);
  assert.equal(instance.evaluations(), 0);
});

test('formatted preview limits do not truncate raw responses or exported content', async () => {
  const input = experiment();
  input.candidate.response = 'x'.repeat(100000) + 'RAW_TAIL';
  const instance = host();
  const panel = webview(input);
  await instance.send(panel.messages.at(-1));
  panel.receive(instance.messages.findLast(message => message.type === 'result'));
  const content = descendants(panel.field('candidateContent'));
  const preview = content.find(node => node.className === 'markdown-body');
  assert.doesNotMatch(visibleText(preview), /RAW_TAIL/);
  assert.match(visibleText(preview), /preview shortened/);
  assert.equal(content.find(node => node.tagName === 'PRE').textContent, input.candidate.response);
  panel.click('export');
  assert.equal(panel.messages.at(-1).experiment.candidate.response, input.candidate.response);
});

test('partial test views show failed responses honestly and preserve expanded run details during updates', async () => {
  const instance = host({}, { runModel: async input => {
    if (input.model === 'baseline') throw new Error('The baseline provider is unavailable.');
    return { ...input, response: '## Finding\n\nCandidate report is available.', elapsedMs: 1000 };
  } });
  await instance.send({ type: 'orchestrate', experiment: { ...experiment(), comparisonMode: 'model-prompt-only', test: { repetitions: 1 },
    baseline: { provider: 'ollama', model: 'baseline' }, candidate: { provider: 'ollama', model: 'candidate' } } });
  assert.deepEqual(instance.errors, []);
  const completed = instance.messages.findLast(message => message.type === 'testFinished').experiment;
  const panel = webview(completed);
  await instance.send(panel.messages.at(-1));
  panel.receive(instance.messages.findLast(message => message.type === 'result'));
  assert.match(visibleText(panel.field('testResults')), /No completed comparison yet/);
  assert.match(visibleText(panel.field('baselineContent')), /No response available/);
  assert.match(visibleText(panel.field('baselineContent')), /baseline provider is unavailable/);
  assert.match(visibleText(panel.field('candidateContent')), /Candidate report is available/);
  assert.match(visibleText(panel.field('evaluation')), /No quality review available/);
  const run = descendants(panel.field('testResults')).find(node => node.className === 'run-card');
  assert.equal(run.open, false);
  run.open = true;
  run.listeners.get('toggle')();
  const raw = descendants(run).find(node => node.className === 'raw-response');
  raw.open = true;
  raw.listeners.get('toggle')();
  panel.receive({ type: 'testUpdate', record: completed.testRun, message: 'Progress update' });
  assert.equal(descendants(panel.field('testResults')).find(node => node.className === 'run-card').open, true);
  assert.equal(descendants(panel.field('testResults')).find(node => node.className === 'raw-response').open, true);
  const next = structuredClone(completed.testRun);
  next.id += '-new';
  panel.receive({ type: 'testUpdate', record: next, message: 'Next test' });
  assert.equal(descendants(panel.field('testResults')).find(node => node.className === 'run-card').open, false);
  next.status = 'running';
  next.pairs[0].baseline = { status: 'running' };
  panel.receive({ type: 'testUpdate', record: next, message: 'Running' });
  assert.match(visibleText(panel.field('testResults')), /Investigations in progress/);
  next.status = 'cancelled';
  next.pairs[0].baseline = { status: 'cancelled', error: 'Cancelled by user.' };
  panel.receive({ type: 'testUpdate', record: next, message: 'Cancelled' });
  assert.match(visibleText(panel.field('testResults')), /Cancelled/);
});

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

test('prompt orchestration restores the prompt tab and both original variants through history and export', async () => {
  const calls = [];
  const instance = host({}, { runModel: async request => {
    calls.push(request);
    return { ...request, response: request.prompt.includes('Candidate variant') ? 'Candidate answer.' : 'Baseline answer.' };
  } });
  const input = { prompt: '', incomingMessage: 'Alert', evidence: '401 increased.', comparisonKind: 'prompt',
    test: { repetitions: 1 }, baseline: { provider: 'ollama', model: 'shared', prompt: 'Baseline variant {{alert}}' },
    candidate: { provider: 'ollama', model: 'shared', prompt: 'Candidate variant {{alert}}' } };
  await instance.send({ type: 'orchestrate', experiment: input });
  assert.deepEqual(instance.errors, []);
  assert.equal(calls.length, 2);
  assert.match(calls[0].prompt, /Baseline variant Alert/);
  assert.match(calls[1].prompt, /Candidate variant Alert/);
  const completed = instance.messages.findLast(message => message.type === 'testFinished').experiment;
  assert.equal(completed.comparisonKind, 'prompt');
  assert.equal(completed.baseline.prompt, input.baseline.prompt);
  assert.equal(completed.candidate.prompt, input.candidate.prompt);
  const panel = webview(completed);
  assert.equal(panel.field('promptTab').ariaSelected, 'true');
  assert.equal(panel.field('b-prompt').value, input.candidate.prompt);
  await instance.send(panel.messages.at(-1));
  assert.ok(instance.messages.findLast(message => message.type === 'result').result.testRun);
  assert.equal(instance.historyEntries[0].experiment.comparisonKind, 'prompt');
  panel.click('export');
  await instance.send(panel.messages.at(-1));
  const exported = JSON.parse(instance.files[0]);
  assert.equal(exported.comparisonKind, 'prompt');
  await instance.send({ type: 'compare', experiment: exported });
  assert.deepEqual(instance.errors, []);
  assert.ok(instance.messages.findLast(message => message.type === 'result').result.testRun);
});

test('prompt drafts save and reopen from history without responses, reviews or model requests', async () => {
  const instance = host();
  const input = { comparisonKind: 'prompt', comparisonMode: 'model-prompt-only', incomingMessage: 'Example input',
    evidence: 'Frozen observations', baseline: { provider: 'vscode', model: 'shared', prompt: 'Original instructions' },
    candidate: { provider: 'vscode', model: 'shared', prompt: 'Edited instructions' },
    optimizer: { goal: 'Clearer instructions', draft: { prompt: 'Reviewed draft', summary: 'Keeps constraints.', usageTurns: [] } } };
  const panel = webview(input);
  assert.equal(panel.field('historySave').textContent, 'Save prompt comparison to History');
  panel.click('historySave');
  await instance.send(panel.messages.at(-1));
  assert.deepEqual(instance.errors, []);
  assert.equal(instance.historyEntries.length, 1);
  assert.equal(instance.historyEntries[0].evaluation, null);
  assert.match(instance.messages.find(m => m.type === 'historySaved').message, /Prompt draft saved.*No review/);
  instance.vscode.window.showWarningMessage = async () => 'Open comparison';
  await instance.send({ type: 'historyOpen', id: instance.historyEntries[0].id });
  const restored = webview(experiment());
  restored.receive(instance.messages.findLast(m => m.type === 'historyOpened'));
  await instance.send(restored.messages.at(-1));
  restored.receive(instance.messages.findLast(m => m.type === 'result'));
  assert.equal(restored.field('promptTab').ariaSelected, 'true');
  assert.equal(restored.field('b-prompt').value, input.candidate.prompt);
  assert.equal(restored.field('evidence').value, input.evidence);
  assert.equal(restored.field('optimizerDraft').value, 'Reviewed draft');
  assert.equal(instance.evaluations(), 0);
  restored.field('b-prompt').value = 'New edit';
  restored.field('b-prompt').listeners.get('input')();
  restored.click('historySave');
  await instance.send(restored.messages.at(-1));
  assert.equal(instance.historyEntries.length, 2);
  assert.equal(instance.historyEntries[0].experiment.candidate.prompt, input.candidate.prompt);
  assert.equal(instance.historyEntries[1].experiment.candidate.prompt, 'New edit');
  await instance.send({ type: 'historySave', experiment: { comparisonKind: 'prompt', baseline: {}, candidate: {} } });
  assert.match(instance.errors.at(-1), /Enter an original or edited prompt/);
  assert.equal(instance.historyEntries.length, 2);
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
  assert.match(sent.prompt, /^Analyze this alert event:/);
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

test('end-to-end orchestration gives both models the same selected multi-provider tools without pasted evidence', async () => {
  const inputs = [];
  const instance = host({ evaluateWithCopilot: async (api, input) => {
    inputs.push(input);
    return { inputFingerprint: evaluationKey(input), verdict: 'tie', summary: 'Both used selected tools.', criteria: [],
      unknowns: [], judgments: [], inputTokenEstimates: [], model: { id: 'reviewer' } };
  } });
  class LanguageModelTextPart { constructor(value) { this.value = value; } }
  class LanguageModelThinkingPart { constructor(value) { this.value = value; } }
  class LanguageModelToolCallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
  class LanguageModelToolResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
  Object.assign(instance.vscode, { LanguageModelTextPart, LanguageModelThinkingPart, LanguageModelToolCallPart, LanguageModelToolResultPart,
    LanguageModelChatMessage: { User: content => ({ role: 'user', content }), Assistant: content => ({ role: 'assistant', content }) } });
  const requests = [];
  const models = ['baseline-model', 'candidate-model'].map(id => ({
    id, name: id, vendor: 'copilot', version: 'v1', maxInputTokens: 10000, countTokens: async () => 50,
    sendRequest: async (messages, options) => {
      requests.push({ id, messages: structuredClone(messages), options });
      const hasResults = messages.some(message => Array.isArray(message.content) && message.content.some(part => part instanceof LanguageModelToolResultPart));
      return { stream: (async function* () {
        yield new LanguageModelThinkingPart('Internal reasoning, not evidence.');
        if (hasResults) yield new LanguageModelTextPart(id + ' final answer');
        else yield new LanguageModelToolCallPart(id + '-call', 'mcp_github_search_issues', { query: id });
      })() };
    }
  }));
  const toolCalls = [];
  instance.vscode.lm = { selectChatModels: async () => models,
    tools: [{ name: 'mcp_github_search_issues', description: 'Search issues', inputSchema: { type: 'object' } },
      { name: 'workspace_read_file', description: 'Read file', inputSchema: { type: 'object' } },
      { name: 'unselected_write_tool', description: 'Write', inputSchema: { type: 'object' } }],
    invokeTool: async (name, { input }) => {
      toolCalls.push(input.query);
      return { content: [new LanguageModelTextPart(input.query + ' observed 401')] };
    } };
  instance.vscode.window.showQuickPick = async items => items.slice(0, 2);
  let approvals = 0;
  instance.vscode.window.showWarningMessage = async () => { approvals++; return 'Allow request'; };
  await instance.send({ type: 'orchestrate', experiment: { ...experiment(), evidence: '', comparisonMode: 'end-to-end', test: { repetitions: 1 },
    baseline: { provider: 'vscode', model: 'baseline-model' }, candidate: { provider: 'vscode', model: 'candidate-model' } } });
  assert.deepEqual(instance.errors, []);
  assert.deepEqual(toolCalls, ['baseline-model', 'candidate-model']);
  assert.equal(requests.length, 4);
  assert.equal(requests[0].messages.length, requests[2].messages.length);
  assert.equal(requests[2].messages.some(message => JSON.stringify(message).includes('baseline-model observed')), false);
  assert.deepEqual(requests[0].options.tools.map(tool => tool.name), ['mcp_github_search_issues', 'workspace_read_file']);
  assert.deepEqual(requests[0].options.tools, requests[2].options.tools);
  assert.equal(approvals, 2);
  assert.match(inputs[0].evidence, /baseline-model observed 401/);
  assert.match(inputs[0].evidence, /candidate-model observed 401/);
  const completed = instance.messages.findLast(message => message.type === 'testFinished').experiment;
  assert.equal(completed.testRun.status, 'completed');
  assert.equal(completed.evidence, '');
  assert.equal(completed.comparisonMode, 'end-to-end');
  assert.deepEqual(completed.toolSelection, ['mcp_github_search_issues', 'workspace_read_file']);
  assert.deepEqual(completed.testRun.plan.toolCatalog.map(tool => tool.name), completed.toolSelection);
  await instance.send({ type: 'compare', experiment: completed });
  const result = instance.messages.findLast(message => message.type === 'result').result;
  assert.ok(result.testRun);
  assert.equal(result.evaluation.summary, 'Both used selected tools.');
  assert.equal(result.testSummary.preference, 'inconclusive');
  assert.match(result.evidence, /candidate-model observed 401/);
  await instance.send({ type: 'export', experiment: completed });
  const exported = JSON.parse(instance.files[0]);
  assert.equal(exported.testRun.pairs[0].baseline.result.toolEvidence[0].input.query, 'baseline-model');
  await instance.send({ type: 'report', experiment: exported });
  assert.match(instance.files[1], /baseline-model observed 401/);
});

test('end-to-end orchestration reports missing Datadog tools before generation', async () => {
  let calls = 0;
  const instance = host({}, { runModel: async () => { calls++; } });
  await instance.send({ type: 'orchestrate', experiment: { ...experiment(), evidence: '', comparisonMode: 'end-to-end',
    baseline: { provider: 'ollama', model: 'baseline' }, candidate: { provider: 'ollama', model: 'candidate' } } });
  assert.match(instance.errors[0], /No VS Code tools/);
  assert.equal(calls, 0);
  assert.equal(instance.messages.findLast(message => message.type === 'busy').value, false);
});

test('unsupported model capabilities and declined test consent stop before any generation', async () => {
  let calls = 0;
  const model = { id: 'no-tools', capabilities: { supportsToolCalling: false }, sendRequest: async () => { calls++; } };
  const instance = host();
  instance.vscode.lm = { selectChatModels: async () => [model] };
  const input = { ...experiment(), evidence: '', comparisonMode: 'end-to-end',
    baseline: { provider: 'vscode', model: model.id }, candidate: { provider: 'vscode', model: model.id } };
  await instance.send({ type: 'orchestrate', experiment: input });
  assert.match(instance.errors[0], /baseline.*does not support tool calling/);
  assert.equal(instance.messages.findLast(message => message.type === 'busy').value, false);
  model.capabilities.supportsToolCalling = true;
  instance.vscode.lm.tools = [{ name: 'datadog-search_datadog_logs', inputSchema: { type: 'object' } }];
  instance.vscode.lm.invokeTool = async () => { throw new Error('Must not call Datadog'); };
  instance.vscode.window.showWarningMessage = async () => undefined;
  instance.vscode.window.showQuickPick = async () => undefined;
  await instance.send({ type: 'orchestrate', experiment: input });
  assert.equal(instance.messages.some(message => message.type === 'testFinished'), false);
  assert.equal(calls, 0);
  assert.equal(instance.errors.length, 1);
  assert.equal(instance.messages.findLast(message => message.type === 'busy').value, false);
});

test('endpoint-backed investigations use Datadog and denied requests stop the test', async () => {
  for (const approve of [true, false]) {
    let turns = 0;
    let invocations = 0;
    const instance = host({}, { runModel: async (input, { conversation, tools, signal }) => {
      turns++;
      assert.equal(signal.aborted, false);
      assert.deepEqual(tools.map(tool => tool.name), ['datadog-search_datadog_logs']);
      return !conversation.some(message => message.role === 'tool')
        ? { ...input, response: '', toolCalls: [{ callId: 'call-1', name: tools[0].name, input: { query: input.model } }] }
        : { ...input, response: input.model + ' answer', inputTokens: 10, outputTokens: 5 };
    } });
    class LanguageModelTextPart { constructor(value) { this.value = value; } }
    instance.vscode.LanguageModelTextPart = LanguageModelTextPart;
    instance.vscode.lm = { tools: [{ name: 'datadog-search_datadog_logs', description: 'Search', inputSchema: { type: 'object' } }],
      invokeTool: async () => { invocations++; return { content: [new LanguageModelTextPart('401 increased')] }; } };
    instance.vscode.window.showWarningMessage = async () => approve ? 'Allow request' : undefined;
    await instance.send({ type: 'orchestrate', experiment: { ...experiment(), evidence: '', comparisonMode: 'end-to-end', test: { repetitions: 1 },
      baseline: { provider: 'ollama', model: 'baseline' }, candidate: { provider: 'openai', model: 'candidate', endpoint: 'https://models.example.test/v1' } } });
    assert.deepEqual(instance.errors, []);
    const completed = instance.messages.findLast(message => message.type === 'testFinished').experiment;
    assert.equal(completed.testRun.status, approve ? 'completed' : 'cancelled');
    assert.equal(turns, approve ? 4 : 1);
    assert.equal(invocations, approve ? 2 : 0);
  }
});

test('full investigations retain complete evidence and token estimates through UI, reports, and export/import', async () => {
  const reviewed = [];
  const instance = host({ evaluateWithCopilot: async (api, input) => {
    reviewed.push(input);
    return { inputFingerprint: evaluationKey(input), verdict: 'candidate', orderConsistent: true, summary: 'Candidate evidence supports the recommendation.',
      criteria: [{ criterion: 'grounding', verdict: 'candidate', citations: [] }], unknowns: [], judgments: [],
      inputTokenEstimates: [], model: { id: 'reviewer' } };
  } }, { runModel: async (input, { conversation }) => {
    assert.ok(conversation.some(message => message.content === AGENT_PROMPT));
    return conversation.some(message => message.role === 'tool')
      ? { ...input, response: '401 increased, root cause remains unknown.', inputTokens: null, outputTokens: null,
        estimatedInputTokens: 20, estimatedOutputTokens: 10 }
      : { ...input, response: '', estimatedInputTokens: 10, estimatedOutputTokens: 5,
        toolCalls: [{ callId: 'query', name: 'mcp_datadog_search_datadog_logs', input: { query: input.model } }] };
  } });
  class LanguageModelTextPart { constructor(value) { this.value = value; } }
  instance.vscode.LanguageModelTextPart = LanguageModelTextPart;
  instance.vscode.lm = { tools: [{ name: 'mcp_datadog_search_datadog_logs', inputSchema: { type: 'object' } }],
    invokeTool: async () => ({ content: [new LanguageModelTextPart('401 increased.\n' + 'x'.repeat(60000) + 'OMITTED_TAIL')] }) };
  instance.vscode.window.showWarningMessage = async () => 'Allow request';
  const input = { ...experiment(), evidence: '', comparisonMode: 'end-to-end', test: { repetitions: 1 },
    baseline: { provider: 'ollama', model: 'baseline' }, candidate: { provider: 'ollama', model: 'candidate' } };
  await instance.send({ type: 'orchestrate', experiment: input });
  assert.deepEqual(instance.errors, []);
  const completed = instance.messages.findLast(message => message.type === 'testFinished').experiment;
  assert.equal(completed.testRun.status, 'completed');
  assert.equal(completed.prompt, input.prompt, 'User instructions are not overwritten by shared runtime policy');
  for (const side of ['baseline', 'candidate']) {
    assert.equal(completed.testRun.pairs[0][side].result.investigationBudget, undefined);
    assert.match(completed.testRun.pairs[0][side].result.toolEvidence[0].content, /OMITTED_TAIL/);
    assert.equal(completed.testRun.pairs[0][side].result.usageTurns.length, 2);
    assert.equal(completed.testRun.pairs[0][side].result.modelRequestCount, 2);
    assert.equal(completed.testRun.pairs[0][side].result.toolCallCount, 1);
  }
  assert.doesNotMatch(reviewed[0].evidence, /"truncated": true|"limited": true/);
  assert.match(reviewed[0].evidence, /OMITTED_TAIL/);
  const panel = webview(completed);
  const allText = node => [node.textContent || '', ...(node.children || []).map(allText)].join(' ');
  assert.doesNotMatch(allText(panel.field('testResults')), /Budget-limited|Finished with limits/);
  assert.match(allText(panel.field('testResults')), /Full agent/);
  panel.click('export');
  await instance.send(panel.messages.at(-1));
  const exported = JSON.parse(instance.files[0]);
  assert.match(instance.files[0], /OMITTED_TAIL/);
  await instance.send({ type: 'compare', experiment: exported });
  const comparison = instance.messages.findLast(message => message.type === 'result').result;
  assert.ok(comparison.testRun);
  assert.equal(comparison.testSummary.counts.candidate, 1);
  assert.equal(comparison.testSummary.counts.unresolved, 0);
  panel.receive({ type: 'result', revision: panel.messages.at(-1).revision, result: comparison });
  assert.match(allText(panel.field('testResults')), /~30 \/ ~15/);
  assert.match(allText(panel.field('testResults')), /Model-counted estimate/);
  assert.match(allText(panel.field('testResults')), /Avg tokens in \/ out per run/);
  assert.match(allText(panel.field('testResults')), /Model turns 2 Across successful runs/);
  assert.match(allText(panel.field('testResults')), /Tool calls 1 Executed calls/);
  assert.match(allText(panel.field('testResults')), /Quality preference vs\. efficiency/);
  assert.match(allText(panel.field('testResults')), /~1.00x baseline/);
  assert.match(allText(panel.field('testResults')), /No verified exact Azure model match/);
  assert.ok(descendants(panel.field('testResults')).some(node => node.className?.includes('model-summary-card model-preferred')));
  const cards = descendants(panel.field('testResults')).filter(node => /^(model-summary-card|response-card)( |$)/.test(node.className || ''));
  assert.equal(cards.length, 4);
  for (const [index, card] of cards.entries()) {
    assert.equal(descendants(card).find(node => node.tagName === 'H3').textContent, index % 2 ? 'candidate' : 'baseline');
    assert.equal(descendants(card).find(node => node.className === 'model-role').textContent, index % 2 ? 'Candidate' : 'Baseline');
  }
  assert.match(allText(panel.field('candidateResponseStatus')), /Preferred/);
  assert.equal(panel.field('candidateResponseCard').className, 'response-card model-preferred');
  assert.equal(panel.field('baselineResponseCard').className, 'response-card');
  await instance.send({ type: 'report', experiment: exported });
  assert.doesNotMatch(instance.files[1], /Budget-limited investigation/);
  assert.match(instance.files[1], /estimatedOutputTokens/);
  assert.match(instance.markup, /Tool instructions/);
  assert.doesNotMatch(instance.markup, /Shared budget instructions|50,000/);
  instance.vscode.window.showOpenDialog = async () => ['saved-test.json'];
  instance.vscode.workspace.fs.readFile = async () => Buffer.from(JSON.stringify(exported));
  await instance.send({ type: 'import', experiment: input });
  assert.deepEqual(instance.errors, []);
  assert.equal(instance.messages.findLast(message => message.type === 'imported').experiment.testRun.pairs[0].baseline.result.estimatedOutputTokens, 15);
  assert.equal(instance.messages.findLast(message => message.type === 'imported').experiment.testRun.pairs[0].baseline.result.usageTurns.length, 2);
  for (const corrupt of [
    record => { record.pairs[0].baseline.result.toolEvidence = []; },
    record => { record.pairs[0].baseline.result.estimatedOutputTokens = -1; },
    record => { record.pairs[0].baseline.result.estimatedInputTokens = 'unknown'; },
    record => { record.pairs[0].baseline.result.modelRequestCount = 99; },
    record => { record.pairs[0].baseline.result.toolCallCount = 99; },
    record => { record.plan.investigationMode = 'invalid'; }
  ]) {
    const altered = structuredClone(exported);
    corrupt(altered.testRun);
    const errors = instance.errors.length;
    await instance.send({ type: 'compare', experiment: altered });
    assert.equal(instance.errors.length, errors + 1);
    assert.match(instance.errors.at(-1), /Invalid controlled-test record/);
  }
});

test('cancelled live tests retain earlier tool activity in history without a successful response', async () => {
  const instance = host({}, { runModel: async input => ({ ...input, inputTokens: 10, outputTokens: 2,
    toolCalls: [{ callId: 'call', name: 'workspace_operation', input: {} }] }) });
  class LanguageModelTextPart { constructor(value) { this.value = value; } }
  instance.vscode.LanguageModelTextPart = LanguageModelTextPart;
  instance.vscode.lm = { tools: [{ name: 'workspace_operation', description: 'Operation', inputSchema: { type: 'object' } }],
    invokeTool: async () => ({ content: [new LanguageModelTextPart('Retained earlier activity')] }) };
  let approvals = 0;
  instance.vscode.window.showWarningMessage = async () => ++approvals === 1 ? 'Allow request' : undefined;
  await instance.send({ type: 'orchestrate', experiment: { ...experiment(), comparisonMode: 'end-to-end',
    toolSelection: ['workspace_operation'], test: { repetitions: 1 },
    baseline: { provider: 'ollama', model: 'one' }, candidate: { provider: 'ollama', model: 'two' } } });
  assert.deepEqual(instance.errors, []);
  const saved = instance.historyEntries[0].experiment.testRun;
  assert.equal(saved.status, 'cancelled');
  assert.equal(saved.pairs[0].baseline.status, 'cancelled');
  assert.equal(saved.pairs[0].baseline.result.response, '');
  assert.equal(saved.pairs[0].baseline.result.toolEvidence[0].content, 'Retained earlier activity');
  assert.deepEqual(require('../src/orchestration').validateTestRecord(saved), saved);
});

test('analysis and exports show exact screenshot ratios, averages, activity and per-turn Azure scenarios', async () => {
  const { orchestrateTest, summarizeTest, validateTestRecord } = require('../src/orchestration');
  const { compare, asMarkdown } = require('../src/core');
  const { asHtml } = require('../src/html');
  const { usageTurn } = require('../src/usage');
  const input = { ...experiment(), comparisonMode: 'end-to-end', evidence: '', test: { repetitions: 3 },
    baseline: { provider: 'vscode', model: 'gpt-5.6-luna' }, candidate: { provider: 'vscode', model: 'gpt-6.1-sol' } };
  const counts = { baseline: 0, candidate: 0 };
  const record = await orchestrateTest(input, {
    comparePair: compare,
    evaluatePair: async () => ({ verdict: 'candidate', orderConsistent: true, summary: 'Candidate preferred.',
      criteria: [], unknowns: [], judgments: [], inputTokenEstimates: [], model: { id: 'reviewer' } }),
    runVariant: async (request, side) => {
      const index = counts[side]++;
      const estimatedInputTokens = side === 'baseline' ? 149402 : [367349, 367350, 367350][index];
      const estimatedOutputTokens = side === 'baseline' ? 4476 : 10546;
      return { ...request, response: side + ' answer', estimatedInputTokens, estimatedOutputTokens,
        elapsedMs: side === 'baseline' ? 51700 : 113400, modelRequestCount: 2, toolCallCount: 1,
        toolEvidence: [{ tool: 'datadog-search_datadog_logs', input: { query: '401' }, collectedAt: new Date().toISOString(), content: '401 increased.' }],
        usageTurns: [usageTurn({ model: request.model, estimatedInputTokens: 100000, estimatedOutputTokens: 100 }),
          usageTurn({ model: request.model, estimatedInputTokens: estimatedInputTokens - 100000, estimatedOutputTokens: estimatedOutputTokens - 100 })] };
    }
  });
  const serialized = JSON.parse(JSON.stringify(record));
  assert.deepEqual(validateTestRecord(serialized), serialized);
  const saved = { ...input, testRun: record,
    baseline: { ...input.baseline, response: 'baseline answer' }, candidate: { ...input.candidate, response: 'candidate answer' } };
  const result = compare(saved);
  const panel = webview(saved);
  panel.receive({ type: 'result', revision: panel.messages.at(-1).revision, result });
  const text = visibleText(panel.field('testResults'));
  for (const pattern of [/~2.46x baseline/, /~2.36x baseline/, /2.19x baseline/, /~367,349.7 \/ ~10,546/,
    /Model turns 6/, /Tool calls 3/, /Run 3 \/ Turn 2/, /\$0.105755 \/ \$0.203453/, /\$2.520478 \/ \$4.882766/,
    /not Copilot or Azure billed cost/, /Evaluator usage \(separate/]) assert.match(text, pattern);
  const costDetails = descendants(panel.field('testResults')).filter(node =>
    node.tagName === 'DETAILS' && node.className.includes('usage-details'));
  assert.ok(costDetails.length >= 2);
  for (const detail of costDetails) {
    assert.ok(!detail.open, 'Pricing starts collapsed');
    assert.match(visibleText(detail), /Azure-equivalent cost estimate/);
  }
  const costTiles = descendants(panel.field('testResults')).filter(node =>
    node.className === 'metric-tile' && visibleText(node).trimStart().startsWith('Azure-equivalent cost estimate'));
  assert.equal(costTiles.length, costDetails.length, 'Every cost total is inside its pricing disclosure');
  for (const tile of costTiles) assert.ok(costDetails.some(detail => descendants(detail).includes(tile)));
  assert.equal(result.testSummary.metrics.baseline.usage.rows.length, 6);
  assert.equal(result.testSummary.metrics.candidate.modelRequestCount, 6);
  const html = asHtml(result, { css: '', markdownScript: '' });
  for (const pattern of [/~2.46x baseline/, /Avg tokens in \/ out per run/, /Run 3 \/ Turn 2/, /\$2.520478 \/ \$4.882766/]) {
    assert.match(html, pattern);
  }
  const htmlCosts = [...html.matchAll(/<details class="result-details"><summary>Per-turn costs and pricing assumptions<\/summary>([\s\S]*?)<\/details>/g)];
  assert.ok(htmlCosts.length >= 2);
  assert.equal(htmlCosts.length, (html.match(/Azure-equivalent cost estimate/g) || []).length);
  for (const [, body] of htmlCosts) assert.match(body, /Azure-equivalent cost estimate/);
  const markdown = asMarkdown(result);
  assert.match(markdown, /Azure-equivalent token estimates/);
  assert.match(markdown, /Run 3 \/ Turn 2/);
  assert.match(markdown, /2.46x baseline/);
  const old = structuredClone(record);
  for (const pair of old.pairs) for (const side of ['baseline', 'candidate']) {
    delete pair[side].result.usageTurns;
    delete pair[side].result.modelRequestCount;
    delete pair[side].result.toolCallCount;
  }
  assert.doesNotThrow(() => validateTestRecord(old));
  assert.equal(summarizeTest(old).metrics.baseline.usage.total, 'Unknown');
  assert.equal(summarizeTest(old).metrics.baseline.modelRequestCount, null);
  record.pairs[1].candidate.status = 'failed';
  record.pairs[1].evaluationStatus = 'not-started';
  record.pairs[1].evaluation = null;
  record.status = 'partial';
  const partial = summarizeTest(record);
  assert.equal(partial.efficiency[0].value, 'Not comparable');
  assert.equal(partial.metrics.candidate.usage.total, 'Unknown');
  assert.equal(partial.metrics.candidate.tokensPerRun.estimatedOutputTokens, 10546);
  assert.equal(partial.metrics.candidate.modelRequestCount, 4);
});
