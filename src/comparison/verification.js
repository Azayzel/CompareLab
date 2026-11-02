'use strict';
const { createHash } = require('node:crypto');
const { responseContent } = require('./response');

const digest = value => createHash('sha256').update(value).digest('hex');
function validateVerification(config) {
  if (config === undefined || config === null) return null;
  if (config.kind !== 'node-commonjs' || typeof config.name !== 'string' || !config.name.trim() ||
      config.name.length > 200 || typeof config.source !== 'string' || !config.source.trim() ||
      Buffer.byteLength(config.source) > 65536 || !Number.isInteger(config.timeoutSeconds) ||
      config.timeoutSeconds < 5 || config.timeoutSeconds > 120) {
    throw new Error('Invalid executable checker. Use a single Node.js node:test script, at most 64 KiB, and a 5-120 second deadline.');
  }
  return { kind: config.kind, name: config.name, source: config.source, timeoutSeconds: config.timeoutSeconds };
}

function extractModule(response) {
  const text = responseContent(response);
  const blocks = [...text.matchAll(/^```([^\n]*)\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length !== 1 || !/^(?:javascript|js|cjs|node|commonjs)?$/i.test(blocks[0][1].trim())) {
    throw new Error('Executable checks require exactly one JavaScript/CommonJS fenced code block.');
  }
  return blocks[0][2];
}

function verificationMatches(value, input) {
  const config = input.verification;
  return !!config && value?.checkerHash === digest(config.source) &&
    /^sha256:[a-f0-9]{64}$/.test(value.image || '') &&
    ['baseline', 'candidate'].every(side => value[side]?.responseHash === digest(responseContent(input[side]?.response)) &&
      ['passed', 'failed', 'error', 'timeout'].includes(value[side]?.status) &&
      typeof value[side].detail === 'string' && Buffer.byteLength(value[side].detail) <= 65536 &&
      (value[side].status !== 'passed' || Number.isSafeInteger(value[side].tests) && value[side].tests > 0 &&
        value[side].passed === value[side].tests && value[side].failed === 0 && value[side].exitCode === 0));
}

function verificationEvidence(value) {
  return '\n\nEXECUTABLE CHECK OBSERVATIONS (limited to this checker, not proof of general correctness)\n' +
    JSON.stringify(value);
}

module.exports = { digest, validateVerification, extractModule, verificationMatches, verificationEvidence };
