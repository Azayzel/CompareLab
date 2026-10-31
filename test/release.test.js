const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseVersion, compareVersions, releasePlan, releaseState } = require('../scripts/release-version');

test('packaging configuration and locked downloads use the public npm registry', () => {
  const npmrc = fs.readFileSync(path.join(__dirname, '../.npmrc'), 'utf8');
  const registries = [...npmrc.matchAll(/^\s*(?:@[^:\s]+:)?registry\s*=\s*(\S+)\s*$/gm)].map(match => match[1]);
  assert.deepEqual(registries, ['https://registry.npmjs.org/']);
  for (const [name, dependency] of Object.entries(require('../package-lock.json').packages)) {
    if (dependency.resolved) assert.equal(new URL(dependency.resolved).origin, 'https://registry.npmjs.org', name);
  }
});

test('release versions increment the highest stable version numerically', () => {
  assert.equal(releasePlan('0.2.0', [], []).version, '0.2.1');
  assert.equal(releasePlan('0.2.0', ['v0.2.9', 'v0.2.10', 'preview', 'v0.3.0-beta.1'], []).version, '0.2.11');
  assert.equal(releasePlan('0.3.0', ['v0.2.10'], []).version, '0.3.1');
  assert.equal(releasePlan('0.2.0', ['v1.0.0', 'v0.99.99'], []).version, '1.0.1');
  assert.ok(compareVersions('0.2.10', '0.2.9') > 0);
});

test('reruns reuse the commit tag and ambiguous release tags fail', () => {
  assert.deepEqual(releasePlan('0.2.0', ['v0.2.1', 'v0.2.2'], ['v0.2.1']), {
    version: '0.2.1', tag: 'v0.2.1', tagExists: true, latestTag: 'v0.2.2'
  });
  assert.throws(() => releasePlan('0.2.0', ['v0.2.1', 'v0.2.2'], ['v0.2.1', 'v0.2.2']), /Multiple release tags/);
});

test('release versions reject prereleases, malformed values, and unsafe numbers', () => {
  for (const value of [undefined, null, 123, 'v1.2.3', '1.2', '1.2.3-beta', '01.2.3', '1.2.3\nbad', '1.2.3\n', '1.2.9007199254740992']) {
    assert.throws(() => parseVersion(value));
  }
  assert.throws(() => releasePlan('1.2.9007199254740991', [], []), /Next patch/);
});

test('release lookup distinguishes missing releases from authentication and service errors', async () => {
  const missing = await releaseState('Azayzel/CompareLab', 'v0.2.1', 'test-token', async (url, options) => {
    assert.match(url, /\/releases\/tags\/v0\.2\.1$/);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return { status: 404 };
  });
  assert.deepEqual(missing, { releaseExists: false, released: false, assetExists: false });
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(releaseState('Azayzel/CompareLab', 'v0.2.1', 'test-token', async () => ({ status, ok: false })), new RegExp('HTTP ' + status));
  }
});

test('release lookup supports draft recovery and skips only complete published releases', async () => {
  const lookup = release => releaseState('Azayzel/CompareLab', 'v0.2.1', 'test-token',
    async () => ({ status: 200, ok: true, json: async () => release }));
  for (const draft of [true, false]) {
    assert.deepEqual(await lookup({ tag_name: 'v0.2.1', draft, assets: [{ name: 'comparelab.vsix', state: 'uploaded' }] }),
      { releaseExists: true, released: !draft, assetExists: true });
  }
  assert.deepEqual(await lookup({ tag_name: 'v0.2.1', draft: true, assets: [] }),
    { releaseExists: true, released: false, assetExists: false });
  await assert.rejects(lookup({ tag_name: 'v0.2.1', draft: false, assets: [] }), /missing its VSIX/);
  await assert.rejects(lookup({ tag_name: 'wrong', draft: true, assets: [] }), /invalid release record/);
  await assert.rejects(releaseState('../other/repo', 'v0.2.1', 'token'), /required/);
});
