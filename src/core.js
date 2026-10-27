'use strict';

/**
 * Shared, dependency-free engine for the VS Code extension and CLI.
 * Comparison is descriptive, not an AI quality score.
 */
const MAX_MATRIX_CELLS = 65000;

function words(value) {
  return String(value ?? '').match(/\s+|[^\s]+/g) || [];
}

function normalize(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function countWords(value) {
  const m = normalize(value).match(/\S+/g);
  return m ? m.length : 0;
}

function diffText(left, right) {
  const a = words(left);
  const b = words(right);
  if (a.join('') === b.join('')) {
    return [{ type: 'equal', text: a.join('') }];
  }
  if (!a.length) return [{ type: 'add', text: b.join('') }];
  if (!b.length) return [{ type: 'remove', text: a.join('') }];
  if (a.length * b.length > MAX_MATRIX_CELLS) {
    return [
      { type: 'remove', text: a.join('') },
      { type: 'add', text: b.join('') }
    ];
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const spans = [];
  const emit = (type, text) => {
    if (!text) return;
    const last = spans[spans.length - 1];
    if (last && last.type === type) last.text += text;
    else spans.push({ type, text });
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      emit('equal', a[i++]); j++;
    } else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) {
      emit('add', b[j++]);
    } else {
      emit('remove', a[i++]);
    }
  }
  return spans;
}

function intOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function describeVariant(input = {}) {
  return {
    model: String(input.model || 'Unspecified model'),
    reportedModel: input.reportedModel ? String(input.reportedModel) : null,
    modelVersion: input.modelVersion ? String(input.modelVersion) : null,
    provider: input.provider ? String(input.provider) : null,
    prompt: String(input.prompt ?? ''),
    response: String(input.response ?? ''),
    contextWindowTokens: intOrNull(input.contextWindowTokens),
    contextWindowSource: String(input.contextWindowSource || 'unverified'),
    inputTokens: intOrNull(input.inputTokens),
    outputTokens: intOrNull(input.outputTokens),
    maxOutputTokens: intOrNull(input.maxOutputTokens),
    finishReason: input.finishReason ? String(input.finishReason) : null,
    temperature: input.temperature === '' || input.temperature === undefined || input.temperature === null
      ? null : Number(input.temperature),
    runId: input.runId ? String(input.runId) : null
  };
}

function assessFairness(a, b) {
  const warnings = [];
  const unknowns = [];
  const add = (code, message, severity = 'caution') => warnings.push({ code, message, severity });
  for (const [name, v] of [['Baseline', a], ['Candidate', b]]) {
    if (!v.contextWindowTokens || v.contextWindowSource === 'unverified') {
      unknowns.push(name + ' context-window capacity is unverified');
    }
    if (v.inputTokens === null || v.outputTokens === null) {
      unknowns.push(name + ' actual token usage is incomplete');
    }
    if (!v.reportedModel && !v.modelVersion) {
      unknowns.push(name + ' resolved model snapshot/version is not recorded');
    }
    if (['length', 'max_tokens', 'max_output_tokens', 'truncated'].includes((v.finishReason || '').toLowerCase())) {
      add('truncated', name + ' finished at a token limit; the output may be incomplete', 'high');
    }
    if (v.maxOutputTokens !== null && v.outputTokens !== null && v.outputTokens >= v.maxOutputTokens) {
      add('output-cap', name + ' reached its configured maximum output tokens');
    }
    if (v.contextWindowTokens && v.inputTokens !== null && v.outputTokens !== null &&
        v.inputTokens + v.outputTokens > v.contextWindowTokens) {
      add('context-overrun', name + ' token usage exceeds its recorded context window', 'high');
    }
  }
  if (a.prompt !== b.prompt) {
    add('prompt-variation', 'The prompts differ; do not attribute the result solely to model differences');
  }
  if (a.contextWindowTokens && b.contextWindowTokens && a.contextWindowTokens !== b.contextWindowTokens) {
    add('context-difference', 'The models have different maximum context windows; inspect actual input and truncation before interpreting the comparison');
  }
  if (a.maxOutputTokens !== null && b.maxOutputTokens !== null && a.maxOutputTokens !== b.maxOutputTokens) {
    add('output-budget-difference', 'The output token caps differ');
  }
  if (a.temperature !== null && b.temperature !== null && a.temperature !== b.temperature) {
    add('temperature-difference', 'Sampling temperatures differ (their semantics can also vary across providers)');
  }
  const limited = warnings.some(w => w.severity === 'high');
  return {
    status: limited ? 'limited' : (warnings.length ? 'caution' : unknowns.length ? 'unverified' : 'comparable'),
    warnings, unknowns,
    note: 'Context-window size alone does not make a result fair. Unknown tool, system, retrieval, and hidden token overhead can affect actual effective context. This assessment is not a quality grade.'
  };
}

function evaluateChecks(a, b, checks = {}) {
  const phrases = Array.isArray(checks.requiredPhrases) ? checks.requiredPhrases : [];
  return phrases.filter(p => typeof p === 'string' && p.trim()).map(phrase => ({
    phrase,
    baseline: a.response.toLowerCase().includes(phrase.toLowerCase()),
    candidate: b.response.toLowerCase().includes(phrase.toLowerCase())
  }));
}

function compare(input) {
  if (!input || typeof input !== 'object') throw new TypeError('Experiment must be an object');
  const baseline = describeVariant({ ...input.baseline, prompt: input.baseline?.prompt ?? input.prompt ?? '' });
  const candidate = describeVariant({ ...input.candidate, prompt: input.candidate?.prompt ?? input.prompt ?? '' });
  const spans = diffText(baseline.response, candidate.response);
  return {
    schemaVersion: 1,
    baseline, candidate,
    spans,
    measures: {
      baselineWords: countWords(baseline.response),
      candidateWords: countWords(candidate.response),
      changedWordDelta: countWords(candidate.response) - countWords(baseline.response),
      interpretation: 'Text counts and diffs measure change, not correctness or quality.'
    },
    fairness: assessFairness(baseline, candidate),
    checks: evaluateChecks(baseline, candidate, input.checks || {})
  };
}

function asMarkdown(result) {
  const r = result;
  const lines = [
    '# CompareLab report', '',
    '| | Baseline | Candidate |', '|---|---|---|',
    '| Model | ' + escapeMd(r.baseline.model) + ' | ' + escapeMd(r.candidate.model) + ' |',
    '| Provider model | ' + escapeMd(r.baseline.reportedModel || 'Unverified') + ' | ' + escapeMd(r.candidate.reportedModel || 'Unverified') + ' |',
    '| Context window (tokens) | ' + (r.baseline.contextWindowTokens ?? 'Unknown') + ' | ' + (r.candidate.contextWindowTokens ?? 'Unknown') + ' |',
    '| Context source | ' + escapeMd(r.baseline.contextWindowSource) + ' | ' + escapeMd(r.candidate.contextWindowSource) + ' |',
    '| Input tokens | ' + (r.baseline.inputTokens ?? 'Unknown') + ' | ' + (r.candidate.inputTokens ?? 'Unknown') + ' |',
    '| Output tokens | ' + (r.baseline.outputTokens ?? 'Unknown') + ' | ' + (r.candidate.outputTokens ?? 'Unknown') + ' |',
    '| Output cap | ' + (r.baseline.maxOutputTokens ?? 'Unknown') + ' | ' + (r.candidate.maxOutputTokens ?? 'Unknown') + ' |',
    '| Finish reason | ' + escapeMd(r.baseline.finishReason || 'Unknown') + ' | ' + escapeMd(r.candidate.finishReason || 'Unknown') + ' |',
    '| Word count | ' + r.measures.baselineWords + ' | ' + r.measures.candidateWords + ' |', '',
    '## Comparison confidence', '', '**' + r.fairness.status + '**', ''
  ];
  for (const w of r.fairness.warnings) lines.push('- ' + w.message);
  for (const u of r.fairness.unknowns) lines.push('- Unknown: ' + u);
  lines.push('', r.fairness.note, '', '## Deterministic phrase checks', '');
  if (!r.checks.length) lines.push('No checks configured.');
  else for (const c of r.checks) lines.push('- ' + JSON.stringify(c.phrase) + ': baseline ' + (c.baseline ? 'PASS' : 'FAIL') + ', candidate ' + (c.candidate ? 'PASS' : 'FAIL'));
  lines.push('', '## Responses', '', '### Baseline', '', '~~~text', r.baseline.response, '~~~', '', '### Candidate', '', '~~~text', r.candidate.response, '~~~', '');
  return lines.join('\n');
}

function escapeMd(s) { return String(s).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' '); }

module.exports = { compare, diffText, assessFairness, describeVariant, asMarkdown };
