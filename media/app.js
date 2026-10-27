(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const fields = ['model','prompt','response','reportedModel','modelVersion','contextWindowTokens','contextWindowSource','inputTokens','outputTokens','maxOutputTokens','finishReason','temperature'];
  const side = prefix => {
    const out = {};
    for (const key of fields) {
      const element = $(prefix + '-' + key);
      if (element && element.value !== '') out[key] = element.value;
    }
    return out;
  };
  const experiment = () => ({
    prompt: $('prompt').value,
    baseline: side('a'),
    candidate: side('b'),
    checks: { requiredPhrases: $('checks').value.split(',').map(x => x.trim()).filter(Boolean) }
  });
  const save = () => vscode.setState(experiment());
  const post = type => { save(); vscode.postMessage({ type, experiment: experiment() }); };
  const fill = (id, value) => { if ($(id)) $(id).value = value ?? ''; };
  function restore(data) {
    if (!data || typeof data !== 'object') return;
    fill('prompt', data.prompt);
    for (const [prefix, variant] of [['a', data.baseline], ['b', data.candidate]]) {
      for (const key of fields) fill(prefix + '-' + key, variant?.[key]);
    }
    fill('checks', (data.checks?.requiredPhrases || []).join(', '));
  }
  function make(tag, text, className) {
    const el = document.createElement(tag);
    el.textContent = String(text);
    if (className) el.className = className;
    return el;
  }
  function render(result) {
    $('results').hidden = false;
    const diff = $('diff'); diff.replaceChildren();
    for (const span of result.spans) {
      diff.appendChild(make('span', span.text, span.type === 'equal' ? '' : span.type));
    }
    const m = result.measures;
    $('summary').replaceChildren(make('p', 'Words: ' + m.baselineWords + ' → ' + m.candidateWords + ' (Δ ' + m.changedWordDelta + ')'), make('p', m.interpretation, 'notice'));
    const fair = $('fairness'); fair.replaceChildren(make('p', 'Comparison confidence: ' + result.fairness.status, 'status'));
    for (const issue of result.fairness.warnings) fair.appendChild(make('p', '⚠ ' + issue.message));
    for (const unknown of result.fairness.unknowns) fair.appendChild(make('p', 'Unknown: ' + unknown, 'notice'));
    fair.appendChild(make('p', result.fairness.note, 'notice'));
    const checks = $('checksResults'); checks.replaceChildren(make('h2', 'Required phrase checks'));
    if (!result.checks.length) checks.appendChild(make('p', 'No checks configured.', 'notice'));
    for (const c of result.checks) checks.appendChild(make('p', c.phrase + ' · Baseline ' + (c.baseline ? 'Pass' : 'Fail') + ' · Candidate ' + (c.candidate ? 'Pass' : 'Fail')));
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  window.addEventListener('message', event => {
    if (event.data.type === 'result') render(event.data.result);
    if (event.data.type === 'imported') { restore(event.data.experiment); save(); post('compare'); }
  });
  $('compare').addEventListener('click', () => post('compare'));
  $('import').addEventListener('click', () => post('import'));
  $('export').addEventListener('click', () => post('export'));
  $('report').addEventListener('click', () => post('report'));
  document.querySelectorAll('input,textarea,select').forEach(el => el.addEventListener('input', save));
  restore(vscode.getState());
})();