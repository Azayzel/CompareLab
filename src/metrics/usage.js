'use strict';

const prices = require('./azure-prices');
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'estimatedInputTokens', 'estimatedOutputTokens'];
const count = value => Number.isSafeInteger(value) && value >= 0;
const money = value => value == null ? 'Unknown' : '$' + value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
const tokenText = (actual, estimated) => actual != null ? actual.toLocaleString('en-US')
  : estimated != null ? '~' + estimated.toLocaleString('en-US') : 'Unknown';
const COST_NOTE = 'Azure-equivalent estimate, not Copilot or Azure billed cost. USD Global Standard pay-as-you-go; public rates checked ' +
  prices.checkedAt + '. All input is priced as uncached. Cache discounts/writes, unreported reasoning, tools, taxes and negotiated rates are not modeled. ' +
  'Short/long-context figures are separate pricing scenarios, not a billing range; no unverified cutoff is assumed. Evaluator usage is separate. ' +
  'Failed/cancelled requests may consume usage that is not retained.';

function validateUsageTurns(turns) {
  if (turns == null) return null;
  if (!Array.isArray(turns) || turns.some(turn => !turn || typeof turn.model !== 'string' || !turn.model ||
      turn.model.length > 1000 || TOKEN_FIELDS.some(key => turn[key] != null && !count(turn[key])))) {
    throw new Error('Invalid per-turn token usage.');
  }
  return turns.map(turn => ({ model: turn.model, ...Object.fromEntries(TOKEN_FIELDS.map(key => [key, turn[key] ?? null])) }));
}

function usageTurn(result, fallbackModel = 'Unknown') {
  return validateUsageTurns([{ ...result, model: result.reportedModel || result.model || fallbackModel }])[0];
}

function estimateTurn(turn) {
  const rates = Object.hasOwn(prices.models, turn.model) ? prices.models[turn.model] : null;
  const input = turn.inputTokens ?? turn.estimatedInputTokens;
  const output = turn.outputTokens ?? turn.estimatedOutputTokens;
  if (!rates) return { reason: 'No verified exact Azure model match.', shortUsd: null, longUsd: null };
  if (!count(input) || !count(output)) return { reason: 'Input or output token count unavailable.', shortUsd: null, longUsd: null };
  return {
    shortUsd: (input * rates[0] + output * rates[1]) / 1000000,
    longUsd: (input * (rates[2] ?? rates[0]) + output * (rates[3] ?? rates[1])) / 1000000,
    reason: (turn.inputTokens == null || turn.outputTokens == null ? 'Model-counted tokens. ' : 'Provider-reported tokens. ') +
      'USD/1M in/out: ' + rates[0] + '/' + rates[1] + (rates.length === 4 ? ' short; ' + rates[2] + '/' + rates[3] + ' long.' : '. Single published tier.')
  };
}

function usageReport(turns = [], { missingRuns = false } = {}) {
  validateUsageTurns(turns);
  const estimates = turns.map(estimateTurn);
  const complete = !missingRuns && turns.length > 0 && estimates.every(item => item.shortUsd != null && item.longUsd != null);
  const shortUsd = complete ? estimates.reduce((total, item) => total + item.shortUsd, 0) : null;
  const longUsd = complete ? estimates.reduce((total, item) => total + item.longUsd, 0) : null;
  return {
    shortUsd, longUsd, complete, note: COST_NOTE, source: prices.pricingPage,
    total: complete ? money(shortUsd) + (shortUsd !== longUsd ? ' / ' + money(longUsd) : '') : 'Unknown',
    hint: missingRuns ? 'Some runs lack per-turn usage; recorded turns are shown below.'
      : !turns.length ? 'No per-turn usage recorded (older or imported run).'
      : !complete ? 'Some turns lack verified rates or token counts; no complete total.'
        : shortUsd !== longUsd ? 'USD: short / long-context scenarios' : 'USD: standard text-token estimate',
    rows: turns.map((turn, index) => ({
      label: turn.run ? 'Run ' + turn.run + ' / Turn ' + turn.turn : 'Turn ' + (index + 1),
      model: turn.model, input: tokenText(turn.inputTokens, turn.estimatedInputTokens),
      output: tokenText(turn.outputTokens, turn.estimatedOutputTokens),
      short: money(estimates[index].shortUsd), long: money(estimates[index].longUsd), note: estimates[index].reason
    }))
  };
}

function activity(result, live) {
  const messages = result.requestMessages;
  const inferredRequests = Array.isArray(messages) && messages.length &&
    messages.every(message => message && ['system', 'user', 'assistant', 'tool'].includes(message.role))
    ? messages.filter(message => message.role === 'assistant').length + 1 : null;
  return {
    modelRequestCount: result.modelRequestCount ?? (result.usageTurns?.length || null) ?? result.investigationBudget?.modelRequests ??
      (live ? inferredRequests : 1),
    toolCallCount: result.toolCallCount ?? (Array.isArray(result.toolEvidence) ? result.toolEvidence.length : live ? null : 0)
  };
}

function efficiencyMetrics(metrics, repetitions) {
  const a = metrics.baseline;
  const b = metrics.candidate;
  const complete = a.succeeded === repetitions && b.succeeded === repetitions;
  return ['input', 'output', 'time'].map(kind => {
    let left;
    let right;
    let estimated = false;
    let reason = 'Requires all planned runs to succeed on both sides.';
    if (complete) {
      if (kind === 'time') {
        left = a.medianLatencyMs; right = b.medianLatencyMs;
        reason = 'Paired timing unavailable.';
      } else {
        const key = kind + 'Tokens';
        const estimate = 'estimated' + kind[0].toUpperCase() + kind.slice(1) + 'Tokens';
        if (a[key] != null && b[key] != null) { left = a[key]; right = b[key]; }
        else if (a[key] == null && b[key] == null) { left = a[estimate]; right = b[estimate]; estimated = true; }
        reason = 'Token counts unavailable or usage sources differ.';
      }
    }
    const valid = Number.isFinite(left) && Number.isFinite(right) && left > 0;
    return {
      label: kind === 'time' ? 'Median investigation time' : kind === 'input' ? 'Input tokens' : 'Output tokens',
      value: valid ? (estimated ? '~' : '') + (right / left).toFixed(2) + 'x baseline' : 'Not comparable',
      hint: valid ? 'Candidate / baseline' : left === 0 ? 'Baseline is zero; ratio is undefined.' : reason
    };
  });
}

module.exports = { usageTurn, validateUsageTurns, estimateTurn, usageReport, activity, efficiencyMetrics, TOKEN_FIELDS };
