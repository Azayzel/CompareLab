(() => {

  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let revision = 0;
  let busy = false;
  let historyBusy = false;
  let activeView = 'compare';
  let comparisonKind = 'model';
  let comparisonDrafts = {};
  let historyEntries = [];
  let historyActions = [];
  let revealHistoryResult = false;
  let testRun = null;
  let promptLayout = null;
  let optimizerDraft = null;
  let promptCanAdopt = false;
  let promptReviewRunning = false;
  let reviewStartedAt = 0;
  let reviewClock = null;
  let reviewPhase = 'prepare';
  let reviewCancelling = false;
  let evidenceCollection = null;
  let toolSelection = [];


  const runMetadata = { a: {}, b: {} };
  const fields = ['model', 'prompt', 'response', 'provider', 'endpoint', 'tokenLimitField', 'reportedModel', 'modelVersion', 'contextWindowTokens', 'contextWindowSource', 'inputTokens', 'outputTokens', 'maxOutputTokens', 'finishReason', 'temperature'];
  const sharedModelFields = ['model', 'provider', 'endpoint', 'tokenLimitField', 'contextWindowTokens',
    'contextWindowSource', 'maxOutputTokens', 'temperature', 'modelVendor'];


  const side = prefix => {
    const out = { ...runMetadata[prefix] };
    for (const key of fields) {
      const element = $(prefix + '-' + key);
      if (element && element.value !== '' && (key !== 'prompt' || element.value.trim())) out[key] = element.value;
    }
    return out;
  };


  const experiment = () => {
    const baseline = side('a');
    const candidate = side('b');
    if (comparisonKind === 'prompt') for (const key of sharedModelFields) candidate[key] = baseline[key];
    return {
      comparisonKind,
      comparisonMode: $('comparisonMode').value || 'end-to-end',
      toolSelection,
      prompt: $('prompt').value, incomingMessage: $('incomingMessage').value, evidence: $('evidence').value, baseline, candidate,
      ...(evidenceCollection ? { evidenceCollection } : {}),
      review: { checkOrder: $('checkOrder').checked },
      test: { repetitions: Number($('testRepetitions').value || 3) }, testRun,
      checks: { requiredPhrases: $('checks').value.split(',').map(x => x.trim()).filter(Boolean) },
      ...(comparisonKind === 'prompt' ? {
        optimizer: {
          goal: $('optimizerGoal').value, preserve: $('optimizerPreserve').value, success: $('optimizerSuccess').value,
          draft: optimizerDraft ? { ...optimizerDraft, prompt: $('optimizerDraft').value } : null
        }
      } : {})
    };
  };

  const save = () => {
    const data = experiment();
    comparisonDrafts[comparisonKind] = data;
    vscode.setState({ ...data, comparisonDrafts });
  };

  const post = (type, extra = {}) => {
    save();
    vscode.postMessage({ type, experiment: experiment(), revision, ...extra });
  };

  const fill = (id, value) => { if ($(id)) $(id).value = value ?? ''; };

  function restore(data) {
    if (!data || typeof data !== 'object') return;
    comparisonKind = data.comparisonKind === 'prompt' ? 'prompt' : 'model';
    evidenceCollection = data.evidenceCollection || data.testRun?.plan?.evidenceCollection || null;
    toolSelection = data.toolSelection || data.testRun?.plan?.toolCatalog?.map(tool => tool.name) || [];
    updateToolSummary();
    optimizerDraft = data.optimizer?.draft || null;
    fill('optimizerGoal', data.optimizer?.goal || 'Clearer instructions');
    fill('optimizerPreserve', data.optimizer?.preserve);
    fill('optimizerSuccess', data.optimizer?.success);
    fill('optimizerDraft', optimizerDraft?.prompt);
    $('optimizerPreview').hidden = !optimizerDraft;
    $('optimizerSummary').textContent = optimizerDraft?.summary || '';

    if (data.comparisonDrafts && typeof data.comparisonDrafts === 'object') comparisonDrafts = data.comparisonDrafts;

    fill('prompt', data.prompt);
    fill('incomingMessage', data.incomingMessage);
    fill('evidence', data.evidence);
    fill('comparisonMode', data.comparisonMode || 'end-to-end');
    $('checkOrder').checked = data.review?.checkOrder !== false;
    fill('testRepetitions', data.test?.repetitions ?? 3);

    const defaults = { provider: 'vscode', tokenLimitField: 'max_completion_tokens', contextWindowSource: 'unverified' };

    for (const [prefix, variant] of [['a', data.baseline], ['b', data.candidate]]) {
      for (const key of fields) fill(prefix + '-' + key, variant?.[key] ?? defaults[key] ?? '');
      runMetadata[prefix] = {
        elapsedMs: variant?.elapsedMs ?? null, runId: variant?.runId ?? null,
        modelVendor: variant?.modelVendor, estimatedInputTokens: variant?.estimatedInputTokens ?? null,
        estimatedOutputTokens: variant?.estimatedOutputTokens ?? null,
        usageTurns: variant?.usageTurns ?? null,
        responseRedacted: variant?.responseRedacted === true, responseTruncated: variant?.responseTruncated === true,
        executionTrace: variant?.executionTrace ?? null
      };
    }
    fill('checks', Array.isArray(data.checks?.requiredPhrases) ? data.checks.requiredPhrases.filter(value => typeof value === 'string').join(', ') : '');
    invalidate();
    testRun = data.testRun ?? null;
    if (testRun) renderTest(testRun);
    for (const side of ['a', 'b']) updateRunner(side);
    updateComparisonLayout();
    if (activeView !== 'history') selectView(comparisonKind === 'prompt' ? 'prompt' : 'compare');
  }
  function make(tag, text, className) {
    const el = document.createElement(tag);
    el.textContent = String(text);
    if (className) el.className = className;
    return el;
  }
  function updateToolSummary() {
    $('toolSelectionSummary').textContent = toolSelection.length
      ? 'Shared tools (' + toolSelection.length + '): ' + toolSelection.join(', ') : 'No tools selected';
  }
  function updateRunner(side) {
    const provider = $(comparisonKind === 'prompt' && side === 'b' ? 'a-provider' : side + '-provider').value;
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
    const input = experiment();
    $('runBoth').disabled = busy || [input.baseline, input.candidate].some(variant => variant.provider === 'manual');
    $('orchestrate').disabled = $('runBoth').disabled;
    $('promptTest').disabled = $('orchestrate').disabled;
    const repetitions = Number($('testRepetitions').value || 3);
    const reviews = repetitions * ($('checkOrder').checked ? 2 : 1);
    $('comparisonRunSummary').textContent = 'Runs both models and reviews their outputs. ' +
      repetitions + ' paired run' + (repetitions === 1 ? '' : 's') + '; ' +
      reviews + ' review' + (reviews === 1 ? '' : 's') + '. Adjust in Advanced settings.';
    $('testBudget').textContent = repetitions * 2 + ($('comparisonMode').value === 'end-to-end' ? ' agent investigations; ' : ' generation requests; ') + repetitions * ($('checkOrder').checked ? 2 : 1) +
      ' review requests, plus up to ' + repetitions + ' citation corrections. ' +
      ($('comparisonMode').value === 'end-to-end'
        ? 'Only tools freshly marked verified read-only are enabled. Every call requires confirmation. Cancel to stop.'
        : 'Sequential, frozen-evidence runs.');
  }
  function updateComparisonLayout() {
    const prompt = comparisonKind === 'prompt';
    $('compareView').className = prompt ? 'comparison-prompt' : 'comparison-model';
    $('promptTools').hidden = !prompt;
    if (promptLayout !== prompt) {
      $(prompt ? 'promptModelSlot' : 'a-modelSlot').appendChild($('a-modelSettings'));
      $(prompt ? 'promptModeSlot' : 'modelModeSlot').appendChild($('comparisonModeSetting'));
      for (const side of ['a', 'b']) $(prompt ? 'promptAdvanced' : side + '-editor').appendChild($(side + '-technicalSlot'));
      $('promptAdvanced').open = false;
      $('otherActions').open = false;
      $('promptAudit').open = !prompt;
      $('evidenceOptions').open = !prompt;
      $('shareActions').open = !prompt;
      $(prompt ? 'promptProgressSlot' : 'reviewProgressSlot').appendChild($('reviewProgress'));
      promptLayout = prompt;
    }
    $('promptModelSlot').hidden = !prompt;
    $('modelRunControls').hidden = prompt;
    $('modelOtherActions').hidden = prompt;
    $('promptOtherActions').hidden = !prompt;
    for (const id of ['runBoth', 'compare', 'orchestrate', 'chat', 'evaluate', 'a-run']) $(id).hidden = prompt;
    $('promptReviewOutputs').hidden = !prompt;
    $('shareActionsLabel').hidden = !prompt;
    $('historySave').textContent = prompt ? 'Save prompt comparison to History' : 'Save to history';
    $('incomingMessageLabel').textContent = prompt ? 'Shared input / alert' : 'Incoming message / trigger';
    $('evidenceOptionsLabel').textContent = prompt ? 'Shared evidence snapshot (optional; collected automatically)' : 'Source evidence (optional for live investigations)';
    if ($('comparisonMode').options) $('comparisonMode').options[1].textContent = prompt
      ? 'Same evidence (collect once or reuse supplied snapshot)' : 'Model / prompt only (frozen evidence required)';
    $('sharedInstructions').hidden = prompt;
    $('comparisonDescription').textContent = prompt
      ? 'Edit the prompt. Test the outputs. Keep only changes that help.'
      : 'Compare models using the same instructions and incoming message.';
    $('investigationDescription').textContent = prompt
      ? $('comparisonMode').value === 'end-to-end'
        ? 'Independent read-only investigations: evidence may differ, so prompt effects are harder to isolate. Read-only declarations do not guarantee isolation.'
        : 'Shared evidence: collect one snapshot using selected tools if blank, then give both prompts the exact same evidence without live tools.'
      : $('comparisonMode').value === 'end-to-end'
        ? 'Each model investigates independently with the selected tools. Evidence may differ; this is not an isolated test of model quality.'
        : 'Both models use the supplied evidence without live tools. Add a source snapshot before running the comparison.';
    $('b-modelSettings').hidden = prompt;
    $('b-runner').hidden = prompt;
    $('b-modelDetails').hidden = prompt;
    $('a-modelLabel').textContent = prompt ? 'Shared model (both prompts)' : 'Model';
    for (const side of ['a', 'b']) {
      $(side + '-heading').textContent = prompt ? (side === 'a' ? 'Original prompt' : 'Edited prompt') : side === 'a' ? 'Baseline' : 'Candidate';
      $(side + '-promptLabel').textContent = prompt ? 'Agent instructions / prompt variant' : 'Prompt override';
      $(side + '-prompt').placeholder = prompt ? 'Enter ' + (side === 'a' ? 'original' : 'edited') + ' instructions' : 'Uses shared prompt';
      $(side + '-promptSection').hidden = !prompt && !$(side + '-prompt').value.trim();
      $(side + '-promptSection').open = prompt;
    }
  }
  function invalidate() {
    revision++;
    $('results').hidden = true;
    $('promptResults').hidden = true;
    promptCanAdopt = false;
    $('evaluation').replaceChildren();
    $('reviewStatus').textContent = '';
    testRun = null;
    $('testResults').hidden = true;
    $('historySaveStatus').textContent = '';
    revealHistoryResult = false;
  }

  function updateHistoryControls() {
    $('historySave').disabled = busy || historyBusy;
    $('historyClear').disabled = busy || historyBusy || !historyEntries.length;
    $('historyRefresh').disabled = historyBusy;
    $('compareTab').disabled = busy && comparisonKind !== 'model';
    $('promptTab').disabled = busy && comparisonKind !== 'prompt';
    $('historyTab').disabled = false;
    for (const { button, unavailable } of historyActions) button.disabled = busy || historyBusy || unavailable;
  }
  function selectView(view) {
    activeView = view;
    for (const name of ['compare', 'prompt', 'history']) {
      const selected = name === view;
      $(name + 'Tab').ariaSelected = String(selected);
      $(name + 'Tab').tabIndex = selected ? 0 : -1;
    }
    $('compareView').hidden = view === 'history';
    $('historyView').hidden = view !== 'history';
    $('compareView').setAttribute('aria-labelledby', (view === 'prompt' ? 'prompt' : 'compare') + 'Tab');
    $('currentActions').hidden = view === 'history';
    $('shareActions').hidden = view === 'history';
  }
  function showView(view) {
    const nextKind = view === 'prompt' ? 'prompt' : 'model';
    if (busy && view !== 'history' && nextKind !== comparisonKind) return;
    if (view !== 'history' && nextKind !== comparisonKind) {
      const current = experiment();
      comparisonDrafts[comparisonKind] = current;
      const variant = { ...Object.fromEntries(sharedModelFields.map(key => [key, current.baseline[key]])), response: '' };
      const initial = nextKind === 'prompt' ? {
        ...current, prompt: '',
        baseline: { ...variant, prompt: current.baseline.prompt || current.prompt },
        candidate: { ...variant, prompt: current.baseline.prompt || current.prompt }, comparisonMode: 'model-prompt-only',
        test: { repetitions: 1 }, optimizer: null, evidenceCollection: null
      }
        : { ...current, prompt: current.baseline.prompt || current.prompt, baseline: variant, candidate: { ...variant } };
      restore(comparisonDrafts[nextKind] || { ...initial, comparisonKind: nextKind, testRun: null });
      save();
      if (nextKind === 'prompt' || $('a-response').value || $('b-response').value) post('compare');
    }
    selectView(view);
    if (view === 'history') {
      $('historyStatus').textContent = 'Loading history...';
      post('historyList');
    }
  }
  function historySize(bytes) {
    return bytes < 1024 * 1024 ? Math.ceil(bytes / 1024) + ' KiB' : (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
  }
  function renderHistory(message) {
    historyEntries = message.entries;
    historyActions = [];
    $('historyUsage').textContent = historyEntries.length + ' / ' + message.maxEntries + ' entries · ' +
      historySize(message.totalBytes) + ' / ' + historySize(message.maxBytes);
    $('historyStatus').textContent = '';
    const list = $('historyList');
    list.replaceChildren();
    if (!historyEntries.length) {
      const empty = make('div', '', 'review-empty');
      empty.append(make('h3', 'No saved comparisons yet'),
        make('p', 'Prompt reviews and orchestrated tests are saved automatically, including partial and cancelled runs. Use Save / export to save a prompt draft or other comparison manually.'));
      list.appendChild(empty);
    }
    for (const entry of historyEntries) {
      const card = make('article', '', 'history-card');
      const heading = make('div', '', 'history-entry-heading');
      heading.append(make('h3', entry.title), badge(entry.status));
      if (entry.limited) heading.appendChild(badge('limited', true));
      card.append(heading, make('p', new Date(entry.savedAt).toLocaleString() +
        ' · ' + (entry.comparisonKind === 'prompt' ? 'Prompt comparison' : 'Model comparison') +
        (entry.pairs ? ' · ' + entry.pairs + (entry.pairs === 1 ? ' paired run' : ' paired runs') : '') + ' · ' + historySize(entry.bytes || 0), 'notice'));
      if (entry.error) card.appendChild(make('p', entry.error + ' You can delete this entry or inspect the storage file.', 'warning-callout'));
      else card.appendChild(make('p', entry.comparisonKind === 'prompt'
        ? 'Original and edited prompts · Shared model: ' + entry.baseline
        : 'Baseline: ' + entry.baseline + ' → Candidate: ' + entry.candidate, 'history-models'));
      const actions = make('div', '', 'buttons');
      for (const [type, label] of [['historyOpen', 'Open in Compare'], ['historyDelete', 'Delete']]) {
        const button = make('button', label);
        button.type = 'button';
        button.ariaLabel = label + ': ' + entry.title;
        button.addEventListener('click', () => post(type, { id: entry.id }));
        historyActions.push({ button, unavailable: type === 'historyOpen' && Boolean(entry.error) });
        actions.appendChild(button);
      }
      card.appendChild(actions);
      list.appendChild(card);
    }
    updateHistoryControls();
  }

  const expandedSections = new Map();
  let renderedTestId;
  function disclosure(key, label, className = 'result-details') {
    const element = make('details', '', className);
    element.appendChild(make('summary', label));
    element.open = expandedSections.get(key) || false;
    element.addEventListener('toggle', () => expandedSections.set(key, element.open));
    return element;
  }
  function badge(status, limited = false) {
    const labels = {
      succeeded: 'Response ready', failed: 'Failed', running: 'Running', 'not-started': 'Not started',
      completed: 'Complete', 'completed-limited': 'Finished with limits', partial: 'Needs attention', cancelled: 'Cancelled', 'not-reviewed': 'Not reviewed',
      reviewed: 'Reviewed', saved: 'Saved', draft: 'Draft · not reviewed', unreadable: 'Unreadable', 'review-failed': 'Review failed', 'review-running': 'Review running', 'review-cancelled': 'Review cancelled'
    };
    return make('span', limited ? 'Budget-limited' : labels[status] || status, 'status-badge status-' + (limited ? 'limited' : status));
  }
  function metric(label, value, hint) {
    const tile = make('div', '', 'metric-tile');
    tile.append(make('span', label, 'metric-label'), make('strong', value, 'metric-value'));
    if (hint) tile.appendChild(make('span', hint, 'metric-hint'));
    return tile;
  }
  function preferredBadge() {
    return make('span', '★ Preferred', 'status-badge preferred-badge');
  }
  function variantLabel(side, kind = 'model') {
    return (side === 'baseline' ? 'Baseline' : 'Candidate') + (kind === 'prompt' ? ' prompt' : '');
  }
  function tokenMetric(metrics, title = 'Tokens in / out', hint) {
    const format = (actual, estimated) => actual != null ? actual.toLocaleString(undefined, { maximumFractionDigits: 1 })
      : estimated != null ? '~' + estimated.toLocaleString(undefined, { maximumFractionDigits: 1 }) : 'Unknown';
    const estimated = metrics?.inputTokens == null && metrics?.estimatedInputTokens != null ||
      metrics?.outputTokens == null && metrics?.estimatedOutputTokens != null;
    return metric(title, format(metrics?.inputTokens, metrics?.estimatedInputTokens) + ' / ' +
      format(metrics?.outputTokens, metrics?.estimatedOutputTokens),
      hint ?? (estimated ? '~ Model-counted estimate; not billed usage. Includes all model turns and tool-call output; excludes hidden reasoning.'
        : 'Actual provider usage across all model turns'));
  }
  function readableTime(value) {
    return Number.isFinite(value) ? (value < 1000 ? value + ' ms' : (value / 1000).toFixed(1) + ' s') : 'Not available';
  }
  function renderUsage(container, report, key) {
    if (!report) return;
    const detail = disclosure(key, 'Per-turn costs and pricing assumptions', 'result-details usage-details');
    detail.appendChild(metric('Azure-equivalent cost estimate', report.total, report.hint));
    detail.appendChild(make('p', report.note, 'notice'));
    const source = make('a', 'Official Azure pricing');
    source.href = 'https://azure.microsoft.com/en-us/pricing/details/azure-openai/';
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    detail.appendChild(source);
    const scroll = make('div', '', 'usage-table');
    const table = make('table', '');
    const head = make('tr', '');
    for (const label of ['Request', 'Model', 'Input', 'Output', 'USD short / standard', 'USD long', 'Basis']) {
      const cell = make('th', label);
      cell.setAttribute('scope', 'col');
      head.appendChild(cell);
    }
    const thead = make('thead', ''); thead.appendChild(head); table.appendChild(thead);
    const body = make('tbody', '');
    for (const row of report.rows) {
      const tr = make('tr', '');
      for (const value of [row.label, row.model, row.input, row.output, row.short, row.long, row.note]) tr.appendChild(make('td', value));
      body.appendChild(tr);
    }
    table.appendChild(body); scroll.appendChild(table); detail.appendChild(scroll);
    container.appendChild(detail);
  }
  function renderResponse(container, value, emptyMessage = 'No response was provided for this model.', rawKey) {
    container.replaceChildren();
    const text = String(value ?? '');
    if (!text.trim()) {
      const empty = make('div', '', 'empty-state');
      empty.append(make('strong', 'No response available'), make('p', emptyMessage));
      container.appendChild(empty);
      return;
    }
    const body = make('div', '', 'markdown-body');
    body.tabIndex = 0;
    body.ariaLabel = 'Formatted model response';
    window.CompareLabMarkdown.render(document, body, text);
    const raw = rawKey ? disclosure(rawKey, 'Raw response', 'raw-response') : make('details', '', 'raw-response');
    if (!rawKey) raw.appendChild(make('summary', 'Raw response'));
    raw.appendChild(make('pre', text, 'response-content'));
    container.append(body, raw);
  }

  function updateReviewProgress(phase, record = null) {
    reviewPhase = phase;
    if (!promptReviewRunning) return;
    const titles = {
      prepare: 'Preparing prompt review', evidence: 'Collecting shared tool evidence',
      original: 'Running original prompt', edited: 'Running edited prompt', review: 'Reviewing both outputs'
    };
    const pair = record?.pairs.at(-1);
    $('reviewProgressTitle').textContent = reviewCancelling ? 'Cancelling review...' : titles[phase];
    if (pair) $('reviewProgressTitle').textContent += ' · Run ' + pair.number + ' of ' + record.plan.repetitions;
    const steps = [['prepare', 'Prepare']];
    if ($('comparisonMode').value !== 'end-to-end') steps.push(['evidence', $('evidence').value.trim() ? 'Shared evidence' : 'Collect evidence']);
    steps.push(['original', 'Original output'], ['edited', 'Edited output'], ['review', 'Review outputs']);
    const active = steps.findIndex(([key]) => key === phase);
    $('reviewSteps').replaceChildren();
    for (const [index, [key, title]] of steps.entries()) {
      const actual = pair && (key === 'original' ? pair.baseline.status : key === 'edited' ? pair.candidate.status
        : key === 'review' ? pair.evaluationStatus : 'succeeded');
      const state = actual ? ({ succeeded: 'complete', running: 'active', failed: 'failed', cancelled: 'cancelled' }[actual] || 'pending')
        : index < active ? 'complete' : index === active ? 'active' : 'pending';
      const item = make('li', '', 'review-step');
      item.setAttribute('data-state', state);
      if (state === 'active') item.setAttribute('aria-current', 'step');
      item.append(make('span', state === 'complete' ? 'Done' : state === 'failed' ? 'Failed' : state === 'cancelled' ? 'Stopped' : String(index + 1), 'step-marker'), make('span', title));
      $('reviewSteps').appendChild(item);
    }
  }

  function setPromptReviewRunning(value) {
    promptReviewRunning = value;
    $('reviewProgress').hidden = !value;
    $('reviewProgress').setAttribute('aria-busy', String(value));
    $('reviewStatus').hidden = value;
    $('promptTest').textContent = value ? 'Review in progress...' : 'Review prompt change';
    $(value ? 'progressCancelSlot' : 'cancelReviewSlot').appendChild($('cancelReview'));
    if (reviewClock !== null) clearInterval(reviewClock);
    reviewClock = null;
    if (!value) {
      $('cancelReview').textContent = 'Cancel';
      return;
    }
    reviewCancelling = false;
    $('cancelReview').textContent = 'Cancel review';
    reviewStartedAt = Date.now();
    const tick = () => {
      const seconds = Math.floor((Date.now() - reviewStartedAt) / 1000);
      $('reviewElapsed').textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') + ' elapsed';
    };
    tick();
    reviewClock = setInterval(tick, 1000);
    $('reviewProgressDetail').textContent = 'Choose a model and tools or confirm a tool request in VS Code if prompted. Neither prompt has run yet.';
    updateReviewProgress('prepare');
  }

  function renderTest(record, summary) {
    if (renderedTestId !== record.id) { expandedSections.clear(); renderedTestId = record.id; }
    const container = $('testResults');
    if (comparisonKind === 'prompt' && record.status === 'running') {
      const current = record.pairs.at(-1);
      updateReviewProgress(current?.evaluationStatus === 'running' ? 'review'
        : current?.candidate.status === 'running' ? 'edited' : 'original', record);
    }
    container.hidden = false;
    const reviewed = record.pairs.filter(pair => pair.evaluationStatus === 'succeeded').length;
    const attempts = record.pairs.flatMap(pair => [pair.baseline, pair.candidate]);
    const succeeded = attempts.filter(attempt => attempt.status === 'succeeded').length;
    const limited = attempts.filter(attempt => attempt.result?.investigationBudget?.limited).length;
    const hero = make('div', '', 'analysis-overview');
    const heading = make('div', '', 'analysis-heading');
    const title = record.status === 'running' ? 'Investigations in progress' : !reviewed ? 'No completed comparison yet'
      : summary?.preference === 'baseline' ? 'Baseline preferred for this task'
        : summary?.preference === 'candidate' ? 'Candidate preferred for this task' : 'Investigation results';
    heading.append(make('h2', title), badge(record.status === 'completed' && limited ? 'completed-limited' : record.status));
    hero.append(make('p', 'ANALYSIS OVERVIEW', 'eyebrow'), heading,
      make('p', !reviewed ? 'A comparison needs a response from both models and a completed review. You can still read any available responses below.'
        : record.plan.comparisonMode === 'end-to-end' ? 'These models investigated independently. Different evidence means this is not a controlled model-quality ranking.'
          : summary?.preference === 'inconclusive' ? 'No clear preference emerged. Read the reports and evaluation to compare their strengths and gaps.'
            : 'Review the model reports below. Each run keeps its evidence, limitations, and evaluation details.', 'overview-description'));
    const totals = make('div', '', 'overview-metrics');
    totals.append(metric('Pairs reviewed', reviewed + ' / ' + record.plan.repetitions),
      metric('Responses received', succeeded + ' / ' + record.plan.repetitions * 2),
      metric(limited ? 'Budget-limited answers (saved runs)' : 'Investigation mode', limited ? String(limited)
        : record.plan.comparisonMode === 'end-to-end' ? 'Full agent' : 'Frozen evidence'));
    hero.appendChild(totals);
    if (limited) hero.appendChild(make('p', 'Some answers use limited evidence. Truncation and skipped checks are recorded, not treated as complete investigations.', 'warning-callout'));
    container.replaceChildren(hero);
    const cards = make('div', '', 'analysis-models');
    for (const side of ['baseline', 'candidate']) {
      const completed = record.pairs.filter(pair => pair[side].status === 'succeeded').length;
      const failed = record.pairs.filter(pair => pair[side].status === 'failed').length;
      const budgetLimited = record.pairs.some(pair => pair[side].result?.investigationBudget?.limited);
      const metrics = summary?.metrics[side];
      const preferred = summary?.preference === side;
      const card = make('article', '', 'model-summary-card' + (preferred ? ' model-preferred' : ''));
      const cardHeading = make('div', '', 'model-card-heading');
      cardHeading.append(make('h3', record.plan[side].model || 'Unspecified model'),
        badge(failed ? 'failed' : completed === record.plan.repetitions ? 'succeeded' : record.status === 'running' ? 'running' : record.status === 'cancelled' ? 'cancelled' : 'partial',
          budgetLimited && completed === record.plan.repetitions));
      if (preferred) cardHeading.appendChild(preferredBadge());
      card.append(cardHeading, make('p', variantLabel(side, record.plan.comparisonKind), 'model-role'));
      const values = make('div', '', 'model-metrics');
      values.append(metric('Responses', completed + ' / ' + record.plan.repetitions, failed ? failed + ' failed' : 'Paired runs'),
        metric('Median paired time', readableTime(metrics?.medianLatencyMs), metrics?.latencySamples ? metrics.latencySamples + ' paired samples' : 'No complete timing samples'),
        tokenMetric(metrics, 'Total tokens in / out'),
        tokenMetric(metrics?.tokensPerRun, 'Avg tokens in / out per run', 'Across ' + completed + ' successful runs; ~ means estimated'),
        metric('Model turns', metrics?.modelRequestCount?.toLocaleString() ?? 'Unknown', 'Across successful runs'),
        metric('Tool calls', metrics?.toolCallCount?.toLocaleString() ?? 'Unknown', 'Executed calls across successful runs'));
      card.appendChild(values);
      renderUsage(card, metrics?.usage, 'usage-' + side);
      cards.appendChild(card);
    }
    container.appendChild(cards);
    if (summary?.efficiency) {
      const tradeoff = make('section', '', 'efficiency-tradeoff');
      tradeoff.append(make('h3', 'Quality preference vs. efficiency'),
        make('p', 'Preferred reflects the quality review, not lower token usage, cost, or latency. Tokens accumulate across turns as evidence is sent again.', 'notice'));
      const values = make('div', '', 'overview-metrics');
      for (const item of summary.efficiency) values.appendChild(metric(item.label, item.value, item.hint));
      tradeoff.appendChild(values);
      const evaluator = disclosure('evaluator-usage', 'Evaluator usage (separate from investigations)');
      renderUsage(evaluator, summary.evaluatorUsage, 'evaluator-turns');
      tradeoff.appendChild(evaluator);
      container.appendChild(tradeoff);
    }
    container.appendChild(make('h3', 'Run history', 'section-title'));
    for (const pair of record.pairs) {
      const detail = disclosure('pair-' + pair.number, '', 'run-card');
      const row = detail.children[0];
      const state = attempt => attempt.result?.investigationBudget?.limited ? 'budget-limited'
        : attempt.status === 'succeeded' ? 'ready' : attempt.status === 'not-started' ? 'waiting' : attempt.status;
      row.append(make('strong', 'Run ' + pair.number), make('span', 'Baseline: ' + state(pair.baseline) + ' / Candidate: ' + state(pair.candidate), 'run-summary-text'),
        badge(pair.evaluationStatus === 'succeeded' ? 'reviewed' : pair.evaluationStatus === 'not-started' ? 'not-reviewed' : 'review-' + pair.evaluationStatus));
      detail.appendChild(make('p', 'Generation order: ' + pair.order.join(' then '), 'notice'));
      const responses = make('div', '', 'readable-responses');
      for (const side of ['baseline', 'candidate']) {
        const budget = pair[side].result?.investigationBudget;
        const preferred = pair.evaluationStatus === 'succeeded' && pair.evaluation?.verdict === side;
        const card = make('article', '', 'response-card' + (preferred ? ' model-preferred' : ''));
        const heading = make('div', '', 'model-card-heading');
        heading.append(make('h3', pair[side].result?.model || record.plan[side].model || 'Unspecified model'),
          badge(pair[side].status, budget?.limited));
        if (preferred) heading.appendChild(preferredBadge());
        card.append(heading, make('p', variantLabel(side, record.plan.comparisonKind), 'model-role'));
        const response = make('div', '', 'response-view');
        renderResponse(response, pair[side].result?.response, pair[side].error || 'This run has not produced a response.', 'raw-' + pair.number + '-' + side);
        card.appendChild(response);
        if (pair[side].result) card.appendChild(tokenMetric(pair[side].result));
        const audit = disclosure('audit-' + pair.number + '-' + side, 'Usage and tool details', 'result-details');
        if (budget) {
          audit.appendChild(make('p', 'Model requests: ' + budget.modelRequests + '/' + budget.limits.modelRequests +
            ' | Tool calls: ' + budget.toolCalls + '/' + budget.limits.toolCalls + ' | Skipped calls: ' + budget.skippedToolCalls +
            ' | Retained evidence: ' + budget.evidenceCharacters + '/' + budget.limits.evidenceCharacters + ' characters', 'notice'));
          for (const reason of budget.reasons) audit.appendChild(make('p', reason, 'warning-callout'));
        }
        if (pair[side].result?.toolEvidence) audit.append(make('h4', 'Tool requests and results'),
          make('pre', JSON.stringify(pair[side].result.toolEvidence, null, 2), 'response-content'));
        if (pair[side].result?.provider === 'vscode') audit.appendChild(make('p', 'VS Code model-counted token estimates include all completed turns. ' +
          'Actual billed usage and hidden reasoning tokens are unavailable; instructions sent as user context.', 'notice'));
        if (pair[side].result) card.appendChild(audit);
        responses.appendChild(card);
      }
      detail.appendChild(responses);
      if (pair.evaluation) {
        detail.appendChild(make('p', pair.evaluation.summary, 'assessment-summary'));
        renderCriteria(detail, pair.evaluation.criteria);
      }
      if (pair.evaluationError) detail.appendChild(make('p', pair.evaluationError, 'notice'));
      for (const check of pair.checks) detail.appendChild(make('p', check.phrase + ': baseline ' + (check.baseline ? 'Pass' : 'Fail') + ', candidate ' + (check.candidate ? 'Pass' : 'Fail')));
      container.appendChild(detail);
    }
    const notes = disclosure('notes', 'How to interpret these results', 'result-details analysis-notes');
    if (summary) {
      notes.appendChild(make('p', summary.note, 'notice'));
      for (const warning of summary.warnings) notes.appendChild(make('p', warning, 'notice'));
    } else notes.appendChild(make('p', 'These are repeated investigations of one task, not a model leaderboard. Live queries can return different evidence.', 'notice'));
    const packet = disclosure('inputs', record.plan.comparisonMode === 'end-to-end' ? 'Shared task and instructions' : 'Frozen test input');
    if (record.plan.systemPrompt) packet.append(make('h3', 'Agent instructions'), make('pre', record.plan.systemPrompt, 'response-content'));
    packet.append(make('h3', 'User message'), make('pre', record.plan.requestPrompt, 'response-content'));
    notes.appendChild(packet);
    container.appendChild(notes);
  }
  const verdictLabel = verdict => ({
    baseline: 'Baseline better', candidate: 'Candidate better', tie: 'Tie',
    insufficient_evidence: 'Insufficient evidence'
  })[verdict] || 'Not evaluated';
  const criterionLabel = criterion => ({
    grounding: 'Evidence grounding', reasoning: 'Diagnostic reasoning',
    completeness: 'Completeness', actionability: 'Actionability and safety', uncertainty: 'Uncertainty', clarity: 'Clarity'
  })[criterion] || criterion;
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
          const label = {
            baseline: 'Baseline', candidate: 'Candidate', evidence: 'Source evidence',
            baselineTask: 'Baseline task', candidateTask: 'Candidate task'
          }[citation.source] || citation.source;
          quote.append(make('strong', label), make('p', citation.quote));
          quotes.appendChild(quote);
        }
        row.appendChild(quotes);
      }
      container.appendChild(row);
    }
  }
  function renderEvaluation(assessment, record) {
    const container = $('evaluation');
    container.replaceChildren();
    if (!assessment) {
      const empty = make('div', '', 'review-empty');
      empty.append(make('h3', record ? 'No quality review available' : 'Ready for a quality review'),
        make('p', record ? 'A review appears after both models return responses and the evaluator completes. Available model reports are shown below.'
          : 'Use Evaluate with Copilot to assess the responses against your source evidence. Text differences alone are not a quality score.'));
      container.appendChild(empty);
      return;
    }
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
    renderUsage(audit, assessment.usage, 'selected-evaluator-cost');
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
    ['Output tokens (estimated; VS Code, visible text and tool calls)', 'estimatedOutputTokens'],
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
    renderEvaluation(result.evaluation, result.testRun);
    const selectedPair = result.testRun?.pairs.findLast(pair => pair.baseline.status === 'succeeded' && pair.candidate.status === 'succeeded') || result.testRun?.pairs.at(-1);
    $('responseHeading').textContent = selectedPair ? 'Model reports from Run ' + selectedPair.number : 'Model reports';
    $('responseDescription').textContent = selectedPair
      ? 'Showing the latest pair with two responses, or the last attempted pair if none completed. Other runs are in Run history.'
      : 'Read the formatted reports, or expand Raw response for the original text.';
    for (const side of ['baseline', 'candidate']) {
      const attempt = selectedPair?.[side];
      const limited = attempt?.result?.investigationBudget?.limited;
      const preferred = selectedPair ? selectedPair.evaluationStatus === 'succeeded' && selectedPair.evaluation?.verdict === side
        : result.evaluation?.verdict === side;
      $(side + 'ResponseCard').className = 'response-card' + (preferred ? ' model-preferred' : '');
      $(side + 'ResponseStatus').replaceChildren(badge(attempt?.status || (result[side].response ? 'succeeded' : 'not-started'), limited));
      if (preferred) $(side + 'ResponseStatus').appendChild(preferredBadge());
      $(side + 'ResponseModel').textContent = result[side].model || 'Unspecified model';
      $(side + 'ResponseRole').textContent = variantLabel(side, result.comparisonKind);
      renderResponse($(side + 'Content'), result.content?.[side] ?? result[side].response,
        attempt?.error || 'No response was provided for this model.');
      if (!result.testRun) renderUsage($(side + 'Content'), result[side].usage, 'ordinary-usage-' + side);
    }
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
    if (result.comparisonKind === 'prompt') renderPromptReview(result);
  }
  function renderChanges(container, spans, passages, label) {
    container.replaceChildren();
    if (!passages.length) {
      container.appendChild(make('p', 'No changes.', 'notice'));
      return;
    }
    container.appendChild(make('p', passages.length + (passages.length === 1 ? ' passage changed' : ' passages changed') +
      ' · Unchanged sections hidden', 'notice'));
    for (const [index, excerpt] of passages.entries()) {
      const passage = make('section', '', 'change-passage');
      passage.appendChild(make('h3', 'Change ' + (index + 1)));
      const columns = make('div', '', 'change-pair');
      for (const [side, title] of [['original', 'Original'], ['edited', 'Edited']]) {
        const panel = make('div', '', 'change-version');
        const text = make('div', '', 'change-text');
        panel.append(make('strong', title, 'change-label'), text);
        for (const span of excerpt[side]) text.appendChild(make('span', span.text, span.type));
        if (!excerpt[side].some(span => span.text)) text.appendChild(make('span', 'No text', 'notice'));
        columns.appendChild(panel);
      }
      passage.appendChild(columns);
      container.appendChild(passage);
    }
    const full = make('details', '', 'result-details');
    full.appendChild(make('summary', 'Show full ' + label + ' diff'));
    const diff = make('div', '', 'diff');
    for (const span of spans) diff.appendChild(make('span', span.text, span.type));
    full.appendChild(diff);
    container.appendChild(full);
  }
  function renderPromptReview(result) {
    renderChanges($('promptDiff'), result.promptComparison?.spans || [], result.promptComparison?.passages || [], 'prompt');
    const decision = result.promptDecision;
    const container = $('promptResults');
    const hasOutput = result.baseline.response.trim() || result.candidate.response.trim() || result.testRun;
    container.hidden = !hasOutput;
    if (!decision || !hasOutput) return;
    const hero = make('section', '', 'prompt-verdict verdict-' + decision.verdict.toLowerCase().replaceAll(' ', '-'));
    const record = result.testRun;
    const reviewed = record ? record.pairs.filter(pair => pair.evaluationStatus === 'succeeded').length : result.evaluation ? 1 : 0;
    const complete = record ? record.status === 'completed' && reviewed === record.plan.repetitions : reviewed === 1;
    const state = complete ? 'Review complete' : reviewed ? 'Review incomplete' : 'Not reviewed';
    hero.append(make('p', state.toUpperCase(), 'eyebrow'), make('h2', complete ? decision.verdict : state), make('strong', decision.action),
      make('p', decision.reason), make('p', decision.caveat, 'notice'));
    if (record) hero.appendChild(make('p', reviewed + ' / ' + record.plan.repetitions + ' output pairs reviewed.', 'notice'));
    if (complete && !decision.changes.length) hero.appendChild(make('p',
      'This saved review does not explain the prompt edits. Run Review prompt change for a change-focused assessment.', 'notice'));
    promptCanAdopt = complete && decision.verdict === 'Better';
    const adopt = make('button', 'Use edited prompt as original', 'primary');
    adopt.id = 'adoptPrompt';
    adopt.disabled = busy || !promptCanAdopt;
    adopt.addEventListener('click', () => {
      if (!promptCanAdopt || busy) return;
      fill('a-prompt', $('b-prompt').value);
      clearPromptOutputs(['a', 'b']);
      invalidate(); save(); post('compare');
    });
    hero.appendChild(adopt);
    container.replaceChildren(hero);
    if (result.evidenceCollection) {
      const collection = make('details', '', 'result-details');
      collection.append(make('summary', 'Shared evidence collection (separate from prompt tests)'),
        make('p', 'Collected ' + result.evidenceCollection.collectedAt + ' using ' + result.evidenceCollection.model +
          '. Model turns: ' + result.evidenceCollection.modelRequestCount + '. Tool calls: ' + result.evidenceCollection.toolCallCount +
          '. Not included in either prompt totals.'),
        make('pre', JSON.stringify(result.evidenceCollection, null, 2), 'response-content'));
      container.appendChild(collection);
    }
    for (const change of decision.changes) {
      const item = make('article', '', 'prompt-change');
      item.append(make('h3', change.change), make('span', change.effect, 'status-badge'),
        make('p', change.impact), make('strong', change.recommendation));
      const quotes = make('details', '', 'result-details');
      quotes.appendChild(make('summary', 'See the prompt edit and output evidence'));
      for (const citation of change.citations) {
        const quote = make('blockquote', '');
        quote.append(make('strong', ({
          baselinePrompt: 'Original prompt', candidatePrompt: 'Edited prompt',
          baselineTask: 'Original task', candidateTask: 'Edited task', baseline: 'Original output', candidate: 'Edited output'
        })[citation.source]),
          make('pre', citation.quote, 'response-content'));
        quotes.appendChild(quote);
      }
      item.appendChild(quotes); container.appendChild(item);
    }
    const outputs = make('details', '', 'result-details');
    outputs.appendChild(make('summary', 'Output changes'));
    const outputDiff = make('div', '');
    renderChanges(outputDiff, result.spans, result.outputPassages || [], 'output');
    outputs.appendChild(outputDiff);
    container.appendChild(outputs);
    if (result.testRun) {
      for (const pair of result.testRun.pairs) {
        for (const side of ['baseline', 'candidate']) if (pair[side].error) container.appendChild(make('p',
          'Run ' + pair.number + ' ' + (side === 'baseline' ? 'original' : 'edited') + ': ' + pair[side].error, 'warning-callout'));
        if (pair.evaluationError) container.appendChild(make('p', 'Run ' + pair.number + ' review: ' + pair.evaluationError, 'warning-callout'));
      }
    }
  }
  function clearPromptOutputs(sides) {
    for (const side of sides) {
      runMetadata[side] = { modelVendor: runMetadata[side].modelVendor };
      for (const key of ['response', 'reportedModel', 'modelVersion', 'inputTokens', 'outputTokens', 'finishReason']) fill(side + '-' + key, '');
      $(side + '-status').textContent = '';
    }
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
    runMetadata[side] = {
      elapsedMs: result.elapsedMs, runId: result.runId, modelVendor: result.modelVendor,
      estimatedInputTokens: result.estimatedInputTokens, estimatedOutputTokens: result.estimatedOutputTokens, usageTurns: result.usageTurns
    };
    const keys = ['model', 'provider', 'reportedModel', 'modelVersion', 'response', 'contextWindowTokens', 'contextWindowSource',
      'inputTokens', 'outputTokens', 'maxOutputTokens', 'finishReason', 'temperature'];
    for (const key of keys) fill(side + '-' + key, result[key]);
    // Provider-generated answers are pinned to their actual prompt to keep exported experiments reproducible.
    fill(side + '-prompt', result.promptTemplate ?? result.prompt);
    updateComparisonLayout();
    $(side + '-status').textContent = 'Done · ' + result.elapsedMs + ' ms · '
      + (result.inputTokens ?? (result.estimatedInputTokens != null ? '~' + result.estimatedInputTokens : '?')) + ' input / '
      + (result.outputTokens ?? (result.estimatedOutputTokens != null ? '~' + result.estimatedOutputTokens : '?')) + ' output tokens'
      + (result.inputTokens == null && result.estimatedInputTokens != null || result.outputTokens == null && result.estimatedOutputTokens != null
        ? ' (~ estimated, not billed usage)' : '');
    save();
    post('compare');
  }
  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'historyList') renderHistory(msg);
    if (msg.type === 'historyBusy') { historyBusy = msg.value; updateHistoryControls(); }
    if (msg.type === 'historySaved') {
      $('historySaveStatus').textContent = msg.revision != null && msg.revision !== revision
        ? 'The earlier comparison was saved to history. Current edits have not been saved.' : msg.message;
      if (activeView === 'history') post('historyList');
    }
    if (msg.type === 'historyError') {
      $('historyStatus').textContent = msg.message;
      $('historySaveStatus').textContent = msg.message;
    }
    if (msg.type === 'historyStatus') $('historyStatus').textContent = msg.message;
    if (msg.type === 'historyOpened') {
      restore(msg.experiment);
      showView(comparisonKind === 'prompt' ? 'prompt' : 'compare');
      revealHistoryResult = true;
      $('historySaveStatus').textContent = 'Opened a copy saved ' + new Date(msg.savedAt).toLocaleString() + '. Editing will not change the saved entry.';
      post('compare');
    }
    if (msg.type === 'result' && msg.revision === revision) {
      render(msg.result);
      if (revealHistoryResult && activeView !== 'history') {
        const target = $(comparisonKind === 'prompt' ? 'promptResults' : msg.result.testRun ? 'testResults' : 'results');
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'start' });
      }
      revealHistoryResult = false;
    }
    if (msg.type === 'imported') { restore(msg.experiment); save(); post('compare'); }
    if (msg.type === 'instructionsLoaded') {
      fill(['a', 'b'].includes(msg.side) ? msg.side + '-prompt' : 'prompt', msg.prompt);
      if (comparisonKind === 'prompt') clearPromptOutputs([msg.side === 'a' ? 'a' : 'b']);
      invalidate(); updateComparisonLayout(); save();
      if (comparisonKind === 'prompt') post('compare');
    }
    if (msg.type === 'modelSelected' && ['a', 'b'].includes(msg.side)) {
      const side = msg.side;
      for (const key of ['endpoint', 'contextWindowTokens', 'maxOutputTokens', 'temperature', 'reportedModel', 'modelVersion', 'inputTokens', 'outputTokens', 'finishReason']) fill(side + '-' + key, '');
      fill(side + '-provider', 'vscode');
      fill(side + '-model', msg.model.id);
      fill(side + '-contextWindowSource', 'unverified');
      runMetadata[side] = { modelVendor: msg.model.vendor };
      if (comparisonKind === 'prompt') clearPromptOutputs(['a', 'b']);
      invalidate(); updateRunner(side); save();
    }
    if (msg.type === 'toolsSelected') {
      const changed = JSON.stringify(toolSelection) !== JSON.stringify(msg.names);
      toolSelection = msg.names;
      if (changed) {
        if (evidenceCollection) { fill('evidence', ''); evidenceCollection = null; }
        if (comparisonKind === 'prompt') clearPromptOutputs(['a', 'b']);
        invalidate();
      }
      updateToolSummary(); save();
    }
    if (msg.type === 'testFinished') {
      restore(msg.experiment);
      if (comparisonKind === 'prompt') revealHistoryResult = true;
      save(); post('compare');
    }
    if (msg.type === 'sharedEvidence' && comparisonKind === 'prompt') {
      fill('evidence', msg.evidence);
      evidenceCollection = msg.evidenceCollection;
      save();
    }
    if (msg.type === 'testUpdate') {
      testRun = msg.record;
      renderTest(testRun, msg.summary);
      $('reviewStatus').textContent = msg.message;
      if (promptReviewRunning) $('reviewProgressDetail').textContent = msg.message;
      save();
    }
    if (msg.type === 'runResult' && ['a', 'b'].includes(msg.side)) applyRun(msg.side, msg.result);
    if (msg.type === 'runStatus' && ['a', 'b'].includes(msg.side)) $(msg.side + '-status').textContent = msg.message;
    if (msg.type === 'reviewStatus') {
      $('reviewStatus').textContent = msg.message;
      if (promptReviewRunning) {
        $('reviewProgressDetail').textContent = msg.message;
        if (msg.phase) updateReviewProgress(msg.phase);
      }
    }
    if (msg.type === 'optimizerStatus') $('optimizerStatus').textContent = msg.message;
    if (msg.type === 'optimizerDraft' && msg.revision === revision && comparisonKind === 'prompt') {
      optimizerDraft = msg.draft;
      fill('optimizerDraft', msg.draft.prompt);
      $('optimizerSummary').textContent = msg.draft.summary;
      $('optimizerPreview').hidden = false;
      $('optimizerStatus').textContent = 'Draft ready. Review it before applying; neither prompt has changed.';
      save();
    }
    if (msg.type === 'busy') {
      busy = msg.value;
      document.querySelectorAll('input,textarea,select,button').forEach(element => {
        element.disabled = busy || element.id === 'adoptPrompt' && !promptCanAdopt;
      });
      $('cancelReview').hidden = !busy || !['evaluation', 'test', 'run', 'optimizer'].includes(msg.kind);
      $('cancelReview').disabled = false;
      if (busy && msg.kind === 'evaluation') renderEvaluation(null);
      if (busy && msg.kind === 'test') invalidate();
      setPromptReviewRunning(busy && msg.kind === 'test' && comparisonKind === 'prompt');
      for (const side of ['a', 'b']) updateRunner(side);
      updateHistoryControls();
    }
  });
  const views = ['compare', 'prompt', 'history'];
  for (const view of views) {
    $(view + 'Tab').addEventListener('click', () => showView(view));
    $(view + 'Tab').addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'compare' : event.key === 'End' ? 'history'
        : views[(views.indexOf(view) + (event.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length];
      showView(next);
      $(next + 'Tab').focus();
    });
  }
  $('historySave').addEventListener('click', () => post('historySave'));
  $('historyClear').addEventListener('click', () => post('historyClear'));
  $('historyRefresh').addEventListener('click', () => { $('historyStatus').textContent = 'Loading history...'; post('historyList'); });
  $('compare').addEventListener('click', () => post('compare'));
  $('evaluate').addEventListener('click', () => post('evaluate'));
  $('chat').addEventListener('click', () => post('chat'));
  $('cancelReview').addEventListener('click', () => {
    if (promptReviewRunning) {
      reviewCancelling = true;
      $('cancelReview').disabled = true;
      $('cancelReview').textContent = 'Cancelling...';
      updateReviewProgress(reviewPhase);
      $('reviewProgressDetail').textContent = 'Waiting for the active request to stop. Any completed work will be kept in History.';
    }
    post('cancelReview');
  });
  $('import').addEventListener('click', () => post('import'));
  $('export').addEventListener('click', () => post('export'));
  $('report').addEventListener('click', () => post('report'));
  $('htmlReport').addEventListener('click', () => post('htmlReport'));
  $('runBoth').addEventListener('click', () => post('runBoth'));
  $('orchestrate').addEventListener('click', () => post('orchestrate'));
  $('promptTest').addEventListener('click', () => post('orchestrate'));
  $('promptFreshEvidence').addEventListener('click', () => {
    fill('evidence', '');
    fill('comparisonMode', 'model-prompt-only');
    evidenceCollection = null;
    clearPromptOutputs(['a', 'b']);
    invalidate(); save(); post('orchestrate');
  });
  $('promptReviewOutputs').addEventListener('click', () => post('evaluate'));
  $('generatePrompt').addEventListener('click', () => {
    $('optimizerStatus').textContent = 'Choosing a rewriting model...';
    post('generatePrompt', { guidance: { goal: $('optimizerGoal').value, preserve: $('optimizerPreserve').value, success: $('optimizerSuccess').value } });
  });
  $('applyPromptDraft').addEventListener('click', () => {
    if (busy || !optimizerDraft) return;
    const draft = $('optimizerDraft').value;
    if (!draft.trim() || draft.length > 150000) {
      $('optimizerStatus').textContent = 'Draft must contain 1 to 150,000 characters.';
      return;
    }
    fill('b-prompt', draft);
    clearPromptOutputs(['b']);
    invalidate(); save(); post('compare');
    $('optimizerStatus').textContent = 'Draft applied to the edited prompt. Review the diff, then test it explicitly.';
  });
  $('loadInstructions').addEventListener('click', () => post('loadInstructions'));
  $('selectTools').addEventListener('click', () => post('selectTools'));
  for (const side of ['a', 'b']) {
    $(side + '-loadInstructions').addEventListener('click', () => post('loadInstructions', { side }));
    $(side + '-selectModel').addEventListener('click', () => post('selectModel', { side }));
    $(side + '-run').addEventListener('click', () => post('run', { side }));
    $(side + '-key').addEventListener('click', () => post('setKey', { side }));
    $(side + '-provider').addEventListener('change', () => {
      if ($(side + '-provider').value === 'vscode') for (const key of ['endpoint', 'contextWindowTokens', 'maxOutputTokens', 'temperature']) fill(side + '-' + key, '');
      updateRunner(side); save();
    });
  }
  document.querySelectorAll('input,textarea,select').forEach(el => el.addEventListener('input', () => {
    if (el.id?.startsWith('optimizer')) { revision++; save(); return; }
    if (comparisonKind === 'prompt') {
      if (el.id === 'evidence') evidenceCollection = null;
      if (el.id === 'incomingMessage' && evidenceCollection) { fill('evidence', ''); evidenceCollection = null; }
      if (['a-prompt', 'b-prompt'].includes(el.id)) clearPromptOutputs([el.id.slice(0, 1)]);
      else if (!/response$/.test(el.id) && !['checks', 'testRepetitions', 'checkOrder', 'comparisonMode'].includes(el.id)) clearPromptOutputs(['a', 'b']);
    }
    if (/^[ab]-/.test(el.id)) {
      const side = el.id.slice(0, 1);
      runMetadata[side] = /-(model|provider)$/.test(el.id) ? {} : { modelVendor: runMetadata[side].modelVendor };
    }
    invalidate();
    updateRunner('a');
    updateComparisonLayout();
    save();
    if (comparisonKind === 'prompt') post('compare');
  }));
  restore(vscode.getState());
  updateToolSummary();
  updateComparisonLayout();
  for (const side of ['a', 'b']) updateRunner(side);
  updateHistoryControls();
  if (comparisonKind === 'prompt' || $('a-response').value || $('b-response').value) post('compare');
})();