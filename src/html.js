'use strict';
const { randomBytes } = require('node:crypto');
const { responseContent } = require('./core');
const { usageReport } = require('./usage');
const { promptDecision } = require('./prompt-review');

const escape = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const label = side => side === 'baseline' ? 'Baseline' : 'Candidate';
const preferred = '<span class="status-badge preferred-badge">★ Preferred</span>';
const details = (title, body) => `<details class="result-details"><summary>${escape(title)}</summary>${body}</details>`;
const raw = value => `<pre class="response-content">${escape(value)}</pre>`;
const metric = (title, value, hint = '') => `<div class="metric-tile"><span class="metric-label">${escape(title)}</span>
  <strong class="metric-value">${escape(value)}</strong><span class="metric-hint">${escape(hint)}</span></div>`;

function changesOnly(spans, passages, label) {
  if (!passages.length) return '<p class="notice">No changes.</p>';
  return `<p class="notice">${passages.length} ${passages.length === 1 ? 'passage changed' : 'passages changed'} · Unchanged sections hidden</p>` +
    passages.map((passage, index) => `<section class="change-passage"><h3>Change ${index + 1}</h3><div class="change-pair">${
      ['original', 'edited'].map(side => `<div class="change-version"><strong class="change-label">${side === 'original' ? 'Original' : 'Edited'}</strong>
      <div class="change-text">${passage[side].some(span => span.text) ? passage[side].map(span =>
        `<span class="${span.type}">${escape(span.text)}</span>`).join('') : '<span class="notice">No text</span>'}</div></div>`).join('')
    }</div></section>`).join('') +
    details('Show full ' + label + ' diff', `<div class="diff">${spans.map(span =>
      `<span class="${span.type}">${escape(span.text)}</span>`).join('')}</div>`);
}

function tokens(result = {}, title = 'Tokens in / out', hint) {
  const count = (actual, estimated) => actual != null ? actual.toLocaleString(undefined, { maximumFractionDigits: 1 })
    : estimated != null ? '~' + estimated.toLocaleString(undefined, { maximumFractionDigits: 1 }) : 'Unknown';
  return metric(title, count(result.inputTokens, result.estimatedInputTokens) + ' / ' +
    count(result.outputTokens, result.estimatedOutputTokens), hint ?? '~ means model-counted estimate, not billed usage. Hidden reasoning is excluded from estimates.');
}

function usage(report) {
  if (!report) return '';
  return details('Per-turn costs and pricing assumptions',
    metric('Azure-equivalent cost estimate', report.total, report.hint) +
    `<p class="notice">${escape(report.note)}</p><a href="https://azure.microsoft.com/en-us/pricing/details/azure-openai/">Official Azure pricing</a>
    <div class="usage-table"><table><thead><tr>${['Request', 'Model', 'Input', 'Output', 'USD short / standard', 'USD long', 'Basis']
    .map(title => `<th scope="col">${title}</th>`).join('')}</tr></thead><tbody>${report.rows.map(row => '<tr>' +
    [row.label, row.model, row.input, row.output, row.short, row.long, row.note].map(value => `<td>${escape(value)}</td>`).join('') + '</tr>')
    .join('')}</tbody></table></div>`);
}

function assessment(value) {
  if (!value) return '<p class="notice">No completed quality review. Text differences do not establish a winner.</p>';
  const verdict = ['baseline', 'candidate'].includes(value.verdict) ? 'Recommend ' + label(value.verdict)
    : value.verdict === 'tie' ? 'Tie' : 'Insufficient evidence';
  return `<div class="review-heading"><h3 class="verdict">${verdict}</h3>
    <span class="notice">Evaluator: ${escape(value.model?.name || value.model?.id || 'Unknown')}</span></div>
    <p class="assessment-summary">${escape(value.summary)}</p>
    <p class="notice">Order check: ${value.orderConsistent === true ? 'Consistent' : value.orderConsistent === false ? 'Disagrees' : 'Not checked'}</p>
    ${(value.criteria || []).map(item => `<section class="criterion"><div class="criterion-heading">
      <h4>${escape(item.criterion)}</h4><span class="status-badge">${escape(item.verdict)}</span></div>
      <p>${escape(item.rationale)}</p>${details('Source citations', (item.citations || []).map(citation =>
    `<blockquote><strong>${escape(citation.source)}</strong><p>${escape(citation.quote)}</p></blockquote>`).join(''))}</section>`).join('')}
    ${(value.unknowns || []).length ? details('Remaining unknowns', '<ul>' + value.unknowns.map(item => `<li>${escape(item)}</li>`).join('') + '</ul>') : ''}
    ${details('Evaluator usage (separate)', usage(usageReport(value.usageTurns || [])))}`;
}

function asHtml(result, { css, markdownScript }) {
  const nonce = randomBytes(18).toString('base64');
  const markdown = [];
  const formatted = value => {
    const text = responseContent(value);
    const index = markdown.push(text) - 1;
    return `<div class="markdown-body" data-markdown="${index}">${raw(text)}</div>`;
  };
  const response = (side, value, status, winner, error) => `<article class="response-card${winner === side ? ' model-preferred' : ''}">
    <div class="model-card-heading"><h3>${escape(value?.model || result[side].model || 'Unspecified model')}</h3><span>${winner === side ? preferred : ''}
    <span class="status-badge">${escape(status)}</span></span></div><p class="model-role">${label(side)}${result.comparisonKind === 'prompt' ? ' prompt' : ''}</p>
    ${tokens(value)}<div class="response-view">${value?.response ? formatted(value.response) : `<p class="warning-callout">${escape(error || 'No response available.')}</p>`}</div>
    ${value?.response ? details('Raw response', raw(value.response)) : ''}
    ${value?.toolEvidence ? details('Tool requests and full returned results', raw(JSON.stringify(value.toolEvidence, null, 2))) : ''}
    ${value?.investigationBudget?.limited ? `<p class="warning-callout">Historical budget-limited investigation: ${escape(value.investigationBudget.reasons.join(' '))}</p>` : ''}
    </article>`;
  const test = result.testRun;
  const summary = result.testSummary;
  const winner = test ? summary?.preference : result.evaluation?.verdict;
  const hasWinner = ['baseline', 'candidate'].includes(winner);
  const kind = result.comparisonKind === 'prompt' ? 'Prompt comparison' : 'Model comparison';
  const title = hasWinner ? label(winner) + ' preferred for this task' : 'Compare the evidence. See the tradeoffs.';
  const modelCards = ['baseline', 'candidate'].map(side => {
    const metrics = summary?.metrics[side] || result[side];
    const latency = metrics.medianLatencyMs ?? metrics.elapsedMs;
    return `<article class="model-summary-card${winner === side ? ' model-preferred' : ''}">
      <div class="model-card-heading"><h3>${escape(result[side].model || 'Unspecified model')}</h3>${winner === side ? preferred : ''}</div>
      <p class="model-role">${label(side)}${result.comparisonKind === 'prompt' ? ' prompt' : ''}</p><div class="model-metrics">
      ${metric(test ? 'Responses' : 'Response', test ? metrics.succeeded + ' / ' + test.plan.repetitions
    : result[side].response ? 'Available' : 'Missing')}
      ${metric(test ? 'Median paired time' : 'Elapsed time', Number.isFinite(latency) ? (latency / 1000).toFixed(1) + ' s' : 'Unknown')}
      ${tokens(metrics, test ? 'Total tokens in / out' : 'Tokens in / out')}
      ${test ? tokens(metrics.tokensPerRun, 'Avg tokens in / out per run', 'Across ' + metrics.succeeded + ' successful runs; ~ means estimated') +
        metric('Model turns', metrics.modelRequestCount ?? 'Unknown', 'Across successful runs') +
        metric('Tool calls', metrics.toolCallCount ?? 'Unknown', 'Executed calls across successful runs') : ''}</div>
      ${usage(metrics.usage)}</article>`;
  }).join('');
  const efficiency = summary?.efficiency ? `<section class="efficiency-tradeoff"><h3>Quality preference vs. efficiency</h3>
    <p class="notice">Preferred reflects the quality review, not lower token usage, cost, or latency. Tokens accumulate across turns as evidence is sent again.</p>
    <div class="overview-metrics">${summary.efficiency.map(item => metric(item.label, item.value, item.hint)).join('')}</div>
    ${details('Evaluator usage (separate from investigations)', usage(summary.evaluatorUsage))}</section>` : '';
  const runs = test ? test.pairs.map(pair => `<section class="report-run"><div class="report-run-heading">
    <h2>Run ${pair.number}</h2><span class="status-badge">${escape(pair.evaluationStatus)}</span></div>
    <p class="notice">Generation order: ${escape(pair.order.join(' then '))}</p>
    <div class="readable-responses">${['baseline', 'candidate'].map(side => response(side, pair[side].result, pair[side].status,
    pair.evaluationStatus === 'succeeded' ? pair.evaluation?.verdict : null, pair[side].error)).join('')}</div>
    <div class="report-review">${assessment(pair.evaluation)}${pair.evaluationError ? `<p class="warning-callout">${escape(pair.evaluationError)}</p>` : ''}</div></section>`).join('')
    : `<section class="report-run"><h2>Quality review</h2>${assessment(result.evaluation)}<h2 class="section-title">Model reports</h2>
      <div class="readable-responses">${['baseline', 'candidate'].map(side =>
    response(side, result[side], result[side].response ? 'Received' : 'Missing', winner)).join('')}</div></section>`;
  const warnings = [...(summary?.warnings || []), ...(result.fairness?.warnings || []).map(item => item.message)];
  const prompt = result.comparisonKind === 'prompt' ? promptDecision(result) : null;
  const promptReport = prompt ? `<section class="prompt-verdict"><p class="eyebrow">PROMPT EDIT REVIEW</p>
    <h2>${escape(prompt.verdict)}</h2><strong>${escape(prompt.action)}</strong><p>${escape(prompt.reason)}</p>
    <p class="notice">${escape(prompt.caveat)}</p></section>
    ${result.evidenceCollection ? details('Shared evidence collection (separate from prompt tests)',
    `<p>Not included in either prompt totals.</p>${raw(JSON.stringify(result.evidenceCollection, null, 2))}`) : ''}
    <h2>What changed in the prompt?</h2>${changesOnly(result.promptComparison.spans, result.promptComparison.passages, 'prompt')}
    ${prompt.changes.map(change => `<article class="prompt-change"><h3>${escape(change.change)}</h3>
    <span class="status-badge">${escape(change.effect)}</span><p>${escape(change.impact)}</p><strong>${escape(change.recommendation)}</strong>
    ${details('See the prompt edit and output evidence', change.citations.map(citation =>
    `<blockquote><strong>${escape(({ baselinePrompt: 'Original prompt', candidatePrompt: 'Edited prompt', baselineTask: 'Original task',
    candidateTask: 'Edited task', baseline: 'Original output', candidate: 'Edited output' })[citation.source])}</strong>${raw(citation.quote)}</blockquote>`).join(''))}</article>`).join('')}
    ${details('Output changes', changesOnly(result.spans, result.outputPassages, 'output'))}` : '';
  const data = JSON.stringify(markdown).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
    <title>CompareLab — ${kind}</title><style nonce="${nonce}">
    :root { color-scheme: dark; --vscode-font-family: system-ui, -apple-system, sans-serif; --vscode-font-size: 14px;
      --vscode-foreground: #e8edf5; --vscode-descriptionForeground: #a4b0c4; --vscode-editor-background: #0c1220;
      --vscode-panel-border: #2a3750; --vscode-focusBorder: #77a9ff; --vscode-textCodeBlock-background: #121d30;
      --vscode-testing-iconPassed: #68d5a0; --vscode-errorForeground: #ff9696; --vscode-editorWarning-foreground: #f0c46c;
      --vscode-textLink-foreground: #9ac0ff; --vscode-editor-font-family: ui-monospace, monospace;
      --vscode-editor-inactiveSelectionBackground: #243049; }
    ${css}
    main { max-width: 1280px; padding: 48px 28px; } header { padding-bottom: 20px; border-bottom: 1px solid var(--vscode-panel-border); }
    header h1 { font-size: 28px; } .analysis-overview { background: linear-gradient(125deg, #172b49, #152032 65%, #152b2b); padding: 32px; }
    .analysis-overview h2 { font-size: clamp(24px, 4vw, 36px); max-width: 850px; line-height: 1.2; margin: 10px 0 18px; }
    .model-summary-card, .response-card { background: #111b2c; } .report-run { margin-top: 40px; }
    .report-run > h2, .report-run-heading h2 { font-size: 22px; margin: 0 0 18px; }
    .report-run-heading, .review-heading { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; flex-wrap: wrap; }
    .report-review { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 24px; margin-top: 20px; background: #101a2b; }
    .markdown-body { max-height: none; overflow: visible; } .markdown-body pre { max-height: none; }
    .response-card > .metric-tile { margin: 18px 0; } .report-context { margin-top: 36px; } .result-details { margin-top: 12px; }
    footer { border-top: 1px solid var(--vscode-panel-border); padding-top: 20px; }
    @media print { :root { color-scheme: light; --vscode-foreground: #152034; --vscode-descriptionForeground: #43516a; --vscode-editor-background: white; --vscode-panel-border: #b7c1ce; --vscode-textCodeBlock-background: #edf2f7; --vscode-testing-iconPassed: #197041; }
      main { padding: 0; } .analysis-overview, .model-summary-card, .response-card, .report-review { background: white; box-shadow: none; }
      .readable-responses, .analysis-models { display: block; } article { margin: 14px 0; } .response-content { max-height: none; } }
    </style></head><body><main><header><div><h1>⇄ CompareLab</h1><p>${kind} · Offline assessment report</p></div>
    <span class="status-badge">${escape(test?.status || (result.evaluation ? 'Reviewed' : 'Not evaluated'))}</span></header>
    ${prompt ? promptReport : `<section class="analysis-overview"><p class="eyebrow">${kind.toUpperCase()}</p><h2>${title}</h2>
    <p class="overview-description">${test ? escape(summary?.note) : 'A practical, task-specific comparison. Recommendations and cited evidence still require human verification.'}</p>
    ${summary ? `<div class="overview-metrics">${metric('Pairs reviewed', test.pairs.filter(pair => pair.evaluationStatus === 'succeeded').length + ' / ' + test.plan.repetitions)}
    ${metric('Supported baseline preferences', summary.counts.baseline)}${metric('Supported candidate preferences', summary.counts.candidate)}</div>` : ''}</section>
    <div class="analysis-models">${modelCards}</div>${efficiency}${warnings.length ? details('Interpretation and limitations',
    warnings.map(warning => `<p class="warning-callout">${escape(warning)}</p>`).join('')) : ''}`}
    <noscript><p class="notice">JavaScript is disabled. Responses remain available as raw Markdown below.</p></noscript>
    ${prompt ? details('Full outputs, reviews and technical details', runs + `<div class="analysis-models">${modelCards}</div>` + efficiency) : runs}
    <section class="report-context"><h2>Inputs &amp; audit trail</h2>
    ${details('Instructions, trigger, and evidence', `<h3>Baseline instructions</h3>${raw(result.baseline.prompt)}<h3>Candidate instructions</h3>${raw(result.candidate.prompt)}
      <h3>Incoming message</h3>${raw(result.incomingMessage)}<h3>Evidence supplied to the review</h3>${raw(result.evidence)}`)}
    ${details('Complete comparison record (includes source data)', raw(JSON.stringify(result, null, 2)))}</section>
    <footer>Generated ${escape(new Date().toISOString())}. Self-contained: no external scripts, fonts, or automatic network requests.
    This report includes prompts, responses, and source evidence. Review it for sensitive data before sharing.
    Token estimates are not actual billed usage; timings are observations, not statistical benchmarks.</footer></main>
    <script id="reportData" type="application/json" nonce="${nonce}">${data}</script>
    <script nonce="${nonce}">${markdownScript}</script>
    <script nonce="${nonce}">const reports = JSON.parse(document.getElementById('reportData').textContent);
    for (const element of document.querySelectorAll('[data-markdown]')) {
      window.CompareLabMarkdown.render(document, element, reports[Number(element.dataset.markdown)]);
    }</script></body></html>`;
}

module.exports = { asHtml };
