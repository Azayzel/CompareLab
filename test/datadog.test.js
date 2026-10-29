'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectDatadogTools, runDatadogAgent, DATADOG_AGENT_PROMPT } = require('../src/datadog');

const tool = { name: 'mcp_datadog_search_datadog_logs', description: 'Search Datadog logs',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };
const call = (name = tool.name) => ({ callId: 'call-1', name, input: { query: 'service:api' } });

function api() {
  const invocations = [];
  class CancellationTokenSource {
    constructor() {
      this.listeners = [];
      this.token = { isCancellationRequested: false, onCancellationRequested: listener => {
        this.listeners.push(listener);
        return { dispose() {} };
      } };
    }
    cancel() { this.token.isCancellationRequested = true; this.listeners.forEach(listener => listener()); }
    dispose() {}
  }
  class LanguageModelTextPart { constructor(value) { this.value = value; } }
  return { invocations, CancellationTokenSource, LanguageModelTextPart, CancellationError: class extends Error {},
    lm: { tools: [tool, { name: 'github_search' }], invokeTool: async (name, options) => {
      invocations.push({ name, options });
      return { content: [new LanguageModelTextPart('HTTP 401 increased')] };
    } },
    window: { showQuickPick: async items => items, showWarningMessage: async () => 'Allow request' } };
}

test('automatically enables recognized Datadog capabilities without a picker and rejects unavailable tools', async () => {
  const vscode = api();
  vscode.window.showQuickPick = async () => { throw new Error('No tool picker should be needed'); };
  const dangerous = ['execute_code', 'delete_datadog_notebook', 'create_datadog_notebook', 'search_new_write_tool']
    .map(name => ({ ...tool, name: 'mcp_datadog_' + name }));
  const guides = ['list_datadog_skills', 'load_datadog_skill'].map(name => ({ ...tool, name: 'mcp_datadog_' + name }));
  vscode.lm.tools.push(...dangerous, ...guides);
  const confirmations = [];
  vscode.window.showWarningMessage = async (message, options) => {
    confirmations.push(options.detail);
    return 'Approve for this test';
  };
  assert.deepEqual(await selectDatadogTools(vscode), { tools: [tool, ...guides],
    approvedReadOnlyTools: new Set([tool.name, ...guides.map(tool => tool.name)]) });
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /Automatically enabled: Query guides, Logs/);
  for (const entry of dangerous) assert.doesNotMatch(confirmations[0], new RegExp(entry.name));
  vscode.lm.tools = [{ name: 'github_search' }];
  await assert.rejects(selectDatadogTools(vscode), /No Datadog MCP tools/);
  vscode.lm.tools = guides;
  await assert.rejects(selectDatadogTools(vscode), /no recognized investigation query tools/);
  vscode.lm.tools = [tool];
  vscode.window.showWarningMessage = async () => undefined;
  assert.equal(await selectDatadogTools(vscode), undefined);
});

test('recognizes VS Code generated, shortened, numbered and legacy names without changing invocation IDs', async () => {
  const prefixes = ['mcp_datadog_', 'mcp_datadog_mcp_s_', 'mcp_datadog_mcp_2_', 'mcp_datadog2_',
    'mcp_observability_', 'mcp_a1b2c3d4_', 'mcp__datadog__', 'datadog-'];
  for (const prefix of prefixes) {
    const vscode = api();
    const names = ['search_datadog_logs', 'get_datadog_metric', 'aggregate_spans',
      'get_change_stories', 'list_datadog_skills', 'load_datadog_skill'];
    vscode.lm.tools = names.map(name => ({ ...tool, name: prefix + name }));
    vscode.lm.tools.push({ ...tool, name: prefix + 'execute_code' }, { ...tool, name: prefix + 'search_datadog_logs_delete' },
      { ...tool, name: 'mcp_github_aggregate_spans' });
    let approvals = 0;
    vscode.window.showWarningMessage = async () => { approvals++; return 'Approve for this test'; };
    const selection = await selectDatadogTools(vscode);
    assert.deepEqual(selection.tools.map(tool => tool.name), names.map(name => prefix + name), prefix);
    let round = 0;
    const result = await runDatadogAgent(vscode, { prompt: 'Investigate' }, selection.tools,
      async () => ++round === 1 ? { toolCalls: [call(prefix + 'search_datadog_logs')] } : { response: '401 increased' },
      undefined, undefined, selection.approvedReadOnlyTools);
    assert.equal(vscode.invocations[0].name, prefix + 'search_datadog_logs');
    assert.equal(result.toolEvidence[0].tool, prefix + 'search_datadog_logs');
    assert.equal(approvals, 1);
  }
});

test('recognizes raw Datadog operation names without auto-enabling unrelated generic tools', async () => {
  const vscode = api();
  vscode.lm.tools = ['search_datadog_logs', 'load_datadog_skill', 'execute_code', 'aggregate_spans',
    'custom_search_datadog_logs'].map(name => ({ ...tool, name }));
  vscode.window.showWarningMessage = async () => 'Approve for this test';
  const selection = await selectDatadogTools(vscode);
  assert.deepEqual(selection.tools.map(tool => tool.name), ['search_datadog_logs', 'load_datadog_skill']);
});

test('discovery errors report bounded tool names without claiming connectivity or dumping schemas', async () => {
  const vscode = api();
  vscode.lm.tools = Array.from({ length: 25 }, (_, i) => ({
    ...tool, name: 'mcp_datadog_unknown_' + i, description: 'DO_NOT_LOG', inputSchema: { secret: 'DO_NOT_LOG' }
  }));
  await assert.rejects(selectDatadogTools(vscode), error => {
    assert.match(error.message, /no recognized investigation query tools/);
    assert.match(error.message, /mcp_datadog_unknown_0/);
    assert.match(error.message, /first 20 of 25/);
    assert.doesNotMatch(error.message, /DO_NOT_LOG|mcp_datadog_unknown_24|MCP is connected/);
    return true;
  });
});

test('each investigation has a private conversation and retains actual tool inputs and results', async () => {
  const vscode = api();
  const conversations = [];
  for (const side of ['baseline', 'candidate']) {
    let turns = 0;
    const result = await runDatadogAgent(vscode, { prompt: 'Investigate', systemPrompt: 'Instructions' }, [tool], async conversation => {
      conversations.push(structuredClone(conversation));
      return ++turns === 1 ? { response: '', toolCalls: [call()], inputTokens: 10, outputTokens: 2 }
        : { response: side + ' answer', toolCalls: [], inputTokens: 20, outputTokens: 5 };
    });
    assert.equal(result.response, side + ' answer');
    assert.equal(result.inputTokens, 30);
    assert.equal(result.outputTokens, 7);
    assert.equal(result.estimatedInputTokens, null);
    assert.equal(result.toolEvidence[0].content, 'HTTP 401 increased');
    assert.deepEqual(result.toolEvidence[0].input, { query: 'service:api' });
    assert.equal(JSON.parse(result.requestMessages.findLast(message => message.role === 'tool').content).content, 'HTTP 401 increased');
    assert.equal(result.investigationBudget, undefined);
  }
  assert.deepEqual(conversations[0], conversations[2]);
  assert.equal(conversations[0].length, 3);
  assert.equal(conversations[0][2].content, DATADOG_AGENT_PROMPT);
  assert.equal(JSON.parse(conversations[1].findLast(message => message.role === 'tool').content).content, 'HTTP 401 increased');
  assert.equal(vscode.invocations.length, 2);
  assert.equal(vscode.invocations[0].options.toolInvocationToken, undefined);
});

test('does not accept fabricated model evidence or invoke unapproved tools', async () => {
  const vscode = api();
  await assert.rejects(runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => ({ response: 'I checked Datadog' })), /did not query Datadog MCP data/);
  await assert.rejects(runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => ({ toolCalls: [call('github_search')] })), /unapproved Datadog tool/);
  assert.equal(vscode.invocations.length, 0);
});

test('one approval covers both models and all pairs but never carries to the next test', async () => {
  const vscode = api();
  let approvals = 0;
  vscode.window.showWarningMessage = async () => { approvals++; return 'Approve for this test'; };
  const selection = await selectDatadogTools(vscode);
  for (let i = 0; i < 6; i++) {
    let round = 0;
    await runDatadogAgent(vscode, { prompt: 'Investigate' }, selection.tools,
      async () => ++round === 1 ? { toolCalls: [call()] } : { response: '401 increased' },
      undefined, undefined, selection.approvedReadOnlyTools);
  }
  assert.equal(approvals, 1);
  assert.equal(vscode.invocations.length, 6);
  vscode.window.showWarningMessage = async () => { approvals++; return undefined; };
  assert.equal(await selectDatadogTools(vscode), undefined);
  assert.equal(approvals, 2);
  assert.equal(vscode.invocations.length, 6);
});

test('per-call mode and unsafe operations cannot bypass approval', async () => {
  const vscode = api();
  vscode.window.showWarningMessage = async () => 'Review every request';
  const selection = await selectDatadogTools(vscode);
  assert.equal(selection.approvedReadOnlyTools.size, 0);
  vscode.window.showWarningMessage = async () => undefined;
  await assert.rejects(runDatadogAgent(vscode, { prompt: 'Investigate' }, selection.tools,
    async () => ({ toolCalls: [call()] }), undefined, undefined, selection.approvedReadOnlyTools), vscode.CancellationError);
  const unsafe = { ...tool, name: 'mcp_datadog_execute_code' };
  await assert.rejects(runDatadogAgent(vscode, { prompt: 'Investigate' }, [unsafe],
    async () => ({ toolCalls: [call(unsafe.name)] }), undefined, undefined, new Set([unsafe.name])), /unapproved Datadog tool/);
  assert.equal(vscode.invocations.length, 0);
});

test('query guides alone cannot masquerade as incident evidence', async () => {
  const vscode = api();
  const guide = { ...tool, name: 'mcp_datadog_mcp_s_load_datadog_skill' };
  let round = 0;
  await assert.rejects(runDatadogAgent(vscode, { prompt: 'Investigate' }, [guide],
    async () => ++round === 1 ? { toolCalls: [call(guide.name)] } : { response: 'The service failed.' },
    undefined, undefined, new Set([guide.name])), /Query guides alone are not evidence/);
});

test('requires approval for every invocation and respects cancellation', async () => {
  const vscode = api();
  vscode.window.showWarningMessage = async () => undefined;
  await assert.rejects(runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => ({ toolCalls: [call()] })), vscode.CancellationError);
  const source = new vscode.CancellationTokenSource();
  source.cancel();
  await assert.rejects(runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => { throw new Error('Must not run'); }, source.token), vscode.CancellationError);
  assert.equal(vscode.invocations.length, 0);
});

test('tool errors, unsupported results and empty results still fail visibly', async () => {
  const vscode = api();
  const turn = async () => ({ toolCalls: [call()] });
  vscode.lm.invokeTool = async () => { throw new Error('Datadog authentication failed'); };
  await assert.rejects(runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool], turn), /Datadog authentication failed/);
  for (const content of [[], [{}], [new vscode.LanguageModelTextPart(' ')]]) {
    vscode.lm.invokeTool = async () => ({ content });
    await assert.rejects(runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool], turn), /must return text|empty text/);
  }
});

test('investigations continue past six model requests until the model answers', async () => {
  const vscode = api();
  let requests = 0;
  const result = await runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool],
    async (messages, tools) => {
      assert.equal(tools.length, 1);
      return ++requests <= 12 ? { toolCalls: [call()] } : { response: 'Complete investigation.' };
    });
  assert.equal(requests, 13);
  assert.equal(vscode.invocations.length, 12);
  assert.equal(result.toolEvidence.length, 12);
  assert.equal(result.investigationBudget, undefined);
});

test('executes every approved call in a batch larger than eight without forcing an early answer', async () => {
  const vscode = api();
  const turns = [];
  const progress = [];
  const result = await runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool], async (messages, tools) => {
    turns.push(structuredClone(messages));
    if (turns.length === 1) return { toolCalls: Array.from({ length: 9 }, (_, i) => ({ ...call(), callId: 'call-' + i })) };
    assert.equal(tools.length, 1);
    const results = messages.filter(message => message.role === 'tool');
    assert.equal(results.length, 9);
    assert.equal(new Set(results.map(message => message.toolCallId)).size, 9);
    assert.equal(JSON.parse(results[8].content).content, 'HTTP 401 increased');
    assert.doesNotMatch(JSON.stringify(messages), /FINAL ANSWER NOW|remaining budget/);
    return { response: 'HTTP 401 increased.' };
  }, undefined, message => progress.push(message));
  assert.equal(vscode.invocations.length, 9);
  assert.equal(result.toolEvidence.length, 9);
  assert.equal(result.modelRequestCount, 2);
  assert.equal(result.toolCallCount, 9);
  assert.equal(result.usageTurns.length, 2);
  assert.ok(progress.every(message => !message.includes('Budget-limited')));
});

test('sums actual and estimated token counts across every model turn', async () => {
  const vscode = api();
  let requests = 0;
  const result = await runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool], async (messages, tools) => {
    requests++;
    assert.equal(tools.length, 1);
    return { ...(requests <= 7 ? { toolCalls: [call()] } : { response: 'Answer.' }),
      inputTokens: 10, outputTokens: 5, estimatedInputTokens: 11, estimatedOutputTokens: 6 };
  });
  assert.equal(vscode.invocations.length, 7);
  assert.equal(result.inputTokens, 80);
  assert.equal(result.outputTokens, 40);
  assert.equal(result.estimatedInputTokens, 88);
  assert.equal(result.estimatedOutputTokens, 48);
  assert.equal(result.modelRequestCount, 8);
  assert.equal(result.toolCallCount, 7);
  assert.equal(result.usageTurns.length, 8);
  assert.ok(result.usageTurns.every(turn => turn.inputTokens === 10 && turn.estimatedOutputTokens === 6));
});

test('large results are retained and sent in full without CompareLab truncation', async () => {
  const vscode = api();
  const original = 'HTTP 401 increased.\n' + 'x'.repeat(100000) + 'OMITTED_CONTENT';
  vscode.lm.invokeTool = async () => ({ content: [new vscode.LanguageModelTextPart(original)] });
  let requests = 0;
  const result = await runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool], async messages => {
    if (++requests === 1) return { toolCalls: [call()] };
    assert.match(JSON.stringify(messages), /OMITTED_CONTENT/);
    const retained = JSON.parse(messages.findLast(message => message.role === 'tool').content);
    assert.equal(retained.content, original);
    assert.equal(retained.truncated, undefined);
    return { response: 'HTTP 401 increased.' };
  });
  const retained = result.toolEvidence[0];
  assert.equal(retained.content, original);
  assert.equal(result.investigationBudget, undefined);
});

test('full results preserve text including surrogate pairs at the former truncation boundary', async () => {
  for (const original of ['x'.repeat(6000), 'x'.repeat(6001), 'x'.repeat(5999) + '\uD83D\uDE03']) {
    const vscode = api();
    vscode.lm.invokeTool = async () => ({ content: [new vscode.LanguageModelTextPart(original)] });
    let requests = 0;
    const result = await runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool], async () =>
      ++requests === 1 ? { toolCalls: [call()] } : { response: 'Answer from retained evidence.' });
    const retained = result.toolEvidence[0];
    assert.equal(retained.content, original);
    assert.equal(result.investigationBudget, undefined);
  }
});

test('retains more than 50,000 evidence characters including JSON escaping and metadata', async () => {
  const vscode = api();
  const original = '"\\\n'.repeat(50000);
  vscode.lm.invokeTool = async (name, options) => {
    vscode.invocations.push({ name, options });
    return { content: [new vscode.LanguageModelTextPart(original)] };
  };
  let requests = 0;
  const result = await runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool], async (messages, tools) => {
    if (++requests === 1) return { toolCalls: Array.from({ length: 8 }, (_, i) => ({
      ...call(), callId: 'call-' + i, input: { query: 'q'.repeat(1000) }
    })) };
    assert.equal(tools.length, 1);
    return { response: 'Complete investigation.' };
  });
  assert.ok(JSON.stringify(result.toolEvidence).length > 50000);
  assert.equal(vscode.invocations.length, 8);
  assert.ok(result.toolEvidence.every(item => item.content === original && item.truncated === undefined));
});

test('passes max_tokens through unchanged, leaving result sizing to the model and tool schema', async () => {
  for (const maxTokens of [undefined, 0, 10000, 200]) {
    const vscode = api();
    const queryTool = { ...tool, inputSchema: { type: 'object', properties: { max_tokens: { type: 'integer', minimum: 0 } } } };
    const input = { query: 'service:api', ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}) };
    let requests = 0;
    const result = await runDatadogAgent(vscode, { prompt: 'Investigate' }, [queryTool], async () =>
      ++requests === 1 ? { toolCalls: [{ ...call(), input }] } : { response: 'HTTP 401 increased.' });
    assert.equal(vscode.invocations[0].options.input.max_tokens, maxTokens);
    assert.equal(result.toolEvidence[0].input.max_tokens, maxTokens);
    assert.equal(input.max_tokens, maxTokens);
    assert.equal(result.toolEvidence[0].requestedInput, undefined);
  }
});

test('investigations can run beyond three minutes without an exploration or total deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const vscode = api();
  let requests = 0;
  let invocations = 0;
  vscode.lm.invokeTool = async (name, options, token) => {
    if (++invocations === 2) {
      t.mock.timers.tick(600000);
      assert.equal(token.isCancellationRequested, false);
    }
    return { content: [new vscode.LanguageModelTextPart('401 increased')] };
  };
  const result = await runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool], async (messages, tools, token) => {
    requests++;
    if (requests <= 2) return { toolCalls: [call()] };
    assert.equal(tools.length, 1);
    assert.equal(token.isCancellationRequested, false);
    assert.equal(JSON.parse(messages.findLast(message => message.role === 'tool').content).content, '401 increased');
    t.mock.timers.tick(1000);
    return { response: '401 increased; both queries completed.' };
  });
  assert.equal(result.toolEvidence.length, 2);
  assert.equal(result.investigationBudget, undefined);
  assert.equal(result.elapsedMs, 601000);
});

test('a missing usage count in any turn remains unknown rather than becoming a partial total', async () => {
  const vscode = api();
  let requests = 0;
  const result = await runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool], async (messages, tools, token) => {
    requests++;
    if (requests === 1) return { toolCalls: [call()], inputTokens: 10, outputTokens: 10 };
    return { response: '401 increased.', estimatedInputTokens: 10, estimatedOutputTokens: 10 };
  });
  assert.equal(result.toolEvidence.length, 1);
  assert.equal(result.inputTokens, null);
  assert.equal(result.outputTokens, null);
  assert.equal(result.estimatedInputTokens, null);
  assert.equal(result.estimatedOutputTokens, null);
});

test('user cancellation stops a pending provider that ignores the cancellation token', async () => {
  const vscode = api();
  let modelStarted;
  const modelReady = new Promise(resolve => { modelStarted = resolve; });
  const parent = new vscode.CancellationTokenSource();
  let requests = 0;
  const pending = runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool], async (messages, tools, token) => {
    requests++;
    if (requests === 1) return { toolCalls: [call()] };
    modelStarted();
    return new Promise(() => {});
  }, parent.token);
  const rejected = assert.rejects(pending, vscode.CancellationError);
  await modelReady;
  assert.equal(requests, 2);
  parent.cancel();
  await rejected;
});

test('user cancellation fails instead of manufacturing a final answer', async () => {
  const vscode = api();
  const parent = new vscode.CancellationTokenSource();
  await assert.rejects(runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool], async () => {
    parent.cancel();
    return { response: 'Must not be accepted' };
  }, parent.token), vscode.CancellationError);
});
