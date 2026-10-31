'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectTools, resolveTools, verifyReadOnlyTools, toolCatalog, runToolAgent: runVerifiedAgent, AGENT_PROMPT } = require('../src/tools/agent');

async function runToolAgent(vscode, input, tools, ...args) {
  const verified = await verifyReadOnlyTools(vscode, tools);
  return runVerifiedAgent(vscode, input, verified, ...args);
}

const tool = { name: 'mcp_observability_search_logs', description: 'Search logs',
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

test('picker exposes all tools without guessing server identity or operation safety', async () => {
  const vscode = api();
  vscode.lm.tools.push({ ...tool, name: 'execute_code', tags: ['workspace'] });
  vscode.window.showQuickPick = async (items, options) => {
    assert.equal(options.canPickMany, true);
    assert.equal(options.matchOnDetail, true);
    assert.deepEqual(items.map(item => item.label), vscode.lm.tools.map(tool => tool.name));
    assert.deepEqual(items.map(item => item.picked), [true, false, false]);
    return [items[0], items[2]];
  };
  assert.deepEqual(await selectTools(vscode, [tool.name]), [tool.name, 'execute_code']);
  assert.equal(vscode.invocations.length, 0);
  vscode.window.showQuickPick = async () => undefined;
  assert.equal(await selectTools(vscode), undefined);
  vscode.window.showQuickPick = async () => [];
  assert.deepEqual(await selectTools(vscode), []);
  vscode.lm.tools = [];
  await assert.rejects(selectTools(vscode), /No VS Code tools/);
});

test('uses exact selected names from arbitrary providers without auto-enabling other tools', async () => {
  for (const name of ['mcp_github_search', 'workspace_read_file', 'opaque_id', 'mcp_datadog_search_datadog_logs']) {
    const vscode = api();
    vscode.lm.tools = [{ ...tool, name }, { ...tool, name: 'not_selected' }];
    let approvals = 0;
    vscode.window.showWarningMessage = async () => { approvals++; return 'Allow request'; };
    const tools = resolveTools(vscode, [name]);
    assert.deepEqual(tools.map(tool => tool.name), [name]);
    let round = 0;
    const result = await runToolAgent(vscode, { prompt: 'Investigate' }, tools,
      async () => ++round === 1 ? { toolCalls: [call(name)] } : { response: '401 increased' });
    assert.equal(vscode.invocations[0].name, name);
    assert.equal(result.toolEvidence[0].tool, name);
    assert.equal(approvals, 1);
    assert.deepEqual(result.toolCatalog, tools);
  }
});

test('saved selections are revalidated and catalogs snapshot schemas', () => {
  const vscode = api();
  assert.throws(() => resolveTools(vscode, []), /Select tools/);
  assert.throws(() => resolveTools(vscode, [tool.name, tool.name]), /Invalid selected tool names/);
  assert.throws(() => resolveTools(vscode, ['removed']), /no longer available.*no tools were substituted/);
  const catalog = resolveTools(vscode, [tool.name]);
  catalog[0].inputSchema.properties.query.type = 'number';
  assert.equal(tool.inputSchema.properties.query.type, 'string');
});

test('changed or removed tools fail before invocation, including changes during confirmation', async () => {
  for (const remove of [false, true]) {
    const vscode = api();
    vscode.window.showWarningMessage = async () => {
      vscode.lm.tools = remove ? [] : [{ ...tool, description: 'Changed description' }];
      return 'Allow request';
    };
    await assert.rejects(runToolAgent(vscode, { prompt: 'Task' }, [tool],
      async () => ({ toolCalls: [call()] })), /changed during the run|No VS Code tools/);
    assert.equal(vscode.invocations.length, 0);
  }
});

test('a denied follow-up retains earlier tool activity without presenting a successful answer', async () => {
  const vscode = api();
  let approvals = 0;
  vscode.window.showWarningMessage = async () => ++approvals === 1 ? 'Allow request' : undefined;
  await assert.rejects(runToolAgent(vscode, { provider: 'vscode', model: 'shared', prompt: 'Task', runLabel: 'Original prompt' }, [tool],
    async () => ({ toolCalls: [call()], inputTokens: 10, outputTokens: 2 })), error => {
    assert.ok(error instanceof vscode.CancellationError);
    assert.equal(error.partialResult.toolEvidence.length, 1);
    assert.equal(error.partialResult.response, '');
    assert.equal(error.partialResult.usageTurns.length, 2);
    return true;
  });
  assert.equal(vscode.invocations.length, 1);
});

test('each investigation has a private conversation and retains actual tool inputs and results', async () => {
  const vscode = api();
  const conversations = [];
  for (const side of ['baseline', 'candidate']) {
    let turns = 0;
    const result = await runToolAgent(vscode, { prompt: 'Investigate', systemPrompt: 'Instructions' }, [tool], async conversation => {
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
  assert.equal(conversations[0][2].content, AGENT_PROMPT);
  assert.equal(JSON.parse(conversations[1].findLast(message => message.role === 'tool').content).content, 'HTTP 401 increased');
  assert.equal(vscode.invocations.length, 2);
  assert.equal(vscode.invocations[0].options.toolInvocationToken, undefined);
});

test('does not accept fabricated model evidence or invoke unapproved tools', async () => {
  const vscode = api();
  await assert.rejects(runToolAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => ({ response: 'I checked the data' })), /did not obtain successful tool results/);
  await assert.rejects(runToolAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => ({ toolCalls: [call('github_search')] })), /unselected tool/);
  assert.equal(vscode.invocations.length, 0);
});

test('candidate usage and activity exclude baseline and evaluator activity across paired runs', async () => {
  const { orchestrateTest, summarizeTest } = require('../src/comparison/orchestration');
  const { compare } = require('../src/comparison/core');
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
      return runToolAgent(vscode, input, [tool], async conversation => {
        turns++;
        if (turns === 1) assert.deepEqual(conversation, [
          { role: 'user', content: input.prompt }, { role: 'user', content: AGENT_PROMPT }
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

test('every invocation across both models and all pairs needs separate confirmation', async () => {
  const vscode = api();
  let approvals = 0;
  vscode.window.showWarningMessage = async () => { approvals++; return 'Allow request'; };
  const tools = resolveTools(vscode, [tool.name]);
  for (let i = 0; i < 6; i++) {
    let round = 0;
    await runToolAgent(vscode, { prompt: 'Investigate' }, tools,
      async () => ++round === 1 ? { toolCalls: [call()] } : { response: '401 increased' });
  }
  assert.equal(approvals, 6);
  assert.equal(vscode.invocations.length, 6);
  vscode.window.showWarningMessage = async () => { approvals++; return undefined; };
  await assert.rejects(runToolAgent(vscode, { prompt: 'Investigate' }, tools,
    async () => ({ toolCalls: [call()] })), vscode.CancellationError);
  assert.equal(approvals, 7);
  assert.equal(vscode.invocations.length, 6);
});

test('unverified tools are excluded even when selected and per-call approval would allow them', async () => {
  const vscode = api();
  const unsafe = { ...tool, name: 'execute_code' };
  vscode.lm.tools.push(unsafe);
  vscode.window.showQuickPick = async (items, options) => {
    assert.match(options.title, /verified are read-only/);
    assert.ok(items.every(item => item.picked === false));
    return [items[0]];
  };
  const verified = await verifyReadOnlyTools(vscode, [tool, unsafe]);
  assert.deepEqual(verified.map(tool => tool.name), [tool.name]);
  await assert.rejects(runVerifiedAgent(vscode, { prompt: 'Investigate' }, verified,
    async (conversation, tools) => {
      assert.deepEqual(tools.map(tool => tool.name), [tool.name]);
      return { toolCalls: [call(unsafe.name)] };
    }), /unselected tool/);
  assert.equal(vscode.invocations.length, 0);
  vscode.window.showQuickPick = async () => [];
  await assert.rejects(verifyReadOnlyTools(vscode, [tool]), /No tools were verified read-only/);
  vscode.window.showQuickPick = async () => undefined;
  assert.equal(await verifyReadOnlyTools(vscode, [tool]), undefined);
});

test('saved catalogs and confirmations cannot substitute for fresh read-only verification', async () => {
  const vscode = api();
  for (const tools of [[tool], JSON.parse(JSON.stringify([tool]))]) {
    await assert.rejects(runVerifiedAgent(vscode, { prompt: 'Task' }, tools,
      async () => { throw new Error('Must not send a model request'); }), /freshly verified read-only/);
  }
  const verified = await verifyReadOnlyTools(vscode, [tool]);
  await assert.rejects(runVerifiedAgent(vscode, { prompt: 'Task' }, structuredClone(verified),
    async () => ({})), /freshly verified read-only/);
  verified[0].description = 'Changed';
  await assert.rejects(runVerifiedAgent(vscode, { prompt: 'Task' }, verified,
    async () => ({})), /freshly verified read-only/);
  assert.equal(vscode.invocations.length, 0);
});

test('verified tools retain per-request consent and a non-overridable read-only policy', async () => {
  const vscode = api();
  let round = 0;
  vscode.window.showWarningMessage = async (message, options) => {
    assert.match(options.detail, /marked this tool read-only/);
    assert.match(options.detail, /Deny any request.*change shared state/);
    return 'Allow request';
  };
  await runToolAgent(vscode, { prompt: 'Read the task data' }, [tool],
    async () => ++round === 1 ? { toolCalls: [call()] } : { response: 'Done' });
  assert.equal(vscode.invocations.length, 1);
  assert.match(AGENT_PROMPT, /Guides describe usage, not verified facts/);
  assert.match(AGENT_PROMPT, /Never request mutations/);
});

test('requires approval for every invocation and respects cancellation', async () => {
  const vscode = api();
  vscode.window.showWarningMessage = async () => undefined;
  await assert.rejects(runToolAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => ({ toolCalls: [call()] })), vscode.CancellationError);
  const source = new vscode.CancellationTokenSource();
  source.cancel();
  await assert.rejects(runToolAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => { throw new Error('Must not run'); }, source.token), vscode.CancellationError);
  assert.equal(vscode.invocations.length, 0);
});

test('tool errors, unsupported results and empty results still fail visibly', async () => {
  const vscode = api();
  const turn = async () => ({ toolCalls: [call()] });
  vscode.lm.invokeTool = async () => { throw new Error('Tool authentication failed'); };
  await assert.rejects(runToolAgent(vscode, { prompt: 'Investigate' }, [tool], turn), error => {
    assert.match(error.message, /Tool authentication failed/);
    assert.equal(error.partialResult.toolEvidence[0].isError, true);
    assert.match(error.partialResult.toolEvidence[0].content, /side effects may have occurred/);
    return true;
  });
  for (const content of [[], [{}], [new vscode.LanguageModelTextPart(' ')]]) {
    vscode.lm.invokeTool = async () => ({ content });
    await assert.rejects(runToolAgent(vscode, { prompt: 'Investigate' }, [tool], turn), /must return text|empty text/);
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
  vscode.lm.tools.push(events);
  vscode.lm.invokeTool = async (name, { input }) => {
    attempts.push({ name, input: structuredClone(input) });
    if (Object.hasOwn(input, 'limit')) throw new Error(rejection);
    return { content: [new vscode.LanguageModelTextPart('Verified query result')] };
  };
  let turn = 0;
  const progress = [];
  const result = await runToolAgent(vscode, { prompt: 'Investigate', model: 'test-model' }, [events, tool],
    async (conversation, tools) => {
      assert.deepEqual(tools, toolCatalog([events, tool]));
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
    }, undefined, message => progress.push(message));
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
  await assert.rejects(runToolAgent(vscode, { prompt: 'Investigate' }, [tool], async () => ({
    toolCalls: [{ ...call(), input: ++requests === 1 ? { query: 'service:api', limit: 10 } : { limit: 10, query: 'service:api' } }]
  })), /rejected the same arguments again after correction feedback: Invalid params/);
  assert.equal(requests, 2);
});

test('argument errors alone cannot qualify as incident evidence', async () => {
  const vscode = api();
  vscode.lm.invokeTool = async () => { throw new Error('MCP error -32602: Invalid arguments'); };
  let requests = 0;
  await assert.rejects(runToolAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => ++requests === 1 ? { toolCalls: [call()] } : { response: 'Unsupported conclusion' }),
  /did not obtain successful tool results/);
  assert.equal(requests, 2);
});

test('duplicate rejected calls in one batch receive feedback before repeat detection applies', async () => {
  const vscode = api();
  let requests = 0;
  vscode.lm.invokeTool = async (name, { input }) => {
    if (input.limit) return { isError: true, content: [new vscode.LanguageModelTextPart('MCP -32602: Invalid arguments')] };
    return { content: [new vscode.LanguageModelTextPart('Actual evidence')] };
  };
  const result = await runToolAgent(vscode, { prompt: 'Investigate' }, [tool], async conversation => {
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
  await assert.rejects(runToolAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => ({ toolCalls: [call()] })), /Permission denied/);
  const providerError = Object.assign(new Error('Model rejected its request'), { code: -32602 });
  await assert.rejects(runToolAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => { throw providerError; }), error => error === providerError);
  const source = new vscode.CancellationTokenSource();
  vscode.lm.invokeTool = async () => {
    source.cancel();
    throw Object.assign(new Error('Invalid params'), { code: -32602 });
  };
  await assert.rejects(runToolAgent(vscode, { prompt: 'Investigate' }, [tool],
    async () => ({ toolCalls: [call()] }), source.token), vscode.CancellationError);
});

test('investigations continue past six model requests until the model answers', async () => {
  const vscode = api();
  let requests = 0;
  const result = await runToolAgent(vscode, { prompt: 'Investigate' }, [tool],
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
  const result = await runToolAgent(vscode, { prompt: 'Investigate' }, [tool], async (messages, tools) => {
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
  const result = await runToolAgent(vscode, { prompt: 'Investigate' }, [tool], async (messages, tools) => {
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
  const result = await runToolAgent(vscode, { prompt: 'Investigate' }, [tool], async messages => {
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
    const result = await runToolAgent(vscode, { prompt: 'Investigate' }, [tool], async () =>
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
  const result = await runToolAgent(vscode, { prompt: 'Investigate' }, [tool], async (messages, tools) => {
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
    vscode.lm.tools = [queryTool];
    const input = { query: 'service:api', ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}) };
    let requests = 0;
    const result = await runToolAgent(vscode, { prompt: 'Investigate' }, [queryTool], async () =>
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
  const result = await runToolAgent(vscode, { prompt: 'Investigate' }, [tool], async (messages, tools, token) => {
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
  const result = await runToolAgent(vscode, { prompt: 'Investigate' }, [tool], async (messages, tools, token) => {
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
  const pending = runToolAgent(vscode, { prompt: 'Investigate' }, [tool], async (messages, tools, token) => {
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
  await assert.rejects(runToolAgent(vscode, { prompt: 'Investigate' }, [tool], async () => {
    parent.cancel();
    return { response: 'Must not be accepted' };
  }, parent.token), vscode.CancellationError);
});
