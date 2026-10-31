'use strict';

const MAX_EVENTS = 512;
const MAX_CONTENT = 16000;
const MAX_TOTAL_CONTENT = 1000000;
const MAX_TRACE_BYTES = 16 * 1024 * 1024;
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const kinds = new Set(['context', 'model', 'tool', 'session']);
const outcomes = new Set(['Captured', 'Correction', 'Started', 'Returned', 'Failed', 'Cancelled',
  'Requested', 'BudgetExceeded', 'Denied', 'Malformed', 'Unavailable']);

function validateTrace(trace) {
  if (trace === null || trace === undefined) return null;
  const validString = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
  if (trace.schemaVersion !== 1 || !validString(trace.id) || !validString(trace.runId) ||
      !Number.isSafeInteger(trace.attempt) || trace.attempt < 0 ||
      !['Processing', 'Completed', 'Failed', 'Cancelled'].includes(trace.outcome) ||
      !['complete', 'partial', 'unavailable'].includes(trace.captureCompleteness) ||
      typeof trace.contentSnapshotsEnabled !== 'boolean' ||
      !Array.isArray(trace.events) || trace.events.length > MAX_EVENTS ||
      Buffer.byteLength(JSON.stringify(trace), 'utf8') > MAX_TRACE_BYTES) {
    throw new Error('Unsupported or invalid CodeMind execution trace');
  }
  let sequence = 0;
  let characters = 0;
  const ids = new Set();
  for (const event of trace.events) {
    if (!event || !Number.isSafeInteger(event.sequence) || event.sequence <= sequence ||
        !validString(event.id) || ids.has(event.id) || !validString(event.operationId) ||
        !kinds.has(event.kind) || !outcomes.has(event.outcome) || !Array.isArray(event.content) || event.content.length > 10) {
      throw new Error('Invalid CodeMind trace event');
    }
    ids.add(event.id);
    sequence = event.sequence;
    for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'maxOutputTokens', 'contextWindowTokens']) {
      if (event[key] !== null && event[key] !== undefined &&
          (!Number.isSafeInteger(event[key]) || event[key] < 0 || event[key] > 2147483647)) throw new Error('Invalid CodeMind trace token usage');
    }
    for (const content of event.content) {
      if (!content || !validString(content.kind) || typeof content.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(content.sha256) ||
          !Number.isSafeInteger(content.originalCharacters) || content.originalCharacters < 0 ||
          typeof content.redacted !== 'boolean' || typeof content.truncated !== 'boolean' ||
          (content.text !== null && (typeof content.text !== 'string' || content.text.length > MAX_CONTENT))) {
        throw new Error('Invalid CodeMind trace content snapshot');
      }
      characters += content.text?.length ?? 0;
      if (characters > MAX_TOTAL_CONTENT || (!trace.contentSnapshotsEnabled && content.text !== null)) {
        throw new Error('CodeMind trace exceeds its content retention policy');
      }
    }
  }
  return structuredClone(trace);
}

function summarizeTrace(trace) {
  if (!trace) return null;
  const starts = trace.events.filter(event => event.kind === 'model' && event.outcome === 'Started');
  const returned = trace.events.filter(event => event.kind === 'model' && event.outcome === 'Returned');
  const tools = trace.events.filter(event => event.kind === 'tool');
  const requested = tools.filter(event => event.outcome === 'Requested');
  const executed = tools.filter(event => event.outcome === 'Started');
  const knownInputTokens = returned.reduce((total, event) => total + (event.inputTokens ?? 0), 0);
  const knownOutputTokens = returned.reduce((total, event) => total + (event.outputTokens ?? 0), 0);
  const missingUsageCalls = starts.filter(start => !returned.some(event =>
    event.operationId === start.operationId && event.inputTokens !== null && event.inputTokens !== undefined &&
    event.outputTokens !== null && event.outputTokens !== undefined)).length;
  const contents = trace.events.flatMap(event => event.content);
  const warnings = [];
  if (trace.events.some(event => event.metadataTruncated || event.metadataRedacted)) warnings.push('Some metadata labels were redacted or truncated.');
  if (starts.some(event => event.temperature == null || event.maxOutputTokens == null)) warnings.push('Some effective sampling/output settings are unknown provider defaults.');
  if (trace.captureCompleteness !== 'complete') warnings.push('Execution capture is ' + trace.captureCompleteness + '; events or outcomes may be missing.');
  if (trace.outcome !== 'Completed') warnings.push('Attempt outcome is ' + trace.outcome + '; a saved answer does not establish a successful run.');
  if (!trace.contentSnapshotsEnabled || contents.some(content => content.text === null)) warnings.push('Content snapshots are unavailable; hashes cannot reconstruct the context.');
  if (contents.some(content => content.redacted)) warnings.push('Snapshots contain redactions and are not an exact replay of the original context.');
  if (contents.some(content => content.truncated)) warnings.push('Snapshots were truncated by retention limits; context is incomplete.');
  if (missingUsageCalls) warnings.push(missingUsageCalls + ' model request(s) lack complete provider usage; displayed known totals are partial, not billed totals.');
  if (trace.events.some((event, index) => event.sequence !== index + 1)) warnings.push('The event sequence has gaps.');
  const incompleteTools = requested.filter(request => !tools.some(event => event.operationId === request.operationId &&
    ['Returned', 'Failed', 'Cancelled', 'Denied', 'Malformed', 'BudgetExceeded'].includes(event.outcome))).length;
  if (incompleteTools) warnings.push(incompleteTools + ' requested tool call(s) have no recorded terminal outcome.');
  return {
    modelCalls: starts.length, returnedModelCalls: returned.length, missingUsageCalls,
    knownInputTokens, knownOutputTokens,
    inputTokens: missingUsageCalls || !starts.length || trace.captureCompleteness !== 'complete' ? null : knownInputTokens,
    outputTokens: missingUsageCalls || !starts.length || trace.captureCompleteness !== 'complete' ? null : knownOutputTokens,
    requestedTools: requested.length, executedTools: executed.length,
    failedTools: tools.filter(event => ['Failed', 'Cancelled'].includes(event.outcome)).length,
    rejectedTools: tools.filter(event => ['Denied', 'Malformed', 'BudgetExceeded'].includes(event.outcome)).length,
    corrections: trace.events.filter(event => event.outcome === 'Correction').length,
    reportedModels: [...new Set(returned.map(event => event.reportedModel).filter(Boolean))],
    warnings
  };
}

function importRun(input, existing = {}, side = 'baseline') {
  if (input?.kind !== 'codemind-agent-run') return input;
  if (input.schemaVersion !== 1 || !input.variant || !['baseline', 'candidate'].includes(side)) {
    throw new Error('Unsupported CodeMind run export');
  }
  const trace = validateTrace(input.variant.executionTrace);
  if (!trace || input.variant.runId !== trace.runId) throw new Error('CodeMind run and trace identities do not match');
  return { ...existing, comparisonMode: existing.comparisonMode || 'end-to-end',
    [side]: { ...input.variant, provider: 'manual', executionTrace: trace } };
}

function traceDifferences(a, b) {
  const signature = (trace, kinds) => JSON.stringify(trace.events.flatMap(event => event.content)
    .filter(content => kinds.includes(content.kind)).map(content => [content.kind, content.sha256]));
  const differences = [];
  const toolChoices = trace => JSON.stringify(trace.events.filter(event => event.kind === 'tool' && event.outcome === 'Requested')
    .map(event => [event.name, event.server, event.serverVersion]));
  const settings = trace => JSON.stringify([...new Set(trace.events.filter(event => event.kind === 'model' && event.outcome === 'Started')
    .map(event => JSON.stringify([event.temperature ?? null, event.maxOutputTokens ?? null,
      event.contextWindowTokens ?? null, event.contextWindowSource])))].sort());
  if (signature(a, ['system-message', 'user-message', 'retrieved-context']) !== signature(b, ['system-message', 'user-message', 'retrieved-context'])) {
    differences.push('Effective prompts or retrieved context differ between recorded attempts.');
  }
  if (signature(a, ['tool-definitions']) !== signature(b, ['tool-definitions'])) differences.push('Exposed tool definitions or server identities differ.');
  if (toolChoices(a) !== toolChoices(b) ||
      signature(a, ['tool-arguments', 'tool-result']) !== signature(b, ['tool-arguments', 'tool-result'])) differences.push('Tool choices, arguments or returned evidence differ.');
  if (settings(a) !== settings(b)) differences.push('Recorded model request settings differ.');
  return differences;
}

module.exports = { validateTrace, summarizeTrace, importRun, traceDifferences, MAX_IMPORT_BYTES };
