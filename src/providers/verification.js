'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { digest, validateVerification, extractModule } = require('../comparison/verification');
const { responseContent } = require('../comparison/response');

const IMAGE = 'node:22-alpine';
const MAX_OUTPUT = 65536;

function command(args, { timeout = 15000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Executable checks cancelled.')); return; }
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let output = '', bytes = 0, failure;
    const stop = message => { failure ||= new Error(message); child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('Docker command timed out.'), timeout);
    const abort = () => stop('Executable checks cancelled.');
    signal?.addEventListener('abort', abort, { once: true });
    const collect = data => {
      bytes += data.length;
      if (bytes > MAX_OUTPUT) { stop('Executable check output exceeded 64 KiB.'); return; }
      output += data.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => { failure ||= new Error('Could not start Docker: ' + error.message); });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ code, output });
    });
  });
}

async function prepareVerification(run = command) {
  const context = await run(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  const endpoint = process.env.DOCKER_CONTEXT ? context.output.trim() : process.env.DOCKER_HOST || context.output.trim();
  if (context.code !== 0 || !/^(?:unix:\/\/|npipe:\/\/)/.test(endpoint)) {
    throw new Error('Executable checks require a local Docker socket; remote Docker engines are not supported.');
  }
  const info = await run(['info', '--format', '{{.OSType}}']);
  if (info.code !== 0 || info.output.trim() !== 'linux') {
    throw new Error('Executable checks need a running Linux Docker engine. Start Docker Desktop; no generated code ran.');
  }
  const image = await run(['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
  if (image.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(image.output.trim())) {
    throw new Error('Executable checks need a local ' + IMAGE + ' image. Run docker pull ' + IMAGE +
      ' yourself after reviewing the image. CompareLab never downloads images automatically.');
  }
  return image.output.trim();
}

function passingReport(output, code) {
  const number = label => Number([...output.matchAll(new RegExp('^# ' + label + ' (\\d+)\\r?$', 'gm'))].at(-1)?.[1]);
  const tests = number('tests'), passed = number('pass'), failed = number('fail');
  const valid = [tests, passed, failed].every(Number.isSafeInteger) && tests > 0 &&
    !/^# Subtest: \/work\/harness\.cjs\r?$/m.test(output);
  return { status: code === 0 && valid && passed === tests && failed === 0 ? 'passed' : 'failed',
    tests: valid ? tests : null, passed: valid ? passed : null, failed: valid ? failed : null };
}

async function verifyPair(input, image, { signal, run = command } = {}) {
  const config = validateVerification(input.verification);
  if (!config) throw new Error('Select an executable checker before running verification.');
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Executable checks require a resolved local image ID.');
  const result = { kind: config.kind, checker: config.name, checkerHash: digest(config.source),
    image, checkedAt: new Date().toISOString(), timeoutSeconds: config.timeoutSeconds };
  for (const side of ['baseline', 'candidate']) {
    signal?.throwIfAborted();
    const response = responseContent(input[side]?.response);
    const responseHash = digest(response);
    let source;
    try { source = extractModule(response); }
    catch (error) { result[side] = { status: 'failed', responseHash, detail: error.message }; continue; }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'comparelab-check-'));
    const workDirectory = path.join(directory, 'work');
    const name = 'comparelab-check-' + randomUUID();
    const started = Date.now();
    try {
      await fs.mkdir(workDirectory, { mode: 0o755 });
      await fs.chmod(workDirectory, 0o755);
      await fs.writeFile(path.join(workDirectory, 'solution.cjs'), source);
      await fs.writeFile(path.join(workDirectory, 'checker.cjs'), config.source);
      await fs.writeFile(path.join(workDirectory, 'harness.cjs'),
        "process.argv = [process.execPath, '/work/checker.cjs', '/work/solution.cjs'];\nrequire('/work/checker.cjs');\n");
      await Promise.all(['solution.cjs', 'checker.cjs', 'harness.cjs'].map(file =>
        fs.chmod(path.join(workDirectory, file), 0o644)));
      const observed = await run(['run', '--name', name, '--pull=never', '--network=none', '--read-only',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534', '--cpus=1',
        '--memory=256m', '--memory-swap=256m', '--pids-limit=64', '--ulimit', 'nofile=128:128',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--mount', 'type=bind,src=' + workDirectory + ',dst=/work,readonly',
        '--workdir=/work', image, 'node', '--test', '--test-reporter=tap', '/work/harness.cjs'],
      { timeout: config.timeoutSeconds * 1000, signal });
      result[side] = { ...passingReport(observed.output, observed.code), responseHash,
        exitCode: observed.code, elapsedMs: Date.now() - started, detail: observed.output };
    } catch (error) {
      if (signal?.aborted) throw error;
      result[side] = { status: /timed out/.test(error.message) ? 'timeout' : 'error', responseHash,
        elapsedMs: Date.now() - started, detail: error.message };
    } finally {
      try {
        const removed = await run(['rm', '--force', name]);
        if (removed.code !== 0 && !/No such container/i.test(removed.output)) {
          throw new Error('Could not remove checker container ' + name + ': ' + removed.output);
        }
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
  }
  return result;
}

module.exports = { prepareVerification, verifyPair, passingReport };
