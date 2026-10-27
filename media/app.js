(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const fields = ['model','prompt','response','provider','endpoint','tokenLimitField','reportedModel','modelVersion','contextWindowTokens','contextWindowSource','inputTokens','outputTokens','maxOutputTokens','finishReason','temperature'];
  const side = prefix => {
    const out = {};
    for (const key of fields) {
      const element = $(prefix + '-' + key);
      if (element && element.value !== '') out[key] = element.value;
    }
    return out;
  };
  const experiment = () => ({
    prompt: $('prompt').value, baseline: side('a'), candidate: side('b'),
    checks: { requiredPhrases: $('checks').value.split(',').map(x => x.trim()).filter(Boolean) }
  });
  const save = () => vscode.setState(experiment());
  const post = (type, extra = {}) => {
    save();
    vscode.postMessage({ type, experiment: experiment(), ...extra });
  };
  const fill = (id, value) => { if ($(id)) $(id).value = value ?? ''; };
  function restore(data) {
    if (!data || typeof data !== 'object') return;
    fill('prompt', data.prompt);
    for (const [prefix, variant] of [['a', data.baseline], ['b', data.candidate]]) {
      for (const key of fields) if (variant && Object.hasOwn(variant, key)) fill(prefix + '-' + key, variant[key]);
    }
    fill('checks', (data.checks?.requiredPhrases || []).join(', '));
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
    $(side + '-key').hidden = !openai;
    $(side + '-tokenLimitField').closest('label').hidden = !openai;
    $(side + '-endpoint').placeholder = provider === 'ollama'
      ? 'http://127.0.0.1:11434'
      : 'https://api.openai.com/v1';
    $(side + '-run').disabled = provider === 'manual';
    $('runBoth').disabled = !(['a','b'].every(p => $(p + '-provider').value !== 'manual'));
  }
  function render(result) {
    $('results').hidden = false;
    const diff = $('diff'); diff.replaceChildren();
    for (const span of result.spans) diff.appendChild(make('span', span.text, span.type === 'equal' ? '' : span.type));
    const m = result.measures;
    $('summary').replaceChildren(
      make('p', 'Words: ' + m.baselineWords + ' → ' + m.candidateWords + ' (Δ ' + m.changedWordDelta + ')'),
      make('p', m.interpretation, 'notice')
    );
    const fair = $('fairness'); fair.replaceChildren(make('p', 'Comparison confidence: ' + result.fairness.status, 'status'));
    for (const issue of result.fairness.warnings) fair.appendChild(make('p', '⚠ ' + issue.message));
    for (const unknown of result.fairness.unknowns) fair.appendChild(make('p', 'Unknown: ' + unknown, 'notice'));
    fair.appendChild(make('p', result.fairness.note, 'notice'));
    const checks = $('checksResults'); checks.replaceChildren(make('h2', 'Required phrase checks'));
    if (!result.checks.length) checks.appendChild(make('p', 'No checks configured.', 'notice'));
    for (const c of result.checks) checks.appendChild(make('p', c.phrase + ' · Baseline ' + (c.baseline ? 'Pass' : 'Fail') + ' · Candidate ' + (c.candidate ? 'Pass' : 'Fail')));
  }
  function applyRun(side, result) {
    const keys = ['model','provider','reportedModel','response','contextWindowTokens','contextWindowSource',
      'inputTokens','outputTokens','maxOutputTokens','finishReason','temperature'];
    for (const key of keys) fill(side + '-' + key, result[key]);
    // Provider-generated answers are pinned to their actual prompt to keep exported experiments reproducible.
    fill(side + '-prompt', result.prompt);
    $(side + '-status').textContent = 'Done · ' + result.elapsedMs + ' ms · '
      + (result.inputTokens ?? '?') + ' input / ' + (result.outputTokens ?? '?') + ' output tokens';
    save();
    post('compare');
  }
  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'result') render(msg.result);
    if (msg.type === 'imported') { restore(msg.experiment); save(); post('compare'); }
    if (msg.type === 'runResult' && ['a','b'].includes(msg.side)) applyRun(msg.side, msg.result);
    if (msg.type === 'runStatus' && ['a','b'].includes(msg.side)) $(msg.side + '-status').textContent = msg.message;
    if (msg.type === 'busy') {
      for (const side of ['a','b']) $(side + '-run').disabled = msg.value || $(side + '-provider').value === 'manual';
      $('runBoth').disabled = msg.value || !(['a','b'].every(p => $(p + '-provider').value !== 'manual'));
    }
  });
  $('compare').addEventListener('click', () => post('compare'));
  $('import').addEventListener('click', () => post('import'));
  $('export').addEventListener('click', () => post('export'));
  $('report').addEventListener('click', () => post('report'));
  $('runBoth').addEventListener('click', () => post('runBoth'));
  for (const side of ['a','b']) {
    $(side + '-run').addEventListener('click', () => post('run', { side }));
    $(side + '-key').addEventListener('click', () => post('setKey', { side }));
    $(side + '-provider').addEventListener('change', () => updateRunner(side));
  }
  document.querySelectorAll('input,textarea,select').forEach(el => el.addEventListener('input', save));
  restore(vscode.getState());
  for (const side of ['a','b']) updateRunner(side);
})();