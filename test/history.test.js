const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHistory, HISTORY_LIMITS } = require('../src/history');

const comparison = title => ({ prompt: title, baseline: { model: 'baseline', response: 'First response' },
  candidate: { model: 'candidate', response: 'Second response' } });
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comparelab-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('snapshots survive new store instances and listing returns metadata without response contents', async t => {
  const root = await directory(t);
  const store = createHistory(root);
  const input = comparison('Saved comparison');
  const { entry } = await store.save(input);
  input.baseline.response = 'Later edit';
  const reopened = createHistory(root);
  assert.equal((await reopened.get(entry.id)).experiment.baseline.response, 'First response');
  const list = await reopened.list();
  assert.equal(list.entries[0].title, 'Saved comparison');
  assert.equal(list.entries[0].baseline, 'baseline');
  assert.ok(!JSON.stringify(list).includes('First response'));
  assert.equal(list.totalBytes, (await fs.stat(path.join(root, entry.id + '.json'))).size);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(root, entry.id + '.json'))).mode & 0o777, 0o600);
  assert.ok((await fs.readdir(root)).every(file => file.endsWith('.json')));
});

test('keeps at most the latest 50 entries and removes the oldest', async t => {
  const store = createHistory(await directory(t));
  assert.deepEqual(HISTORY_LIMITS, { maxEntries: 50, maxBytes: 100 * 1024 * 1024 });
  const first = await store.save(comparison('First'));
  await new Promise(resolve => setTimeout(resolve, 2));
  for (let i = 0; i < 50; i++) await store.save(comparison('Later ' + i));
  const list = await store.list();
  assert.equal(list.entries.length, 50);
  assert.ok(!list.entries.some(entry => entry.id === first.entry.id));
  await assert.rejects(store.get(first.entry.id), /no longer in history/);
});

test('prompt drafts persist across store instances and are listed as unreviewed drafts', async t => {
  const root = await directory(t);
  const input = { comparisonKind: 'prompt', incomingMessage: 'Shared alert', evidence: 'Frozen evidence',
    baseline: { model: 'shared', prompt: 'Original prompt' }, candidate: { model: 'shared', prompt: 'Edited prompt' } };
  const { entry } = await createHistory(root).save(input);
  const reopened = createHistory(root);
  const list = await reopened.list();
  assert.equal(list.entries[0].comparisonKind, 'prompt');
  assert.equal(list.entries[0].status, 'draft');
  assert.deepEqual((await reopened.get(entry.id)).experiment, input);
});

test('enforces exact serialized UTF-8 byte limits, retaining entries at the boundary', async t => {
  const root = await directory(t);
  const input = comparison('Evidence: ' + 'é'.repeat(100));
  const first = await createHistory(root).save(input);
  const store = createHistory(root, { maxEntries: 50, maxBytes: first.entry.bytes * 2 });
  await new Promise(resolve => setTimeout(resolve, 2));
  await store.save(input);
  assert.equal((await store.list()).totalBytes, first.entry.bytes * 2);
  await new Promise(resolve => setTimeout(resolve, 2));
  await store.save(input);
  const list = await store.list();
  assert.equal(list.entries.length, 2);
  assert.equal(list.totalBytes, first.entry.bytes * 2);
  assert.ok(!list.entries.some(entry => entry.id === first.entry.id));
  const before = await fs.readdir(root);
  await assert.rejects(store.save(comparison('x'.repeat(first.entry.bytes * 2))), /too large/);
  assert.deepEqual(await fs.readdir(root), before, 'Oversized saves must not evict existing snapshots');
});

test('independent stores can save concurrently without overwriting each other', async t => {
  const root = await directory(t);
  const stores = [createHistory(root), createHistory(root)];
  await Promise.all(Array.from({ length: 12 }, (_, index) => stores[index % 2].save(comparison('Concurrent ' + index))));
  const list = await stores[0].list();
  assert.equal(list.entries.length, 12);
  assert.equal(new Set(list.entries.map(entry => entry.id)).size, 12);
  assert.ok((await fs.readdir(root)).every(file => file.endsWith('.json')));
});

test('corrupt entries remain visible and deletable without hiding valid history', async t => {
  const root = await directory(t);
  const store = createHistory(root);
  const good = await store.save(comparison('Readable'));
  const bad = await store.save(comparison('Damaged'));
  await fs.writeFile(path.join(root, bad.entry.id + '.json'), '{ invalid');
  const list = await store.list();
  assert.equal(list.entries.length, 2);
  assert.equal(list.entries.find(entry => entry.id === bad.entry.id).status, 'unreadable');
  assert.equal(list.entries.find(entry => entry.id === good.entry.id).title, 'Readable');
  await assert.rejects(store.get(bad.entry.id), /invalid JSON/);
  await store.delete(bad.entry.id);
  assert.equal((await store.list()).entries.length, 1);
  await assert.rejects(store.get('../private'), /Invalid history entry ID/);
  await assert.rejects(store.delete('../private'), /Invalid history entry ID/);
});

test('unavailable storage reports errors; clearing touches only history snapshots', async t => {
  const root = await directory(t);
  const blocked = path.join(root, 'blocked');
  await fs.writeFile(blocked, 'Not a directory');
  await assert.rejects(createHistory(blocked).save(comparison('Cannot save')));
  const store = createHistory(path.join(root, 'history'));
  assert.deepEqual((await store.list()).entries, []);
  await store.save(comparison('First'));
  await store.save(comparison('Second'));
  await fs.writeFile(path.join(root, 'history', 'keep.txt'), 'Unrelated file');
  await store.clear();
  assert.deepEqual((await store.list()).entries, []);
  assert.equal(await fs.readFile(path.join(root, 'history', 'keep.txt'), 'utf8'), 'Unrelated file');
});
