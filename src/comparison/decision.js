'use strict';
const { responseContent } = require('./response');
const { verificationMatches } = require('./verification');

function validateReviewSettings(review = {}) {
  if (review.decisionPolicy !== undefined && !['strict', 'best-supported'].includes(review.decisionPolicy)) {
    throw new Error('Unsupported review decision policy.');
  }
  if (review.resolveEvidence !== undefined && typeof review.resolveEvidence !== 'boolean') {
    throw new Error('Evidence resolution must be a boolean.');
  }
  return { checkOrder: review.checkOrder !== false,
    ...(review.decisionPolicy ? { decisionPolicy: review.decisionPolicy } : {}),
    ...(review.resolveEvidence !== undefined ? { resolveEvidence: review.resolveEvidence } : {}) };
}

function evaluateChecks(baseline, candidate, checks = {}) {
  const phrases = Array.isArray(checks.requiredPhrases) ? checks.requiredPhrases : [];
  const responses = { baseline: responseContent(baseline.response).toLowerCase(),
    candidate: responseContent(candidate.response).toLowerCase() };
  return phrases.filter(phrase => typeof phrase === 'string' && phrase.trim()).map(phrase => ({
    phrase, baseline: responses.baseline.includes(phrase.toLowerCase()),
    candidate: responses.candidate.includes(phrase.toLowerCase())
  }));
}

function assessmentDecision(assessment, { checks = [], fairness, effectivePromptChanged, limited = false, verificationInput,
  policy = assessment?.decisionPolicy } = {}) {
  if (!assessment) return { status: 'not-reviewed', preference: null, reasons: ['No completed quality review.'] };
  const winner = assessment.verdict;
  const reasons = [];
  const blocked = [];
  if (verificationInput?.verification) {
    if (!verificationMatches(assessment.verification, verificationInput)) blocked.push('Executable checks are missing or do not match these outputs and checker.');
    else if (['baseline', 'candidate'].includes(winner) && assessment.verification[winner].status !== 'passed') {
      blocked.push((winner === 'baseline' ? 'Baseline' : 'Candidate') + ' did not pass the selected executable checker.');
    }
  }
  if (effectivePromptChanged === false) blocked.push('The effective model instructions did not change; metadata edits do not establish a prompt improvement.');
  if (['baseline', 'candidate'].includes(winner)) {
    const failed = checks.filter(check => check[winner] !== true);
    if (failed.length) blocked.push((winner === 'baseline' ? 'Baseline' : 'Candidate') +
      ' failed required checks: ' + failed.map(check => JSON.stringify(check.phrase)).join(', ') + '.');
  }
  if (limited) blocked.push('The investigation retained incomplete or truncated evidence.');
  for (const warning of fairness?.warnings || []) {
    if (warning.severity === 'high') blocked.push(warning.message);
    else if (policy === 'best-supported') reasons.push('Comparability caution: ' + warning.message);
  }
  if (!['baseline', 'candidate'].includes(winner) || assessment.preferenceEstablished === false) {
    reasons.push('The evaluator did not establish a preference; retaining the baseline is not a win.');
  }
  if (assessment.orderConsistent !== true) reasons.push(assessment.orderConsistent === false
    ? 'The evaluator disagreed when response order was reversed.' : 'Response-order consistency was not checked.');
  const criteria = assessment.criteria || [];
  const grounded = criteria.find(item => item.criterion === 'grounding')?.verdict;
  if (!grounded || grounded === 'insufficient_evidence') {
    const judgments = assessment.judgments || [];
    const disagreement = new Set(judgments.map(judgment =>
      judgment.criteria?.find(item => item.criterion === 'grounding')?.verdict).filter(Boolean)).size > 1;
    reasons.push(disagreement ? 'Grounding judgment changed when response order was reversed; no stable grounding preference was established.'
      : 'Grounding is unsupported by the supplied evidence.');
  }
  const supported = criteria.some(item => ['grounding', 'reasoning', 'completeness', 'actionability', 'uncertainty'].includes(item.criterion) &&
      item.verdict === winner);
  if (!supported) reasons.push('No substantive criterion supports the suggested preference.');
  if (assessment.resolution?.status === 'failed') reasons.push('The evidence-resolution round failed: ' + assessment.resolution.error);
  if (assessment.resolution?.status === 'completed') reasons.push('The follow-up adjudication was not independently checked in reversed order; this pick remains provisional.');
  if (assessment.resolution?.evidenceStatus === 'unavailable') reasons.push('No additional tool evidence was available; the pick uses the existing sources and any executable checks.');
  if (['baseline', 'candidate'].includes(winner) && criteria.some(item => ['grounding', 'actionability'].includes(item.criterion) &&
      ['baseline', 'candidate'].includes(item.verdict) && item.verdict !== winner)) {
    blocked.push('Grounding or actionability favors the other output; resolve that regression before adoption.');
  }
  const provisional = policy === 'best-supported' && supported &&
    ['baseline', 'candidate'].includes(winner) && assessment.preferenceEstablished !== false;
  const preference = !blocked.length && (!reasons.length || provisional) ? winner : null;
  return { status: blocked.length ? 'blocked' : preference ? reasons.length ? 'provisional' : 'preferred' : 'inconclusive',
    preference, confidence: preference ? reasons.length ? 'low' : 'medium' : 'none',
    reasons: [...new Set([...blocked, ...reasons])] };
}

function pairDecision(plan, pair) {
  const checks = evaluateChecks(pair.baseline.result || {}, pair.candidate.result || {}, plan.checks);
  if (pair.evaluationStatus !== 'succeeded') return { ...assessmentDecision(null), checks };
  const original = plan.requests?.baseline;
  const edited = plan.requests?.candidate;
  return { ...assessmentDecision(pair.evaluation, {
    checks,
    policy: plan.review?.decisionPolicy || 'strict',
    verificationInput: { verification: plan.verification, baseline: pair.baseline.result, candidate: pair.candidate.result },
    fairness: pair.fairness,
    effectivePromptChanged: plan.comparisonKind === 'prompt' && original && edited
      ? original.prompt !== edited.prompt || (original.systemPrompt || '') !== (edited.systemPrompt || '') : undefined,
    limited: ['baseline', 'candidate'].some(side => pair[side].result?.investigationBudget?.limited ||
      pair[side].result?.toolEvidence?.some(item => item.truncated))
  }), checks };
}

function comparisonDecision(result) {
  return assessmentDecision(result.evaluation, { checks: result.checks, fairness: result.fairness,
    policy: result.review?.decisionPolicy || 'strict',
    verificationInput: result,
    effectivePromptChanged: result.promptComparison?.effectiveChanged });
}

module.exports = { evaluateChecks, assessmentDecision, pairDecision, comparisonDecision, validateReviewSettings };
