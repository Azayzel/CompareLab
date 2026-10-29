(() => {
  'use strict';
  const PREVIEW_LIMIT = 100000;
  const inlinePattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^[\]\n]+\]\([^\s()[\]]+\)|\*[^*\n]+\*)/g;

  function inline(document, parent, text) {
    let position = 0;
    for (const match of text.matchAll(inlinePattern)) {
      parent.appendChild(document.createTextNode(text.slice(position, match.index)));
      const value = match[0];
      let element;
      if (value.startsWith('`')) {
        element = document.createElement('code');
        element.textContent = value.slice(1, -1);
      } else if (value.startsWith('[')) {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value);
        let safeUrl;
        try {
          const url = new URL(link[2]);
          if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) safeUrl = url.href;
        } catch { /* Non-URL Markdown stays plain text. */ }
        element = document.createElement(safeUrl ? 'a' : 'span');
        element.textContent = safeUrl ? link[1] : value;
        if (safeUrl) {
          element.href = safeUrl;
          element.target = '_blank';
          element.rel = 'noopener noreferrer';
        }
      } else {
        const strong = value.startsWith('**') || value.startsWith('__');
        element = document.createElement(strong ? 'strong' : 'em');
        element.textContent = value.slice(strong ? 2 : 1, strong ? -2 : -1);
      }
      parent.appendChild(element);
      position = match.index + value.length;
    }
    parent.appendChild(document.createTextNode(text.slice(position)));
  }

  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(value => value.trim());
  const separator = line => line?.includes('|') && cells(line).every(value => /^:?-{3,}:?$/.test(value));
  const startsBlock = line => /^\s*(?:#{1,6}\s|```|~~~|>|[-+*]\s|\d+[.)]\s)/.test(line);

  function render(document, container, value) {
    container.replaceChildren();
    const text = String(value ?? '');
    const lines = text.slice(0, PREVIEW_LIMIT).replace(/\r\n?/g, '\n').split('\n');
    const append = (tag, content, className) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      inline(document, element, content);
      container.appendChild(element);
      return element;
    };
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        const codeLines = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s*' + fence[1][0] + '{' + fence[1].length + ',}\\s*$').test(lines[i])) codeLines.push(lines[i++]);
        if (i < lines.length) i++;
        const block = document.createElement('pre');
        block.tabIndex = 0;
        const code = document.createElement('code');
        code.textContent = codeLines.join('\n');
        block.appendChild(code);
        container.appendChild(block);
        continue;
      }
      const heading = /^\s*(#{1,6})\s+(.+)$/.exec(line);
      if (heading) { append('h' + Math.min(6, heading[1].length + 2), heading[2].replace(/\s+#+\s*$/, '')); i++; continue; }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { container.appendChild(document.createElement('hr')); i++; continue; }
      if (line.includes('|') && separator(lines[i + 1])) {
        const wrapper = document.createElement('div');
        wrapper.className = 'markdown-table';
        wrapper.tabIndex = 0;
        const table = document.createElement('table');
        const row = (values, header) => {
          const tr = document.createElement('tr');
          for (const value of values) {
            const cell = document.createElement(header ? 'th' : 'td');
            if (header) cell.scope = 'col';
            inline(document, cell, value);
            tr.appendChild(cell);
          }
          return tr;
        };
        const head = document.createElement('thead');
        head.appendChild(row(cells(line), true));
        table.appendChild(head);
        const body = document.createElement('tbody');
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) body.appendChild(row(cells(lines[i++]), false));
        table.appendChild(body);
        wrapper.appendChild(table);
        container.appendChild(wrapper);
        continue;
      }
      const list = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(line);
      if (list) {
        const ordered = Boolean(list[2]);
        const element = document.createElement(ordered ? 'ol' : 'ul');
        if (ordered) element.start = Number(list[2]);
        while (i < lines.length) {
          const item = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(lines[i]);
          if (!item || Boolean(item[2]) !== ordered) break;
          const li = document.createElement('li');
          inline(document, li, item[3]);
          element.appendChild(li);
          i++;
        }
        container.appendChild(element);
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
        append('blockquote', quoted.join(' '));
        continue;
      }
      const paragraph = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !separator(lines[i + 1]) &&
          !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) paragraph.push(lines[i++]);
      append('p', paragraph.join(' '));
    }
    if (text.length > PREVIEW_LIMIT) append('p', 'Formatted preview shortened for responsiveness. Expand Raw response for the complete text.', 'notice');
  }

  window.CompareLabMarkdown = { render };
})();
