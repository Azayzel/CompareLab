#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { compare, asMarkdown } = require('../src/core');
const args = process.argv.slice(2);
if (args.length < 1 || args.includes('--help')) {
  console.log('Usage: node bin/comparelab.js experiment.json [--format json|md]\nInput: { "prompt": "...", "baseline": {...}, "candidate": {...}, "checks": {"requiredPhrases": [...]}}');
  process.exit(args.includes('--help') ? 0 : 1);
}
try {
  const index = args.indexOf('--format');
  const format = index < 0 ? 'json' : args[index + 1];
  if (!['json', 'md'].includes(format)) throw new Error('Expected --format json or md');
  const experiment = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  const result = compare(experiment);
  process.stdout.write(format === 'json' ? JSON.stringify(result, null, 2) + '\n' : asMarkdown(result) + '\n');
} catch (err) {
  console.error('CompareLab:', err.message);
  process.exitCode = 1;
}
