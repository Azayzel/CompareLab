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

test('candidate usage and activity exclude baseline and evaluator activity across paired runs', async () => {
  const { orchestrateTest, summarizeTest } = require('../src/orchestration');
  const { compare } = require('../src/core');
  const vscode = api();
  const record = await orchestrateTest({
    prompt: 'Investigate the example service', comparisonMode: 'end-to-end', test: { repetitions: 2 },
    baseline: { provider: 'vscode', model: 'baseline-model' },
    candidate: { provider: 'vscode', model: 'candidate-model' }
  }, {
    comparePair: compare,
    evaluatePair: async () => ({ verdict: 'tie', criteria: [], unknowns: [], requestCount: 1,
      usageTurns: [{ model: 'reviewer', inputTokens: 50000, outputTokens: 1000 }] }),
    runVariant: (input, side) => {
      let turns = 0;
      const multiplier = side === 'baseline' ? 1 : 2;
      return runDatadogAgent(vscode, input, [tool], async conversation => {
        turns++;
        if (turns === 1) assert.deepEqual(conversation, [
          { role: 'user', content: input.prompt }, { role: 'user', content: DATADOG_AGENT_PROMPT }
        ]);
        for (const message of conversation.filter(message => message.role === 'tool')) {
          assert.equal(JSON.parse(message.content).input.query, side);
        }
        return { inputTokens: 10 * multiplier, outputTokens: multiplier,
          ...(turns === 1 ? { toolCalls: Array.from({ length: multiplier }, (_, i) =>
            ({ callId: 'call-' + i, name: tool.name, input: { query: side } })) } : { response: side + ' answer' }) };
      });
    }
  });
  const summary = summarizeTest(record);
  assert.equal(record.status, 'completed');
  for (const [side, multiplier] of [['baseline', 1], ['candidate', 2]]) {
    const metrics = summary.metrics[side];
    assert.equal(metrics.inputTokens, 40 * multiplier);
    assert.equal(metrics.outputTokens, 4 * multiplier);
    assert.equal(metrics.toolCallCount, 2 * multiplier);
    assert.equal(metrics.modelRequestCount, 4);
    assert.equal(metrics.tokensPerRun.inputTokens, 20 * multiplier);
    assert.equal(metrics.usage.rows.length, 4);
    assert.ok(metrics.usage.rows.every(row => row.model === side + '-model'));
  }
  assert.equal(summary.evaluatorUsage.rows.length, 2);
  assert.equal(summary.efficiency[0].value, '2.00x baseline');
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

test('invalid event arguments return the full schema for correction without changing either call', async () => {
  const vscode = api();
  const events = { name: 'mcp_datadog_search_datadog_events', description: 'Search events', inputSchema: {
    type: 'object', additionalProperties: false, properties: {
      query: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
      max_tokens: { type: 'integer', description: 'Output token budget, not a row limit' },
      start_at: { type: 'integer' }, sort: { type: 'string', enum: ['timestamp', '-timestamp', 'asc', 'desc'] }
    }
  } };
  const invalid = { query: 'service:example', limit: 10 };
  const corrected = { query: 'service:example', from: 'now-1h', to: 'now', max_tokens: 500, start_at: 0, sort: '-timestamp' };
  const rejection = 'MPC -32602: validating "arguments": validating root: unexpected additional properties ["limit"]. ' +
    'Valid fields: from, max_tokens, query, sort, start_at, to. max_tokens is an output token budget, not a row limit.';
  const attempts = [];
  vscode.lm.invokeTool = async (name, { input }) => {
    attempts.push({ name, input: structuredClone(input) });
    if (Object.hasOwn(input, 'limit')) throw new Error(rejection);
    return { content: [new vscode.LanguageModelTextPart('Verified query result')] };
  };
  let turn = 0;
  const progress = [];
  const result = await runDatadogAgent(vscode, { prompt: 'Investigate', model: 'test-model' }, [events, tool],
    async (conversation, tools) => {
      assert.deepEqual(tools, [events, tool]);
      turn++;
      const usage = { inputTokens: 10, outputTokens: 2 };
      if (turn === 1) return { ...usage, toolCalls: [
        { callId: 'invalid', name: events.name, input: invalid }, { ...call(), callId: 'logs' }
      ] };
      const feedback = conversation.filter(message => message.role === 'tool');
      assert.deepEqual(feedback.slice(0, 2).map(message => message.toolCallId), ['invalid', 'logs']);
      const error = JSON.parse(feedback[0].content);
      assert.equal(error.isError, true);
      assert.equal(error.content, rejection);
      assert.deepEqual(error.input, invalid);
      assert.deepEqual(error.inputSchema, events.inputSchema);
      if (turn === 2) return { ...usage, toolCalls: [{ callId: 'corrected', name: events.name, input: corrected }] };
      assert.equal(JSON.parse(feedback[2].content).isError, undefined);
      return { ...usage, response: 'Evidence-based answer' };
    }, undefined, message => progress.push(message), new Set([events.name, tool.name]));
  assert.deepEqual(attempts, [{ name: events.name, input: invalid }, { name: tool.name, input: call().input },
    { name: events.name, input: corrected }]);
  assert.equal(result.toolEvidence.length, 3);
  assert.equal(result.toolEvidence[0].isError, true);
  assert.equal(result.toolCallCount, 3);
  assert.equal(result.modelRequestCount, 3);
  assert.equal(result.usageTurns.length, 3);
  assert.equal(result.inputTokens, 30);
  assert.equal(result.outputTokens, 6);
  assert.ok(progress.some(message => /returning the error and schema/.test(message)));
});

test('repeating rejected arguments stops visibly even if object keys are reordered', async () => {
  const vscode = api();
  let requests = 0;
  vscode.lm.invokeTool = async () => { throw Object.assign(new Error('Invalid params'), { code: -32602 }); };
  await assert.rejects(runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool], async () => ({
    toolCalls: [{ ...call(), input: ++requests === 1 ? { query: 'service:api', limit: 10 } : { limit: 10, query: 'service:api' } }]
  })), /rejected the same arguments again after correction feedback: Invalid params/);
  assert.equal(requests, 2);
});

test('argument errors alone cannot qualify as incident evidence', async () => {
  const vscode = api();
  vscode.lm.invokeTool = async () => { throw new Error('MCP error -32602: Invalid arguments'); };
  let requests = 0;
  await assert.rejects(runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => ++requests === 1 ? { toolCalls: [call()] } : { response: 'Unsupported conclusion' }),
  /did not query Datadog MCP data/);
  assert.equal(requests, 2);
});

test('duplicate rejected calls in one batch receive feedback before repeat detection applies', async () => {
  const vscode = api();
  let requests = 0;
  vscode.lm.invokeTool = async (name, { input }) => {
    if (input.limit) return { isError: true, content: [new vscode.LanguageModelTextPart('MCP -32602: Invalid arguments')] };
    return { content: [new vscode.LanguageModelTextPart('Actual evidence')] };
  };
  const result = await runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool], async conversation => {
    requests++;
    if (requests === 1) return { toolCalls: ['one', 'two'].map(callId => ({
      ...call(), callId, input: { query: 'example', limit: 1 }
    })) };
    if (requests === 2) {
      assert.equal(conversation.filter(message => message.role === 'tool').length, 2);
      return { toolCalls: [call()] };
    }
    return { response: 'Supported conclusion' };
  });
  assert.equal(result.toolEvidence.filter(entry => entry.isError).length, 2);
  assert.equal(result.toolCallCount, 3);
});

test('fatal tool results, provider failures and cancellation are not argument recovery', async () => {
  const vscode = api();
  vscode.lm.invokeTool = async () => ({ isError: true, content: [new vscode.LanguageModelTextPart('Permission denied')] });
  await assert.rejects(runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => ({ toolCalls: [call()] })), /Permission denied/);
  const providerError = Object.assign(new Error('Model rejected its request'), { code: -32602 });
  await assert.rejects(runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => { throw providerError; }), error => error === providerError);
  const source = new vscode.CancellationTokenSource();
  vscode.lm.invokeTool = async () => {
    source.cancel();
    throw Object.assign(new Error('Invalid params'), { code: -32602 });
  };
  await assert.rejects(runDatadogAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => ({ toolCalls: [call()] }), source.token), vscode.CancellationError);
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
