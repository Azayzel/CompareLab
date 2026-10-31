'use strict';

function responseContent(value) {
  const text = String(value ?? '');
  let parsed;
  try { parsed = JSON.parse(text); } catch { return text; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text;
  const entries = Object.entries(parsed);
  if (!entries.some(([key, content]) => /^(analysis|recommendation)$/i.test(key) && typeof content === 'string')) return text;
  return entries.filter(([key]) => !/^(eventid|agentdefinition|completedat|model|reportedmodel|modelversion|provider|runid)$/i.test(key))
    .map(([key, content]) => key + '\n\n' + (typeof content === 'string' ? content : JSON.stringify(content, null, 2)))
    .join('\n\n');
}

module.exports = { responseContent };
