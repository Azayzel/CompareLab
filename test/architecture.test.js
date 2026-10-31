const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'src');
const entry = path.resolve(root, require('../package.json').main);

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const file = path.join(directory, item.name);
    return item.isDirectory() ? javascriptFiles(file) : item.isFile() && item.name.endsWith('.js') ? [file] : [];
  });
}

const files = javascriptFiles(source);
const imports = file => [...fs.readFileSync(file, 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);

test('source modules have resolvable, acyclic internal dependencies', () => {
  const graph = new Map(files.map(file => {
    const resolve = createRequire(file).resolve;
    const dependencies = imports(file).filter(name => name.startsWith('.')).map(name => resolve(name));
    for (const dependency of dependencies) assert.ok(files.includes(dependency), 'Import leaves src: ' + file + ' -> ' + dependency);
    return [file, dependencies];
  }));
  const visited = new Set();
  const active = [];
  function visit(file) {
    assert.ok(!active.includes(file), 'Circular dependency: ' + [...active, file].map(value => path.relative(root, value)).join(' -> '));
    if (visited.has(file)) return;
    active.push(file);
    for (const dependency of graph.get(file)) visit(dependency);
    active.pop();
    visited.add(file);
  }
  for (const file of files) visit(file);
});

test('only the extension entry binds VS Code; other modules load outside the editor', () => {
  assert.equal(entry, path.join(source, 'extension.js'));
  for (const file of files) {
    if (file === entry) continue;
    assert.ok(!imports(file).includes('vscode'), 'Inject the VS Code API instead of importing it in ' + file);
    assert.equal(typeof require(file), 'object', 'Expected named CommonJS exports in ' + file);
  }
});
