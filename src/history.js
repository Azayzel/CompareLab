'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const HISTORY_LIMITS = { maxEntries: 50, maxBytes: 100 * 1024 * 1024 };
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function validateSnapshot(snapshot, id) {
  const invalid = () => { throw Object.assign(new Error('This history snapshot is damaged or uses an unsupported format.'), { code: 'HISTORY_INVALID' }); };
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.id !== id || typeof snapshot.savedAt !== 'string' ||
      !Number.isFinite(Date.parse(snapshot.savedAt)) || new Date(snapshot.savedAt).toISOString() !== snapshot.savedAt ||
      !snapshot.experiment || typeof snapshot.experiment !== 'object' || Array.isArray(snapshot.experiment)) invalid();
  if (snapshot.experiment.testRun && (!Array.isArray(snapshot.experiment.testRun.pairs) ||
      !snapshot.experiment.testRun.pairs.every(pair => pair && typeof pair === 'object'))) invalid();
  const assessment = snapshot.evaluation;
  if (assessment != null) {
    if (typeof assessment.inputFingerprint !== 'string' || !assessment.model || !Array.isArray(assessment.unknowns) ||
        !Array.isArray(assessment.judgments) || !Array.isArray(assessment.inputTokenEstimates)) invalid();
    for (const judgment of [assessment, ...assessment.judgments]) {
      if (!judgment || typeof judgment.summary !== 'string' || !['baseline', 'candidate', 'tie', 'insufficient_evidence'].includes(judgment.verdict) ||
          !Array.isArray(judgment.criteria)) invalid();
      for (const criterion of judgment.criteria) {
        if (!criterion || typeof criterion.criterion !== 'string' || !Array.isArray(criterion.citations) ||
            !criterion.citations.every(citation => citation && typeof citation.source === 'string' && typeof citation.quote === 'string')) invalid();
      }
    }
  }
  return snapshot;
}

function metadata(snapshot, bytes) {
  const input = snapshot.experiment;
  const record = input.testRun;
  return {
    id: snapshot.id, savedAt: snapshot.savedAt, bytes,
    title: String(input.incomingMessage || input.prompt || input.baseline?.prompt || 'Untitled comparison').replace(/\s+/g, ' ').trim().slice(0, 120),
    comparisonKind: input.comparisonKind || 'model',
    baseline: String(input.baseline?.model || 'Unspecified model'), candidate: String(input.candidate?.model || 'Unspecified model'),
    status: record?.status || (snapshot.evaluation ? 'reviewed' : 'saved'),
    limited: Boolean(record?.pairs?.some(pair => ['baseline', 'candidate'].some(side => pair[side]?.result?.investigationBudget?.limited))),
    pairs: record?.pairs?.length ?? 0
  };
}

function createHistory(directory, limits = HISTORY_LIMITS) {
  const filename = id => {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid history entry ID.');
    return path.join(directory, id + '.json');
  };
  async function removeIfPresent(file) {
    try { await fs.unlink(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function read(id) {
    const file = filename(id);
    const stat = await fs.stat(file);
    if (stat.size > limits.maxBytes) throw Object.assign(new Error('History snapshot exceeds the storage limit.'), { code: 'HISTORY_INVALID' });
    let snapshot;
    try { snapshot = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) {
      if (error instanceof SyntaxError) throw Object.assign(new Error('History snapshot contains invalid JSON.'), { code: 'HISTORY_INVALID' });
      throw error;
    }
    return { snapshot: validateSnapshot(snapshot, id), bytes: stat.size };
  }
  async function entries() {
    let files;
    try { files = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const found = await Promise.all(files.filter(file => file.isFile() && file.name.endsWith('.json') && ID.test(file.name.slice(0, -5))).map(async file => {
      const id = file.name.slice(0, -5);
      try {
        const { snapshot, bytes } = await read(id);
        return metadata(snapshot, bytes);
      } catch (error) {
        if (error.code === 'ENOENT') return null; // Another window may delete a snapshot while the list loads.
        if (error.code !== 'HISTORY_INVALID') throw error;
        let stat;
        try { stat = await fs.stat(filename(id)); }
        catch (statError) { if (statError.code === 'ENOENT') return null; throw statError; }
        return { id, savedAt: stat.mtime.toISOString(), bytes: stat.size, title: 'Unreadable comparison',
          status: 'unreadable', error: error.message };
      }
    }));
    return found.filter(Boolean).sort((a, b) => b.savedAt.localeCompare(a.savedAt) || b.id.localeCompare(a.id));
  }
  return {
    async list() {
      const items = await entries();
      return { entries: items, totalBytes: items.reduce((sum, item) => sum + item.bytes, 0), ...limits };
    },
    async save(experiment, evaluation = null) {
      const id = randomUUID();
      const snapshot = validateSnapshot({ schemaVersion: 1, id, savedAt: new Date().toISOString(), experiment, evaluation }, id);
      const content = JSON.stringify(snapshot);
      const bytes = Buffer.byteLength(content);
      if (bytes > limits.maxBytes) throw new Error('Comparison is too large for history. Export it as JSON instead; existing history was not changed.');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, id + '.tmp');
      try {
        await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, filename(id));
      } finally {
        await removeIfPresent(temporary);
      }
      // Independent, atomically published files avoid lost updates between VS Code windows.
      const items = await entries();
      let total = items.reduce((sum, item) => sum + item.bytes, 0);
      let count = items.length;
      let removed = 0;
      for (const item of [...items].reverse()) {
        if (count <= limits.maxEntries && total <= limits.maxBytes) break;
        await removeIfPresent(filename(item.id));
        total -= item.bytes;
        count--;
        removed++;
      }
      try { await fs.access(filename(id)); }
      catch (error) {
        if (error.code === 'ENOENT') throw new Error('Newer comparisons displaced this snapshot under the history limits. Export JSON to keep a copy.');
        throw error;
      }
      return { entry: metadata(snapshot, bytes), removed };
    },
    async get(id) {
      try { return (await read(id)).snapshot; }
      catch (error) {
        if (error.code === 'ENOENT') throw new Error('This comparison is no longer in history. Refresh the list.');
        throw error;
      }
    },
    async delete(id) {
      try { await fs.unlink(filename(id)); }
      catch (error) {
        if (error.code === 'ENOENT') throw new Error('This comparison is no longer in history. Refresh the list.');
        throw error;
      }
    },
    async clear() {
      const items = await entries();
      await Promise.all(items.map(item => removeIfPresent(filename(item.id))));
    }
  };
}

module.exports = { createHistory, HISTORY_LIMITS };
