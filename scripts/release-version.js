'use strict';

const fs = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');

function parseVersion(version) {
  if (typeof version !== 'string' || version.trim() !== version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Release versions must be stable major.minor.patch numbers: ' + version);
  }
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Release version exceeds the safe integer range.');
  return parts;
}

function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function releasePlan(manifestVersion, tags, commitTags) {
  parseVersion(manifestVersion);
  const stable = tags.filter(tag => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag));
  stable.forEach(tag => parseVersion(tag.slice(1)));
  const existing = stable.filter(tag => commitTags.includes(tag));
  if (existing.length > 1) throw new Error('Multiple release tags point to this commit; resolve the ambiguity before publishing.');
  const latestTag = [...stable].sort((a, b) => compareVersions(b.slice(1), a.slice(1)))[0];
  if (existing.length) return { version: existing[0].slice(1), tag: existing[0], tagExists: true, latestTag };
  const base = latestTag && compareVersions(latestTag.slice(1), manifestVersion) > 0 ? latestTag.slice(1) : manifestVersion;
  const parts = parseVersion(base);
  parts[2]++;
  if (!Number.isSafeInteger(parts[2])) throw new Error('Next patch version exceeds the safe integer range.');
  const version = parts.join('.');
  return { version, tag: 'v' + version, tagExists: false, latestTag };
}

async function releaseState(repository, tag, token, fetchImpl = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required.');
  const response = await fetchImpl('https://api.github.com/repos/' + repository + '/releases/tags/' + encodeURIComponent(tag), {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30000)
  });
  if (response.status === 404) return { releaseExists: false, released: false, assetExists: false };
  if (!response.ok) throw new Error('GitHub release lookup failed with HTTP ' + response.status + '.');
  const release = await response.json();
  if (release.tag_name !== tag || typeof release.draft !== 'boolean' || !Array.isArray(release.assets)) {
    throw new Error('GitHub returned an invalid release record.');
  }
  const assetExists = release.assets.some(asset => asset.name === 'comparelab.vsix' && asset.state === 'uploaded');
  if (!release.draft && !assetExists) throw new Error('Published release is missing its VSIX; repair it before rerunning.');
  return { releaseExists: true, released: !release.draft, assetExists };
}

async function main() {
  const { GITHUB_SHA: sha, GITHUB_REPOSITORY: repository, GH_TOKEN: token, GITHUB_OUTPUT: output } = process.env;
  if (!/^[a-f0-9]{40}$/.test(sha || '') || !output) throw new Error('A full GITHUB_SHA and GITHUB_OUTPUT path are required.');
  const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const lines = value => value ? value.split('\n') : [];
  if (git(['rev-parse', 'HEAD']) !== sha) throw new Error('Checkout does not match the triggering commit.');
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const plan = releasePlan(manifest.version, lines(git(['tag', '--list'])), lines(git(['tag', '--points-at', sha])));
  const state = await releaseState(repository, plan.tag, token);
  if (!state.released && plan.latestTag) {
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', plan.latestTag, sha], { stdio: 'inherit' });
    if (ancestry.error) throw ancestry.error;
    if (ancestry.status === 1) throw new Error('This commit predates or diverges from ' + plan.latestTag + '; refusing to publish older source over a newer release.');
    if (ancestry.status !== 0) throw new Error('Could not verify release commit ancestry.');
  }
  const values = { version: plan.version, tag: plan.tag, tag_exists: plan.tagExists,
    release_exists: state.releaseExists, released: state.released, asset_exists: state.assetExists };
  fs.appendFileSync(output, Object.entries(values).map(([key, value]) => key + '=' + value + '\n').join(''));
  console.log(state.released ? plan.tag + ' is already released; nothing to publish.' : 'Preparing ' + plan.tag + ' for ' + sha + '.');
}

if (require.main === module) main().catch(error => {
  console.error('Release preparation failed: ' + error.message);
  process.exitCode = 1;
});

module.exports = { parseVersion, compareVersions, releasePlan, releaseState };
