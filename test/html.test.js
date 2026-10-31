'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { asHtml } = require('../src/reporting/html');
const { compare } = require('../src/comparison/core');
const { orchestrateTest } = require('../src/comparison/orchestration');

const assets = {
  css: ['style.css', 'runners.css'].map(file => fs.readFileSync(path.join(__dirname, '../media', file), 'utf8')).join('\n'),
  markdownScript: fs.readFileSync(path.join(__dirname, '../media/markdown.js'), 'utf8')
};
const input = () => ({ prompt: 'Diagnose the alert.', evidence: 'HTTP 401 increased.', baseline: {
  model: 'model-a', response: '# Findings\n\n**401 increased.**', inputTokens: 120, outputTokens: 30, elapsedMs: 1200
}, candidate: { model: 'model-b', response: '# Findings\n\n- Inspect authentication', estimatedInputTokens: 150,
  estimatedOutputTokens: 40, elapsedMs: 1000 } });
const assessment = { verdict: 'candidate', orderConsistent: true, model: { name: 'Evaluator' },
  summary: 'Prefer the targeted next check.', criteria: [{ criterion: 'grounding', verdict: 'candidate',
    rationale: 'The evidence supports an authentication check.', citations: [{ source: 'evidence', quote: 'HTTP 401 increased.' }] }],
  unknowns: ['Root cause not verified.'], judgments: [], inputTokenEstimates: [] };

test('HTML report embeds styling and safe Markdown locally, with token provenance and preference highlights', () => {
  const result = compare(input());
  result.evaluation = assessment;
  const html = asHtml(result, assets);
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Model comparison · Offline assessment report/);
  assert.match(html, /candidate[\s\S]*response-card model-preferred/i);
  assert.match(html, /★ Preferred/);
  assert.match(html, /class="model-card-heading"><h3>model-a<\/h3>/);
  assert.match(html, /class="model-card-heading"><h3>model-b<\/h3>/);
  assert.match(html, /class="model-role">Baseline<\/p>/);
  assert.match(html, /class="model-role">Candidate<\/p>/);
  assert.doesNotMatch(html, /<h3>Baseline<\/h3>|<h3>Candidate<\/h3>/);
  assert.match(html, /120 \/ 30/);
  assert.match(html, /~150 \/ ~40/);
  assert.match(html, /not billed usage/);
  assert.match(html, /1\.2 s/);
  assert.match(html, /Source citations/);
  assert.match(html, /HTTP 401 increased/);
  assert.match(html, /Root cause not verified/);
  assert.match(html, /Inputs &amp; audit trail/);
  assert.match(html, /Raw response/);
  assert.match(html, /@media print/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|onload=/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(html)[1];
  assert.ok([...html.matchAll(/<script\b([^>]*)>/g)].every(match => match[1].includes(`nonce="${nonce}"`)));
  const payload = JSON.parse(/<script id="reportData"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(payload[0], input().baseline.response);
  assert.equal(payload[1], input().candidate.response);
});

test('untrusted report content cannot escape markup, attributes, or the embedded JSON script', () => {
  const malicious = '</script><img src=x onerror=alert(1)><script>alert("bad")</script>';
  const experiment = input();
  experiment.baseline.model = '"><script>alert(1)</script>';
  experiment.candidate.response = malicious;
  experiment.prompt = '<svg onload=alert(1)>';
  experiment.evidence = malicious;
  const result = compare(experiment);
  result.evaluation = { ...assessment, summary: malicious };
  const html = asHtml(result, assets);
  assert.doesNotMatch(html, /<img src=x|<svg onload|<script>alert/);
  assert.match(html, /&lt;img src=x/);
  const json = /<script id="reportData"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.doesNotMatch(json, /</);
  assert.equal(JSON.parse(json)[1], malicious);
});

test('partial prompt runs export all attempted pairs, errors, evidence, and separate prompt instructions', async () => {
  const experiment = { prompt: '', evidence: 'HTTP 401 increased.', comparisonKind: 'prompt',
    test: { repetitions: 2 }, baseline: { provider: 'ollama', model: 'same', prompt: 'Baseline instructions' },
    candidate: { provider: 'ollama', model: 'same', prompt: 'Candidate instructions' } };
  let attempts = 0;
  const record = await orchestrateTest(experiment, {
    comparePair: compare, evaluatePair: async () => assessment,
    runVariant: async (request, side) => {
      if (++attempts === 4) throw new Error('Provider unavailable');
      return { ...request, response: side + ' report', inputTokens: 10, outputTokens: 5 };
    }
  });
  const pair = record.pairs[0];
  const result = compare({ ...experiment, testRun: record,
    baseline: { ...experiment.baseline, response: pair.baseline.result.response },
    candidate: { ...experiment.candidate, response: pair.candidate.result.response } });
  const html = asHtml(result, assets);
  assert.match(html, /Prompt comparison · Offline assessment report/);
  assert.match(html, /Run 1/);
  assert.match(html, /Run 2/);
  assert.match(html, /Provider unavailable/);
  assert.match(html, /Baseline instructions/);
  assert.match(html, /Candidate instructions/);
  assert.match(html, /class="model-role">Baseline prompt<\/p>/);
  assert.match(html, /class="model-role">Candidate prompt<\/p>/);
  assert.match(html, /partial/);
  assert.doesNotMatch(html, /model-summary-card model-preferred/);
});
