'use strict';
const { verificationMatches } = require('./verification');

async function resolveReview(input, { evaluate, collectEvidence, verify, onVerification = () => {},
  progress = () => {}, cancelled = () => false }) {
  const started = Date.now();
  let packet = { ...input };
  let verification;
  if (input.verification) {
    progress('Running the selected checker against both frozen outputs in isolated containers.');
    verification = await verify(input);
    if (!verificationMatches(verification, input)) throw new Error('Executable check results do not match these outputs and checker.');
    onVerification(verification);
    packet.verificationResults = verification;
  }
  let initial;
  try { initial = await evaluate(packet); }
  catch (error) {
    if (verification) error.partialVerification = verification;
    throw error;
  }
  const finish = assessment => ({ ...assessment, ...(verification ? { verification } : {}),
    ...(input.review?.decisionPolicy ? { decisionPolicy: input.review.decisionPolicy } : {}),
    elapsedMs: Date.now() - started });
  const disputed = initial.criteria.filter(item => item.verdict === 'insufficient_evidence' ||
    initial.judgments.some(judgment => judgment.criteria.find(other => other.criterion === item.criterion)?.verdict !== item.verdict));
  const needed = initial.orderConsistent === false || disputed.length > 0 || initial.preferenceEstablished === false;
  if (input.review?.resolveEvidence !== true || !needed) return finish(initial);
  const resolution = { status: 'running', initial, evidence: '', evidenceStatus: 'not-requested', collection: null };
  const disputes = disputed.map(item => ({
    criterion: item.criterion,
    observations: initial.judgments.map(judgment => {
      const observed = judgment.criteria.find(other => other.criterion === item.criterion);
      return { verdict: ({ baseline: 'A', candidate: 'B' })[observed?.verdict] || observed?.verdict,
        rationale: observed?.rationale };
    })
  }));
  try {
    if (collectEvidence) {
      progress('Resolution round 1/1: gathering evidence for the disputed claims.');
      const collected = await collectEvidence(packet, disputes);
      resolution.collection = collected.collection;
      if (typeof collected.evidence !== 'string' || Buffer.byteLength(collected.evidence) > 131072) {
        throw new Error('Resolution evidence exceeds the 128 KiB limit; no evidence was silently truncated.');
      }
      resolution.evidence = collected.evidence;
      resolution.evidenceStatus = 'collected';
    } else {
      resolution.evidenceStatus = 'unavailable';
      progress('No read-only evidence tools selected. Adjudicating the existing contract, outputs and any checker observations.');
    }
    packet = { ...packet, resolutionEvidence: resolution.evidence, disputes,
      review: { ...input.review, checkOrder: false, resolveEvidence: false } };
    progress('Resolution round 1/1: adjudicating concrete differences, not majority voting.');
    const final = await evaluate(packet);
    resolution.status = 'completed';
    resolution.assessment = final;
    return finish({ ...final, inputFingerprint: initial.inputFingerprint, resolution,
      orderConsistent: initial.orderConsistent, judgments: initial.judgments,
      requestCount: initial.requestCount + final.requestCount + (resolution.collection?.modelRequestCount || 0),
      citationRepairs: initial.citationRepairs + final.citationRepairs,
      inputTokenEstimates: [...initial.inputTokenEstimates, ...final.inputTokenEstimates],
      usageTurns: [...initial.usageTurns, ...(resolution.collection?.usageTurns || []), ...final.usageTurns],
      unknowns: [...new Set([...final.unknowns,
        ...(initial.orderConsistent === false ? ['The original response-order reviews disagreed; this adjudicated pick remains provisional.'] : []),
        ...(resolution.evidenceStatus === 'unavailable' ? ['No additional read-only tool evidence was available for adjudication.'] : [])])] });
  } catch (error) {
    if (cancelled(error)) {
      if (verification) error.partialVerification = verification;
      throw error;
    }
    resolution.status = 'failed';
    const message = String(error.message || error);
    resolution.error = message.length > 2000 ? message.slice(0, 2000) + ' [error message truncated]' : message;
    if (error.partialResult) resolution.collection = error.partialResult;
    progress('Evidence resolution failed: ' + resolution.error + ' The initial review is retained, with this failure visible.');
    return finish({ ...initial, resolution,
      requestCount: initial.requestCount + (resolution.collection?.modelRequestCount || 0),
      usageTurns: [...initial.usageTurns, ...(resolution.collection?.usageTurns || [])],
      unknowns: [...initial.unknowns, 'Evidence resolution failed: ' + resolution.error] });
  }
}

module.exports = { resolveReview };
