const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../media/markdown.js'), 'utf8');
const nodes = node => [node, ...node.children.flatMap(nodes)];
const text = node => (node.textContent || '') + node.children.map(text).join('');
function render(value) {
  const element = tagName => ({
    tagName, children: [],
    set innerHTML(value) { throw new Error('Model output must not be interpreted as HTML'); },
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); }
  });
  const container = element('div');
  const context = vm.createContext({ URL, window: {}, container, value,
    document: { createElement: element, createTextNode: value => ({ textContent: value, children: [] }) } });
  vm.runInContext(source + '\nwindow.CompareLabMarkdown.render(document, container, value);', context, { timeout: 1000 });
  return container;
}

test('formats report headings, lists, emphasis, links, tables, quotes, and fenced code', () => {
  const report = '# Investigation\n\n**Finding:** *inconclusive* for `service:api`.\n\n' +
    '- First check\n- Second check\n\n3. Verify\n4. Recheck\n\n' +
    '| Signal | Evidence |\n| --- | --- |\n| Errors | **Increased** |\n\n' +
    '> Limited evidence only.\n\n[View logs](https://app.datadoghq.com/logs?query=service%3Aapi)\n\n' +
    '```json\n{"literal":"<tag> **not bold**"}\n```\n\n---';
  const root = render(report);
  const all = nodes(root);
  assert.equal(text(all.find(node => node.tagName === 'h3')), 'Investigation');
  for (const tag of ['strong', 'em', 'code', 'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead', 'tbody']) {
    assert.ok(all.some(node => node.tagName === tag), tag);
  }
  assert.equal(all.find(node => node.tagName === 'ol').start, 3);
  assert.equal(all.filter(node => node.tagName === 'li').length, 4);
  assert.ok(all.filter(node => node.tagName === 'th').every(node => node.scope === 'col'));
  assert.equal(text(all.find(node => node.tagName === 'pre')), '{"literal":"<tag> **not bold**"}');
  const link = all.find(node => node.tagName === 'a');
  assert.equal(link.href, 'https://app.datadoghq.com/logs?query=service%3Aapi');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.target, '_blank');
});

test('leaves raw HTML and unsafe or relative links inert while allowing HTTP and HTTPS', () => {
  const html = '<script>alert(1)</script><img src=x onerror=alert(1)>';
  const urls = ['javascript:alert', 'command:workbench.action', 'data:text/html,test', 'file:///tmp/test',
    '//example.com', '/relative/path', 'https://user:secret@example.com', 'not-a-url'];
  const root = render(html + '\n\n' + urls.map(url => `[unsafe](${url})`).join(' ') +
    ' [safe](https://example.com) [http](http://example.com)');
  const all = nodes(root);
  assert.equal(all.filter(node => node.tagName === 'a').length, 2);
  assert.ok(!all.some(node => ['script', 'img', 'iframe'].includes(node.tagName)));
  assert.ok(text(root).includes(html));
  for (const url of urls) assert.ok(text(root).includes(`[unsafe](${url})`));
});

test('caps formatted previews explicitly and handles incomplete Markdown without dropping text', () => {
  const root = render('x'.repeat(100000) + 'OMITTED_PREVIEW_TAIL');
  assert.ok(text(root).startsWith('x'.repeat(100000)));
  assert.ok(!text(root).includes('OMITTED_PREVIEW_TAIL'));
  assert.match(text(root), /Expand Raw response for the complete text/);
  for (const value of ['unclosed **bold', '[incomplete](url', '```text\nunfinished code']) {
    assert.ok(text(render(value)).includes(value.startsWith('```') ? 'unfinished code' : value));
  }
});

test('handles long unmatched Markdown delimiters within the rendering deadline', () => {
  for (const value of ['['.repeat(100000), '[label](unfinished'.repeat(6000), '*'.repeat(100000)]) {
    assert.ok(render(value).children.length > 0);
  }
});
