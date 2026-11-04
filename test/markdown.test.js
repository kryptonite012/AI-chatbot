import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/js/markdown.js';

test('escapes raw HTML from model output', () => {
  const html = renderMarkdown('Hi <script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('only links http(s) and mailto URLs', () => {
  const html = renderMarkdown('[ok](https://example.com) [bad](javascript:alert(1)) [data](data:text/html,x)');
  assert.ok(html.includes('href="https://example.com"'));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(!html.includes('href="data:'));
});

test('renders headings, emphasis and inline code', () => {
  const html = renderMarkdown('## Title\nSome **bold**, *italic*, ~~gone~~ and `x < y`');
  assert.ok(html.includes('<h2>Title</h2>'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>italic</em>'));
  assert.ok(html.includes('<del>gone</del>'));
  assert.ok(html.includes('<code>x &lt; y</code>'));
});

test('renders fenced code, including an unfinished fence while streaming', () => {
  const html = renderMarkdown('```js\nconst a = "<b>";\n```\n\n```py\nprint(1)');
  assert.equal((html.match(/class="code-block"/g) || []).length, 2);
  assert.ok(html.includes('<span>js</span>'));
  assert.ok(html.includes('const a = &quot;&lt;b&gt;&quot;;'));
  assert.ok(html.includes('print(1)'));
});

test('renders nested and ordered lists', () => {
  const html = renderMarkdown('3. Three\n   - a\n   - b\n4. Four\n\n- [x] done');
  assert.ok(html.startsWith('<ol start="3"><li>Three<ul><li>a</li><li>b</li></ul></li><li>Four</li></ol>'));
  assert.ok(html.includes('type="checkbox" disabled checked'));
});

test('renders tables with alignment', () => {
  const html = renderMarkdown('| Name | Score |\n|:---|---:|\n| A | 1 |\n| B \\| C | 2 |');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th class="a-right">Score</th>'));
  assert.ok(html.includes('<td>B | C</td>'));
});

test('turns [n] into source links when sources are present', () => {
  const html = renderMarkdown('Fact [1] and [2].', { sources: [{ url: 'https://a.com', title: 'A' }] });
  assert.ok(html.includes('class="cite"'));
  assert.ok(html.includes('href="https://a.com"'));
  assert.ok(html.includes('[2]'));
});

test('autolinks bare URLs without trailing punctuation', () => {
  const html = renderMarkdown('See https://example.com/path.');
  assert.ok(html.includes('href="https://example.com/path"'));
  assert.ok(html.endsWith('</a>.</p>'));
});
