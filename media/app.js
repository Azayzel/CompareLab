(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let revision = 0;
  let busy = false;
  let testRun = null;
  const runMetadata = { a: {}, b: {} };
  const fields = ['model','prompt','response','provider','endpoint','tokenLimitField','reportedModel','modelVersion','contextWindowTokens','contextWindowSource','inputTokens','outputTokens','maxOutputTokens','finishReason','temperature'];
  const side = prefix => {
    const out = { ...runMetadata[prefix] };
    for (const key of fields) {
      const element = $(prefix + '-' + key);
      if (element && element.value !== '' && (key !== 'prompt' || element.value.trim())) out[key] = element.value;
    }
    return out;
  };
  const experiment = () => ({
    comparisonMode: $('comparisonMode').value || 'end-to-end',
    prompt: $('prompt').value, incomingMessage: $('incomingMessage').value, evidence: $('evidence').value, baseline: side('a'), candidate: side('b'),
    review: { checkOrder: $('checkOrder').checked },
    test: { repetitions: Number($('testRepetitions').value || 3) }, testRun,
    checks: { requiredPhrases: $('checks').value.split(',').map(x => x.trim()).filter(Boolean) }
  });
  const save = () => vscode.setState(experiment());
  const post = (type, extra = {}) => {
    save();
    vscode.postMessage({ type, experiment: experiment(), revision, ...extra });
  };
  const fill = (id, value) => { if ($(id)) $(id).value = value ?? ''; };
  function restore(data) {
    if (!data || typeof data !== 'object') return;
    fill('prompt', data.prompt);
    fill('incomingMessage', data.incomingMessage);
    fill('evidence', data.evidence);
    fill('comparisonMode', data.comparisonMode || 'end-to-end');
    $('checkOrder').checked = data.review?.checkOrder !== false;
    fill('testRepetitions', data.test?.repetitions ?? 3);
    const defaults = { provider: 'vscode', tokenLimitField: 'max_completion_tokens', contextWindowSource: 'unverified' };
    for (const [prefix, variant] of [['a', data.baseline], ['b', data.candidate]]) {
      for (const key of fields) fill(prefix + '-' + key, variant?.[key] ?? defaults[key] ?? '');
      runMetadata[prefix] = { elapsedMs: variant?.elapsedMs ?? null, runId: variant?.runId ?? null,
        modelVendor: variant?.modelVendor, estimatedInputTokens: variant?.estimatedInputTokens ?? null,
        responseRedacted: variant?.responseRedacted === true, responseTruncated: variant?.responseTruncated === true,
        executionTrace: variant?.executionTrace ?? null };
    }
    fill('checks', Array.isArray(data.checks?.requiredPhrases) ? data.checks.requiredPhrases.filter(value => typeof value === 'string').join(', ') : '');
    invalidate();
    testRun = data.testRun ?? null;
    if (testRun) renderTest(testRun);
    for (const side of ['a', 'b']) updateRunner(side);
  }
  function make(tag, text, className) {
    const el = document.createElement(tag);
    el.textContent = String(text);
    if (className) el.className = className;
    return el;
  }
  function updateRunner(side) {
    const provider = $(side + '-provider').value;
    const openai = provider === 'openai';
    const editorModel = provider === 'vscode';
    $(side + '-selectModel').hidden = !editorModel;
    $(side + '-model').readOnly = editorModel;
    $(side + '-model').placeholder = editorModel ? 'Select a VS Code model' : 'Enter provider model ID';
    for (const key of ['endpoint', 'contextWindowTokens', 'contextWindowSource', 'temperature', 'maxOutputTokens']) {
      $(side + '-' + key).closest('label').hidden = editorModel;
    }
    $(side + '-key').hidden = !openai;
    $(side + '-tokenLimitField').closest('label').hidden = !openai;
    $(side + '-endpoint').placeholder = provider === 'ollama'
      ? 'http://127.0.0.1:11434'
      : 'https://api.openai.com/v1';
    $(side + '-run').disabled = busy || provider === 'manual';
    $('runBoth').disabled = busy || !(['a','b'].every(p => $(p + '-provider').value !== 'manual'));
    $('orchestrate').disabled = $('runBoth').disabled;
    const repetitions = Number($('testRepetitions').value || 3);
    $('testBudget').textContent = repetitions * 2 + ' generation requests; ' + repetitions * ($('checkOrder').checked ? 2 : 1) +
      ' review requests, plus up to ' + repetitions + ' citation corrections. Sequential, frozen-evidence runs.';
  }
  function invalidate() {
    revision++;
    $('results').hidden = true;
    $('evaluation').replaceChildren();
    $('reviewStatus').textContent = '';
    testRun = null;
    $('testResults').hidden = true;
  }

  function renderTest(record, summary) {
    const container = $('testResults');
    container.hidden = false;
    container.replaceChildren(make('h2', 'Orchestrated test'), make('p', 'Status: ' + record.status + ' | Paired runs: ' + record.pairs.length + '/' + record.plan.repetitions));
    const packet = make('details', '', 'result-details');
    packet.appendChild(make('summary', 'Frozen test input'));
    if (record.plan.systemPrompt) packet.append(make('h3', 'Agent instructions'), make('pre', record.plan.systemPrompt, 'response-content'));
    packet.append(make('h3', 'User message'), make('pre', record.plan.requestPrompt, 'response-content'));
    container.appendChild(packet);
    if (summary) {
      container.appendChild(make('h3', summary.preference === 'inconclusive' ? 'No stable task-specific preference' : 'Task-specific preference: ' + summary.preference, 'verdict'));
      container.appendChild(make('p', 'Supported pairs: baseline ' + summary.counts.baseline + ', candidate ' + summary.counts.candidate +
        ', unresolved ' + summary.counts.unresolved + ', incomplete ' + summary.counts.failed));
      for (const side of ['baseline', 'candidate']) {
        const metrics = summary.metrics[side];
        container.appendChild(make('p', side + ': ' + metrics.succeeded + '/' + metrics.attempted + ' generations succeeded | Median latency: ' +
          (metrics.medianLatencyMs ?? 'Unknown') + ' ms (' + metrics.latencySamples + ' paired samples) | Input / output tokens: ' +
          (metrics.inputTokens ?? 'Unknown') + ' / ' + (metrics.outputTokens ?? 'Unknown')));
      }
      container.appendChild(make('p', summary.note, 'notice'));
      for (const warning of summary.warnings) container.appendChild(make('p', warning, 'notice'));
    }
    for (const pair of record.pairs) {
      const detail = make('details', '', 'result-details');
      detail.appendChild(make('summary', 'Pair ' + pair.number + ' | ' + pair.order.join(' then ') + ' | Review: ' + pair.evaluationStatus));
      for (const side of ['baseline', 'candidate']) {
        detail.append(make('h3', side + ': ' + pair[side].status), make('pre', pair[side].result?.response || pair[side].error || '', 'response-content'));
        if (pair[side].result?.provider === 'vscode') detail.appendChild(make('p', 'VS Code input-token estimate: ' +
          (pair[side].result.estimatedInputTokens ?? 'Unknown') + '. Actual usage unavailable; instructions sent as user context.', 'notice'));
      }
      if (pair.evaluation) {
        detail.appendChild(make('p', pair.evaluation.summary, 'assessment-summary'));
        renderCriteria(detail, pair.evaluation.criteria);
      }
      if (pair.evaluationError) detail.appendChild(make('p', pair.evaluationError, 'notice'));
      for (const check of pair.checks) detail.appendChild(make('p', check.phrase + ': baseline ' + (check.baseline ? 'Pass' : 'Fail') + ', candidate ' + (check.candidate ? 'Pass' : 'Fail')));
      container.appendChild(detail);
    }
  }
  const verdictLabel = verdict => ({ baseline: 'Baseline better', candidate: 'Candidate better', tie: 'Tie',
    insufficient_evidence: 'Insufficient evidence' })[verdict] || 'Not evaluated';
  const criterionLabel = criterion => ({ grounding: 'Evidence grounding', reasoning: 'Diagnostic reasoning',
    completeness: 'Completeness', actionability: 'Actionability and safety', uncertainty: 'Uncertainty', clarity: 'Clarity' })[criterion] || criterion;
  function renderCriteria(container, criteria) {
    for (const item of criteria) {
      const row = make('div', '', 'criterion');
      const heading = make('div', '', 'criterion-heading');
      heading.append(make('h3', criterionLabel(item.criterion)), make('strong', verdictLabel(item.verdict)));
      row.append(heading, make('p', item.rationale));
      if (item.citations.length) {
        const quotes = make('details', '');
        quotes.appendChild(make('summary', 'Source quotes (' + item.citations.length + ')'));
        for (const citation of item.citations) {
          const quote = make('blockquote', '');
          const label = { baseline: 'Baseline', candidate: 'Candidate', evidence: 'Source evidence',
            baselineTask: 'Baseline task', candidateTask: 'Candidate task' }[citation.source] || citation.source;
          quote.append(make('strong', label), make('p', citation.quote));
          quotes.appendChild(quote);
        }
        row.appendChild(quotes);
      }
      container.appendChild(row);
    }
  }
  function renderEvaluation(assessment) {
    const container = $('evaluation');
    container.replaceChildren();
    if (!assessment) { container.appendChild(make('p', 'Not evaluated', 'notice')); return; }
    container.append(make('h3', assessment.verdict === 'baseline' ? 'Recommend Baseline'
      : assessment.verdict === 'candidate' ? 'Recommend Candidate' : verdictLabel(assessment.verdict), 'verdict'), make('p', assessment.summary, 'assessment-summary'));
    container.appendChild(make('p', 'Evaluator: ' + assessment.model.name + ' | Version: ' + assessment.model.version, 'notice'));
    const order = assessment.orderConsistent === null ? 'Not checked'
      : assessment.orderConsistent ? 'Same overall verdict in both orders' : 'Verdicts disagree';
    container.appendChild(make('p', 'Response-order check: ' + order, 'notice'));
    renderCriteria(container, assessment.criteria);
    if (assessment.unknowns.length) {
      container.appendChild(make('h3', 'Remaining unknowns'));
      const list = make('ul', '');
      for (const unknown of assessment.unknowns) list.appendChild(make('li', unknown));
      container.appendChild(list);
    }
    const audit = make('details', '', 'result-details');
    audit.appendChild(make('summary', 'Evaluator run details'));
    audit.appendChild(make('p', 'Elapsed: ' + assessment.elapsedMs + ' ms | Requests: ' + (assessment.requestCount ?? assessment.judgments.length) + ' | Citation repairs: ' + (assessment.citationRepairs ?? 0) + ' | Rubric: ' + assessment.rubricVersion));
    audit.appendChild(make('p', 'Estimated input tokens per request: ' + assessment.inputTokenEstimates.join(', ') + '. Actual token usage and cost are unavailable from this API.', 'notice'));
    for (const [index, judgment] of assessment.judgments.entries()) {
      const pass = make('details', '');
      pass.append(make('summary', (index === 0 ? 'Original order' : 'Reversed order') + ': ' + verdictLabel(judgment.verdict)), make('p', judgment.summary));
      renderCriteria(pass, judgment.criteria);
      audit.appendChild(pass);
    }
    container.append(audit, make('p', assessment.note, 'notice'));
  }
  function renderEfficiency(result) {
    const table = make('table', '', 'efficiency-table');
    const headings = make('tr', '');
    for (const heading of ['Recorded measure', 'Baseline', 'Candidate']) headings.appendChild(make('th', heading));
    table.appendChild(headings);
    const measures = [['Model', 'model'], ['Latency (ms; full attempt for agent traces)', 'elapsedMs'],
      ['Input tokens (estimated; VS Code)', 'estimatedInputTokens'],
      ['Input tokens (last returned model call for agent traces)', 'inputTokens'],
      ['Output tokens (last returned model call for agent traces)', 'outputTokens'], ['Output token cap', 'maxOutputTokens']];
    for (const [label, key] of measures) {
      const row = make('tr', '');
      row.append(make('th', label), make('td', result.baseline[key] ?? 'Unknown'), make('td', result.candidate[key] ?? 'Unknown'));
      table.appendChild(row);
    }
    $('efficiency').replaceChildren(table);
  }
  function render(result) {
    if (result.testRun) renderTest(result.testRun, result.testSummary);
    else $('testResults').hidden = true;
    $('results').hidden = false;
    renderEvaluation(result.evaluation);
    $('baselineContent').textContent = result.content?.baseline ?? result.baseline.response;
    $('candidateContent').textContent = result.content?.candidate ?? result.candidate.response;
    renderEfficiency(result);
    renderTraces(result);
    const diff = $('diff'); diff.replaceChildren();
    for (const span of result.spans) diff.appendChild(make('span', span.text, span.type === 'equal' ? '' : span.type));
    const m = result.measures;
    $('summary').replaceChildren(
      make('p', 'Words: ' + m.baselineWords + ' → ' + m.candidateWords + ' (Δ ' + m.changedWordDelta + ')'),
      make('p', m.interpretation, 'notice')
    );
    const fair = $('fairness'); fair.replaceChildren(make('p', 'Run comparability: ' + result.fairness.status, 'status'));
    for (const issue of result.fairness.warnings) fair.appendChild(make('p', '⚠ ' + issue.message));
    for (const unknown of result.fairness.unknowns) fair.appendChild(make('p', 'Unknown: ' + unknown, 'notice'));
    fair.appendChild(make('p', result.fairness.note, 'notice'));
    const checks = $('checksResults'); checks.replaceChildren(make('h2', 'Required phrase checks'));
    if (!result.checks.length) checks.appendChild(make('p', 'No checks configured.', 'notice'));
    for (const c of result.checks) checks.appendChild(make('p', c.phrase + ' · Baseline ' + (c.baseline ? 'Pass' : 'Fail') + ' · Candidate ' + (c.candidate ? 'Pass' : 'Fail')));
  }
  function renderTraces(result) {
    const container = $('traces');
    container.replaceChildren();
    for (const side of ['baseline', 'candidate']) {
      const trace = result[side].executionTrace;
      const summary = result.traces?.[side];
      container.appendChild(make('h3', side === 'baseline' ? 'Baseline' : 'Candidate'));
      if (!trace || !summary) {
        container.appendChild(make('p', 'Execution trace unavailable.', 'notice'));
        continue;
      }
      container.appendChild(make('p', 'Run ' + trace.runId + ' | Attempt ' + trace.attempt + ' | ' + trace.outcome +
        ' | Capture: ' + trace.captureCompleteness + ' | Runtime: ' + (trace.runtimeVersion || 'Unknown')));
      container.appendChild(make('p', 'Deployment: ' + trace.requestedDeployment + ' | Reported models: ' +
        (summary.reportedModels.join(', ') || 'Unknown') + ' | Agent revision: ' + trace.agentDefinitionSha256));
      container.appendChild(make('p', 'Model requests: ' + summary.modelCalls + ' | Corrections: ' + summary.corrections +
        ' | Tools requested / executed: ' + summary.requestedTools + ' / ' + summary.executedTools +
        ' | Failed / cancelled: ' + summary.failedTools + ' | Rejected: ' + summary.rejectedTools));
      container.appendChild(make('p', 'Attempt input / output tokens: ' + (summary.inputTokens ?? 'Unknown') + ' / ' +
        (summary.outputTokens ?? 'Unknown') + ' | Known reported subtotals: ' + summary.knownInputTokens + ' / ' + summary.knownOutputTokens +
        '. Cached and reasoning tokens are subsets, not added again.'));
      for (const warning of summary.warnings) container.appendChild(make('p', warning, 'notice'));
      for (const event of trace.events) {
        const detail = make('details', '');
        detail.appendChild(make('summary', event.sequence + '. ' + event.kind + ' ' + (event.name || '') + ' - ' + event.outcome));
        detail.appendChild(make('pre', JSON.stringify(event, null, 2), 'response-content'));
        container.appendChild(detail);
      }
    }
  }
  function applyRun(side, result) {
    invalidate();
    runMetadata[side] = { elapsedMs: result.elapsedMs, runId: result.runId, modelVendor: result.modelVendor, estimatedInputTokens: result.estimatedInputTokens };
    const keys = ['model','provider','reportedModel','modelVersion','response','contextWindowTokens','contextWindowSource',
      'inputTokens','outputTokens','maxOutputTokens','finishReason','temperature'];
    for (const key of keys) fill(side + '-' + key, result[key]);
    // Provider-generated answers are pinned to their actual prompt to keep exported experiments reproducible.
    fill(side + '-prompt', result.promptTemplate ?? result.prompt);
    $(side + '-status').textContent = 'Done · ' + result.elapsedMs + ' ms · '
      + (result.inputTokens ?? '?') + ' input / ' + (result.outputTokens ?? '?') + ' output tokens';
    save();
    post('compare');
  }
  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'result' && msg.revision === revision) render(msg.result);
    if (msg.type === 'imported') { restore(msg.experiment); save(); post('compare'); }
    if (msg.type === 'instructionsLoaded') { fill('prompt', msg.prompt); invalidate(); save(); }
    if (msg.type === 'modelSelected' && ['a', 'b'].includes(msg.side)) {
      const side = msg.side;
      for (const key of ['endpoint', 'contextWindowTokens', 'maxOutputTokens', 'temperature', 'reportedModel', 'modelVersion', 'inputTokens', 'outputTokens', 'finishReason']) fill(side + '-' + key, '');
      fill(side + '-provider', 'vscode');
      fill(side + '-model', msg.model.id);
      fill(side + '-contextWindowSource', 'unverified');
      runMetadata[side] = { modelVendor: msg.model.vendor };
      invalidate(); updateRunner(side); save();
    }
    if (msg.type === 'testFinished') { restore(msg.experiment); save(); post('compare'); }
    if (msg.type === 'testUpdate') {
      testRun = msg.record;
      renderTest(testRun, msg.summary);
      $('reviewStatus').textContent = msg.message;
      save();
    }
    if (msg.type === 'runResult' && ['a','b'].includes(msg.side)) applyRun(msg.side, msg.result);
    if (msg.type === 'runStatus' && ['a','b'].includes(msg.side)) $(msg.side + '-status').textContent = msg.message;
    if (msg.type === 'reviewStatus') $('reviewStatus').textContent = msg.message;
    if (msg.type === 'busy') {
      busy = msg.value;
      document.querySelectorAll('input,textarea,select,button').forEach(element => { element.disabled = busy; });
      $('cancelReview').hidden = !busy || !['evaluation', 'test', 'run'].includes(msg.kind);
      $('cancelReview').disabled = false;
      if (busy && msg.kind === 'evaluation') renderEvaluation(null);
      if (busy && msg.kind === 'test') invalidate();
      for (const side of ['a','b']) updateRunner(side);
    }
  });
  $('compare').addEventListener('click', () => post('compare'));
  $('evaluate').addEventListener('click', () => post('evaluate'));
  $('chat').addEventListener('click', () => post('chat'));
  $('cancelReview').addEventListener('click', () => post('cancelReview'));
  $('import').addEventListener('click', () => post('import'));
  $('export').addEventListener('click', () => post('export'));
  $('report').addEventListener('click', () => post('report'));
  $('runBoth').addEventListener('click', () => post('runBoth'));
  $('orchestrate').addEventListener('click', () => post('orchestrate'));
  $('loadInstructions').addEventListener('click', () => post('loadInstructions'));
  for (const side of ['a','b']) {
    $(side + '-selectModel').addEventListener('click', () => post('selectModel', { side }));
    $(side + '-run').addEventListener('click', () => post('run', { side }));
    $(side + '-key').addEventListener('click', () => post('setKey', { side }));
    $(side + '-provider').addEventListener('change', () => {
      if ($(side + '-provider').value === 'vscode') for (const key of ['endpoint', 'contextWindowTokens', 'maxOutputTokens', 'temperature']) fill(side + '-' + key, '');
      updateRunner(side); save();
    });
  }
  document.querySelectorAll('input,textarea,select').forEach(el => el.addEventListener('input', () => {
    if (/^[ab]-/.test(el.id)) runMetadata[el.id.slice(0, 1)] = {};
    invalidate();
    updateRunner('a');
    save();
  }));
  restore(vscode.getState());
  for (const side of ['a','b']) updateRunner(side);
  if ($('a-response').value || $('b-response').value) post('compare');
})();