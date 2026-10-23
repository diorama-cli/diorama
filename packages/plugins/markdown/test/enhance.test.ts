import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapeHtml, isMermaidFence, mathPlaceholder, mermaidPlaceholder } from '../src/math.ts'
import { normalizeOutline, OUTLINE_MIN_HEADINGS, plainHeadingText } from '../src/outline.ts'

/**
 * Math, diagrams and the outline (contract.md §5.1, docs/m17/spec.md).
 *
 * The parse itself needs a DOM (DOMPurify) and lives in `.tsx`; what is worth
 * testing here is the pure part: how a formula and a diagram become a
 * placeholder, and how a heading list is flattened for the outline rail.
 *
 * **The source is text, never an attribute.** That is not a style choice:
 * DOMPurify removes an attribute whose value contains `-->` or `]>`, and every
 * Mermaid diagram has an arrow. The first implementation carried the source in
 * `data-source`, so every diagram rendered as an empty string.
 */

test('math: a formula becomes a placeholder whose text is its TeX', () => {
  const html = mathPlaceholder('x^2', false)
  assert.match(html, /class="diorama-math diorama-math--inline"/)
  assert.match(html, /data-math="inline"/)
  assert.match(html, />x\^2</)
  assert.ok(!html.includes('data-tex'), 'the source is not an attribute')
  assert.ok(!html.endsWith('\n'), 'an inline formula adds no line break')
})

test('math: a block formula is a div on its own line', () => {
  const html = mathPlaceholder('\\int_0^1 x\\,dx', true)
  assert.match(html, /^<div class="diorama-math diorama-math--block"/)
  assert.match(html, /data-math="block"/)
  assert.ok(html.endsWith('</div>\n'))
})

test('math: the TeX is escaped for the text it becomes', () => {
  const html = mathPlaceholder('a < b && c > "d"', false)
  assert.match(html, />a &lt; b &amp;&amp; c &gt; &quot;d&quot;/)
  assert.ok(!html.includes('<b'), 'no raw markup from the TeX')
})

test('escapeHtml: the five characters that change meaning', () => {
  assert.equal(escapeHtml('<&>"\''), '&lt;&amp;&gt;&quot;&#39;')
  assert.equal(escapeHtml('plain'), 'plain')
})

test('mermaid: only a `mermaid` fence is a diagram', () => {
  assert.equal(isMermaidFence('mermaid'), true)
  assert.equal(isMermaidFence('Mermaid'), true)
  assert.equal(isMermaidFence('  mermaid  '), true)
  assert.equal(isMermaidFence('mermaid title="Flow"'), true)
  assert.equal(isMermaidFence('js'), false)
  assert.equal(isMermaidFence('mermaidish'), false)
  assert.equal(isMermaidFence(undefined), false)
  assert.equal(isMermaidFence(''), false)
})

test('mermaid: the source survives as text, arrows and all', () => {
  const html = mermaidPlaceholder('graph TD\n  A --> B')
  assert.match(html, /class="diorama-mermaid" data-mermaid=""/)
  assert.match(html, /<pre class="diorama-mermaid__source"><code>graph TD\n {2}A --&gt; B<\/code><\/pre>/)
  assert.ok(!html.includes('data-source'))
})

test('outline: a heading\'s rendered HTML becomes plain text', () => {
  assert.equal(plainHeadingText('Hello <em>World</em>'), 'Hello World')
  assert.equal(plainHeadingText('a &amp; b'), 'a & b')
  assert.equal(plainHeadingText('  spaced   out  '), 'spaced out')
  assert.equal(plainHeadingText('<code>x</code> <strong>y</strong>'), 'x y')
})

test('outline: levels start at 1 and never skip more than one step', () => {
  const entries = [
    { depth: 2, id: 'a', text: 'A' },
    { depth: 4, id: 'b', text: 'B' },
    { depth: 3, id: 'c', text: 'C' },
    { depth: 2, id: 'd', text: 'D' },
  ]
  assert.deepEqual(normalizeOutline(entries).map(entry => entry.depth), [1, 2, 2, 1])
})

test('outline: a document starting at h3 is still rooted', () => {
  const entries = [
    { depth: 3, id: 'a', text: 'A' },
    { depth: 6, id: 'b', text: 'B' },
  ]
  assert.deepEqual(normalizeOutline(entries).map(entry => entry.depth), [1, 2])
})

test('outline: nothing in, nothing out', () => {
  assert.deepEqual(normalizeOutline([]), [])
})

test('outline: a rail needs more than a title', () => {
  // One heading is the title the reader can already see; two is where
  // "where am I" starts to have an answer (the renderer's own threshold).
  assert.equal(OUTLINE_MIN_HEADINGS, 2)
})
