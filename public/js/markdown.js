// Small, dependency-free Markdown renderer for chat answers.
// Everything is HTML-escaped first, so model output can never inject markup.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

const BLOCK = '\u0000';
const INLINE = '\u0001';

const RE = {
  blank: /^\s*$/,
  placeholder: new RegExp(`^\\s*${BLOCK}(\\d+)${BLOCK}\\s*$`),
  heading: /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/,
  quote: /^\s{0,3}>/,
  list: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
};

export function renderMarkdown(source, options = {}) {
  if (!source) return '';
  const text = String(source).replace(/\r\n?/g, '\n').replace(/[\u0000\u0001]/g, '');
  const ctx = { blocks: [], sources: options.sources || [] };
  const lines = extractFences(text, ctx.blocks);
  return parseBlocks(lines, ctx);
}

// --- fenced code -------------------------------------------------------------

function extractFences(text, blocks) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s{0,12})(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/);
    if (!match) {
      out.push(lines[i]);
      continue;
    }
    const [, indent, fence, lang] = match;
    const close = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    const body = [];
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) {
      body.push(dedent(lines[j], indent.length));
      j++;
    }
    blocks.push(codeBlock(body.join('\n'), lang));
    out.push(`${indent}${BLOCK}${blocks.length - 1}${BLOCK}`);
    i = j;
  }
  return out;
}

function codeBlock(code, lang) {
  const label = escapeHtml((lang || 'text').toLowerCase().slice(0, 24));
  return (
    `<div class="code-block"><div class="code-head"><span>${label}</span>` +
    `<button type="button" class="code-copy" data-copy-code>Copy</button></div>` +
    `<pre><code>${escapeHtml(code)}</code></pre></div>`
  );
}

// --- blocks ------------------------------------------------------------------

function indentOf(line) {
  return line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
}

function dedent(line, count) {
  const expanded = line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length));
  let k = 0;
  while (k < count && expanded[k] === ' ') k++;
  return expanded.slice(k);
}

function isTableStart(lines, i) {
  return (
    i + 1 < lines.length &&
    lines[i].includes('|') &&
    lines[i + 1].includes('|') &&
    lines[i + 1].includes('-') &&
    RE.tableSep.test(lines[i + 1])
  );
}

function isBlockStart(lines, i) {
  const line = lines[i];
  return (
    RE.placeholder.test(line) ||
    RE.heading.test(line) ||
    RE.hr.test(line) ||
    RE.quote.test(line) ||
    RE.list.test(line) ||
    isTableStart(lines, i)
  );
}

function parseBlocks(lines, ctx) {
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;

    if (RE.blank.test(line)) {
      i++;
      continue;
    }
    if ((m = line.match(RE.placeholder))) {
      html += ctx.blocks[Number(m[1])] || '';
      i++;
      continue;
    }
    if ((m = line.match(RE.heading))) {
      const level = m[1].length;
      html += `<h${level}>${inline(m[2], ctx)}</h${level}>`;
      i++;
      continue;
    }
    if (RE.hr.test(line)) {
      html += '<hr>';
      i++;
      continue;
    }
    if (RE.quote.test(line)) {
      const buffer = [];
      while (i < lines.length && RE.quote.test(lines[i])) buffer.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      html += `<blockquote>${parseBlocks(buffer, ctx)}</blockquote>`;
      continue;
    }
    if (isTableStart(lines, i)) {
      const table = parseTable(lines, i, ctx);
      html += table.html;
      i = table.next;
      continue;
    }
    if (RE.list.test(line)) {
      const list = parseList(lines, i, ctx);
      html += list.html;
      i = list.next;
      continue;
    }

    const paragraph = [line.trim()];
    i++;
    while (i < lines.length && !RE.blank.test(lines[i]) && !isBlockStart(lines, i)) paragraph.push(lines[i++].trim());
    html += `<p>${paragraph.map((l) => inline(l, ctx)).join('<br>')}</p>`;
  }
  return html;
}

function parseList(lines, start, ctx) {
  const first = lines[start].match(RE.list);
  const base = indentOf(lines[start]);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;

  const sameLevel = (line) => {
    const m = line.match(RE.list);
    return m && Math.abs(indentOf(line) - base) <= 1 && /\d/.test(m[2]) === ordered ? m : null;
  };

  while (i < lines.length) {
    const line = lines[i];
    const m = sameLevel(line);
    if (m) {
      items.push({ lines: [m[3]], contentIndent: indentOf(line) + m[2].length + 1 });
      i++;
      continue;
    }
    if (RE.list.test(line) && Math.abs(indentOf(line) - base) <= 1) break; // other list type
    if (RE.blank.test(line)) {
      let j = i + 1;
      while (j < lines.length && RE.blank.test(lines[j])) j++;
      if (j < lines.length && (indentOf(lines[j]) > base + 1 || sameLevel(lines[j]))) {
        items[items.length - 1].lines.push('');
        i = j;
        continue;
      }
      break;
    }
    const item = items[items.length - 1];
    const indent = indentOf(line);
    if (indent > base + 1) {
      item.lines.push(dedent(line, Math.min(indent, item.contentIndent)));
      i++;
      continue;
    }
    if (indent < base) break;
    if (!isBlockStart(lines, i)) {
      item.lines.push(line.trim()); // lazy continuation
      i++;
      continue;
    }
    break;
  }

  const tag = ordered ? 'ol' : 'ul';
  const startNumber = ordered ? parseInt(first[2], 10) : 1;
  let html = `<${tag}${ordered && startNumber !== 1 ? ` start="${startNumber}"` : ''}>`;
  for (const item of items) {
    let content = item.lines;
    let checkbox = '';
    const task = content[0].match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      checkbox = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> `;
      content = [task[2], ...content.slice(1)];
    }
    let k = 1;
    while (k < content.length && !RE.blank.test(content[k]) && !isBlockStart(content, k)) k++;
    const head = content.slice(0, k).map((l) => inline(l.trim(), ctx)).join('<br>');
    const rest = content.slice(k);
    const nested = rest.some((l) => !RE.blank.test(l)) ? parseBlocks(rest, ctx) : '';
    html += `<li${checkbox ? ' class="task"' : ''}>${checkbox}${head}${nested}</li>`;
  }
  return { html: `${html}</${tag}>`, next: i };
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let current = '';
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\' && s[k + 1] === '|') {
      current += '|';
      k++;
      continue;
    }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  cells.push(current.trim());
  return cells;
}

function parseTable(lines, start, ctx) {
  const head = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((c) => {
    if (c.startsWith(':') && c.endsWith(':')) return 'a-center';
    if (c.endsWith(':')) return 'a-right';
    return '';
  });
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].includes('|') && !RE.blank.test(lines[i])) rows.push(splitRow(lines[i++]));

  const cell = (tag, value, index) => `<${tag}${aligns[index] ? ` class="${aligns[index]}"` : ''}>${inline(value, ctx)}</${tag}>`;
  let html = '<div class="table-wrap"><table><thead><tr>';
  html += head.map((c, k) => cell('th', c, k)).join('');
  html += '</tr></thead><tbody>';
  for (const row of rows) html += `<tr>${head.map((_, k) => cell('td', row[k] ?? '', k)).join('')}</tr>`;
  html += '</tbody></table></div>';
  return { html, next: i };
}

// --- inline ------------------------------------------------------------------

function link(url, labelHtml, className = '', title = '') {
  return (
    `<a href="${escapeHtml(url)}"${className ? ` class="${className}"` : ''}` +
    `${title ? ` title="${escapeHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${labelHtml}</a>`
  );
}

function emphasis(s) {
  return s
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
}

function inline(text, ctx) {
  const tokens = [];
  const hold = (html) => `${INLINE}${tokens.push(html) - 1}${INLINE}`;
  let s = text;

  s = s.replace(/``([^\n]+?)``|`([^`\n]+)`/g, (_, a, b) => hold(`<code>${escapeHtml(a ?? b)}</code>`));
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) =>
    hold(link(url, `🖼 ${escapeHtml(alt || 'image')}`)),
  );
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)(?:\s+"[^"]*")?\)/g, (_, label, url) =>
    hold(link(url, emphasis(escapeHtml(label)))),
  );
  if (ctx.sources.length) {
    s = s.replace(/\[(\d{1,3})\](?!\()/g, (whole, n) => {
      const source = ctx.sources[Number(n) - 1];
      return source ? hold(link(source.url, n, 'cite', source.title || source.url)) : whole;
    });
  }
  s = s.replace(/\bhttps?:\/\/[^\s<>"'`\u0001]+[^\s<>"'`\u0001.,;:!?)\]}*_]/g, (url) => hold(link(url, escapeHtml(url))));

  s = emphasis(escapeHtml(s)).replace(/&lt;br\s*\/?&gt;/gi, '<br>');

  for (let pass = 0; pass < 4 && s.includes(INLINE); pass++) {
    s = s.replace(/\u0001(\d+)\u0001/g, (_, n) => tokens[Number(n)] ?? '');
  }
  return s;
}
