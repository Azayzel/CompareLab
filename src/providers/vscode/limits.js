'use strict';

const MAX_PROMPT_CHARACTERS = 150000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MODEL_TIMEOUT_SECONDS = 600;

function modelTimeoutSeconds(value = DEFAULT_MODEL_TIMEOUT_SECONDS) {
  if (!Number.isInteger(value) || value < 30 || value > 3600) {
    throw new Error('VS Code timeout must be a whole number between 30 and 3600 seconds.');
  }
  return value;
}

module.exports = { MAX_PROMPT_CHARACTERS, MAX_RESPONSE_BYTES, DEFAULT_MODEL_TIMEOUT_SECONDS, modelTimeoutSeconds };
