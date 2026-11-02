'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { extractModule, validateVerification } = require('../src/comparison/verification');
const { prepareVerification, verifyPair, passingReport } = require('../src/providers/verification');

const image = 'sha256:' + 'a'.repeat(64);
const config = () => ({ kind: 'node-commonjs', name: 'checker.cjs',
  source: "require('node:test')('answer', () => require('node:assert/strict').equal(require(process.argv[2]), 42));",
  timeoutSeconds: 5 });
const pair = () => ({ verification: config(), baseline: { response: '```js\nmodule.exports = 42;\n```' },
  candidate: { response: '```js\nmodule.exports = 41;\n```' } });
const tap = '# Subtest: answer\nok 1 - answer\n1..1\n# tests 1\n# pass 1\n# fail 0\n';

test('checker configuration and extracted code are explicit and unambiguous', () => {
  assert.deepEqual(validateVerification(config()), config());
  assert.equal(extractModule(pair().baseline.response), 'module.exports = 42;\n');
  for (const response of ['module.exports = 42;', '```python\nprint(42)\n```',
    '```js\nmodule.exports=1;\n```\n```js\nmodule.exports=2;\n```']) {
    assert.throws(() => extractModule(response), /exactly one/);
  }
  assert.throws(() => validateVerification({ ...config(), timeoutSeconds: 0 }), /Invalid executable checker/);
  assert.throws(() => validateVerification({ ...config(), source: 'x'.repeat(65537) }), /Invalid executable checker/);
});

test('Docker must be ready with a local resolved image; no automatic download or host fallback', async () => {
  const calls = [];
  assert.equal(await prepareVerification(async args => {
    calls.push(args); return { code: 0, output: args[0] === 'context' ? 'unix:///local/docker.sock' : args[0] === 'info' ? 'linux\n' : image + '\n' };
  }), image);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(args => !args.includes('pull')));
  await assert.rejects(prepareVerification(async () => ({ code: 0, output: 'ssh://remote-host' })), /local Docker socket/);
  await assert.rejects(prepareVerification(async args => ({ code: args[0] === 'context' ? 0 : 1,
    output: args[0] === 'context' ? 'unix:///local/docker.sock' : 'daemon unavailable' })), /running Linux Docker/);
  await assert.rejects(prepareVerification(async args => ({ code: args[0] === 'image' ? 1 : 0,
    output: args[0] === 'context' ? 'unix:///local/docker.sock' : args[0] === 'info' ? 'linux' : 'no image' })), /local node:22-alpine/);
});

test('each output uses a separate restricted container and cleanup runs after success or failure', async () => {
  const calls = [], directories = [], stagingDirectories = [];
  const result = await verifyPair(pair(), image, { run: async args => {
    calls.push(args);
    if (args[0] === 'rm') return { code: 0, output: '' };
    for (const flag of ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--user=65534:65534', '--memory=256m', '--pids-limit=64']) assert.ok(args.includes(flag));
    assert.ok(args.includes(image));
    const mount = args[args.indexOf('--mount') + 1];
    const directory = mount.match(/src=([^,]+)/)[1];
    directories.push(directory);
    const stagingDirectory = path.dirname(directory);
    stagingDirectories.push(stagingDirectory);
    assert.equal(path.basename(directory), 'work');
    assert.equal((await fs.stat(stagingDirectory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o755);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['checker.cjs', 'harness.cjs', 'solution.cjs']);
    for (const file of ['checker.cjs', 'harness.cjs', 'solution.cjs']) {
      assert.equal((await fs.stat(directory + '/' + file)).mode & 0o777, 0o644);
    }
    return { code: 0, output: tap };
  } });
  assert.equal(result.baseline.status, 'passed');
  assert.equal(result.candidate.status, 'passed');
  assert.notEqual(directories[0], directories[1]);
  assert.equal(calls.filter(args => args[0] === 'rm').length, 2);
  for (const directory of directories) await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  for (const directory of stagingDirectories) await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  let removed = 0;
  const failed = await verifyPair(pair(), image, { run: async args => {
    if (args[0] === 'rm') { removed++; return { code: 0, output: '' }; }
    throw new Error('Docker command timed out.');
  } });
  assert.equal(failed.baseline.status, 'timeout');
  assert.equal(removed, 2);
});

test('exit zero alone, skipped tests, file-only passes and forged stdout are not passing checks', () => {
  assert.equal(passingReport(tap, 0).status, 'passed');
  assert.equal(passingReport(tap, 1).status, 'failed');
  assert.equal(passingReport('', 0).status, 'failed');
  assert.equal(passingReport(tap.replace('# pass 1', '# pass 0'), 0).status, 'failed');
  assert.equal(passingReport(tap.replace('answer', '/work/harness.cjs'), 0).status, 'failed');
  assert.equal(passingReport(tap.split('\n').map(line => '# ' + line).join('\n'), 0).status, 'failed');
});

test('cancellation stops verification without returning a successful pair and still cleans up', async () => {
  const controller = new AbortController();
  let removed = 0;
  await assert.rejects(verifyPair(pair(), image, { signal: controller.signal, run: async args => {
    if (args[0] === 'rm') { removed++; return { code: 0, output: '' }; }
    controller.abort();
    throw new Error('Executable checks cancelled.');
  } }), /cancelled/);
  assert.equal(removed, 1);
});

test('real Docker checks distinguish correct code, failures and premature process exits', {
  skip: process.env.COMPARELAB_DOCKER_TESTS !== '1', timeout: 60000
}, async () => {
  const resolved = await prepareVerification();
  const result = await verifyPair(pair(), resolved);
  assert.equal(result.baseline.status, 'passed', result.baseline.detail);
  assert.equal(result.candidate.status, 'failed', result.candidate.detail);
  const early = pair();
  early.baseline.response = '```js\nprocess.exit(0);\n```';
  early.candidate.response = early.baseline.response;
  const interrupted = await verifyPair(early, resolved);
  assert.equal(interrupted.baseline.status, 'failed', interrupted.baseline.detail);
  assert.equal(interrupted.candidate.status, 'failed');
});

test('real Docker checks deny network, host mounts and writes, and stop runaway code', {
  skip: process.env.COMPARELAB_DOCKER_TESTS !== '1', timeout: 60000
}, async () => {
  const input = pair();
  input.verification.source = `const {test}=require('node:test'); const assert=require('node:assert/strict');
    test('isolation', async () => assert.equal(await require(process.argv[2])(), true));`;
  input.baseline.response = '```js\n' + `module.exports = async () => {
    const fs = require('node:fs');
    if (fs.existsSync('/var/run/docker.sock') || fs.existsSync('/Users')) return false;
    try { fs.writeFileSync('/work/escape', 'x'); return false; } catch (error) {
      if (!['EROFS', 'EACCES'].includes(error.code)) throw error;
    }
    return new Promise(resolve => {
      const socket=require('node:net').createConnection({host:'1.1.1.1',port:443});
      socket.setTimeout(500);
      socket.once('connect',()=>{socket.destroy();resolve(false);});
      socket.once('error',()=>resolve(true));
      socket.once('timeout',()=>{socket.destroy();resolve(true);});
    });
  };` + '\n```';
  input.candidate.response = '```js\nwhile (true) {}\n```';
  const result = await verifyPair(input, await prepareVerification());
  assert.equal(result.baseline.status, 'passed', result.baseline.detail);
  assert.equal(result.candidate.status, 'timeout', result.candidate.detail);
});
