'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');

function javascriptFiles(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(relative);
    return entry.isFile() && /\.[cm]?js$/.test(entry.name) ? [relative] : [];
  });
}

const icons = manifest.contributes.viewsContainers.activitybar.map(container => container.icon);
for (const file of [manifest.main, manifest.icon, ...icons, 'README.md', 'LICENSE', 'media/app.js', 'media/markdown.js', 'media/style.css', 'media/runners.css']) {
  if (!fs.statSync(path.join(root, file)).isFile()) throw new Error('Required extension file is missing: ' + file);
}

const files = ['src', 'media', 'bin', 'scripts', 'test'].flatMap(javascriptFiles).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error('Syntax check interrupted for ' + file + ': ' + result.signal);
  if (result.status !== 0) process.exit(result.status);
}

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
console.log('Checked ' + files.length + ' JavaScript files and required extension assets.');
console.log('Source is ready; no transpilation or bundling is needed. Running the test suite next.');
