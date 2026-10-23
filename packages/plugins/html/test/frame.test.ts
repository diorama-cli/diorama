import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSize, HTML_EXTENSIONS, lineCount } from '../src/frame.ts'
import {
  documentTitle,
  frameContentSecurityPolicy,
  frameSandbox,
  hasScript,
  previewDocument,
  previewStage,
  type PreviewStage,
} from '../src/policy.ts'

/**
 * The `html` renderer's pure half (contract.md §5.1). The sanitiser needs a
 * browser (DOMPurify): `apps/web/tests/m5-html.spec.ts` covers it.
 */

test('html: the renderer claims .html and .htm, nothing else', () => {
  assert.deepEqual([...HTML_EXTENSIONS], ['html', 'htm'])
})

test('html: the styles stage blocks scripts but allows styles and remote media', () => {
  const csp = frameContentSecurityPolicy('styles')
  assert.ok(csp.includes("default-src 'none'"))
  assert.ok(csp.includes("style-src 'unsafe-inline' https: http:"))
  assert.ok(csp.includes("img-src data: blob: https: http:"))
  // No script of any kind may run before confirmation.
  assert.ok(!csp.includes('script-src'))
  assert.ok(!csp.includes("'unsafe-eval'"))
  // And page script cannot reach this page: no same-origin-plus-scripts.
  assert.equal(frameSandbox('styles'), 'allow-same-origin')
})

test('html: the scripts stage allows page scripts, still not same-origin', () => {
  const csp = frameContentSecurityPolicy('scripts')
  assert.ok(csp.includes("script-src 'unsafe-inline' 'unsafe-eval' https: http:"))
  assert.ok(csp.includes("connect-src https: http:"))
  // The two sandbox flags that would cancel the sandbox never meet.
  assert.equal(frameSandbox('scripts'), 'allow-scripts')
  assert.ok(!frameSandbox('scripts').includes('allow-same-origin'))
})

test('html: the document carries the stage policy and the page title', () => {
  const styles = previewDocument('<p>hi</p>', 'styles', '<title>Role &amp; Ampersand</title>')
  assert.ok(styles.includes(`content="${frameContentSecurityPolicy('styles')}"`))
  assert.ok(styles.includes('<title>Role &amp; Ampersand</title>'))
  assert.ok(styles.includes('<p>hi</p>'))
  const scripts = previewDocument('<p>hi</p>', 'scripts')
  assert.ok(scripts.includes(frameContentSecurityPolicy('scripts')))
})

test('html: a page with a script or an inline handler is worth a prompt', () => {
  assert.equal(hasScript('<script>alert(1)</script>'), true)
  assert.equal(hasScript('<SCRIPT src="a.js"></SCRIPT>'), true)
  assert.equal(hasScript('<button onclick="go()">x</button>'), true)
  assert.equal(hasScript('<a href="javascript:go()">x</a>'), true)
  assert.equal(hasScript('<style>body{}</style><div style="color:red">x</div>'), false)
})

test('html: the title is read and escaped, or empty', () => {
  assert.equal(documentTitle('<head><title>  Roles  </title></head>'), 'Roles')
  assert.equal(documentTitle('<title>A &amp; B</title>'), 'A &amp; B')
  assert.equal(documentTitle('<title> <b>raw</b> </title>').includes('<'), false)
  assert.equal(documentTitle('<p>no title</p>'), '')
})

test('html: the header counts lines and sizes', () => {
  assert.equal(lineCount(''), 0)
  assert.equal(lineCount('a'), 1)
  assert.equal(lineCount('a\nb'), 2)
  // A trailing newline ends the last line; it does not open another.
  assert.equal(lineCount('a\nb\n'), 2)
  assert.equal(formatSize(12), '12 字节')
  assert.equal(formatSize(2048), '2.0 KiB')
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MiB')
})

test('html: [html] scripts = true only moves a page that has scripts', () => {
  // The default (untrusted) is the styles stage either way.
  assert.equal(previewStage(false, true), 'styles')
  assert.equal(previewStage(false, false), 'styles')
  // Confirmed (or configured) runs the scripts stage — but only for a page
  // that actually has one: there is nothing to run in a script-free page, and
  // the scripts stage skips the sanitiser.
  assert.equal(previewStage(true, true), 'scripts')
  assert.equal(previewStage(true, false), 'styles')
})

test('html: every stage names a sandbox and a policy', () => {
  for (const stage of ['styles', 'scripts'] satisfies PreviewStage[]) {
    assert.ok(frameSandbox(stage).length > 0)
    assert.ok(frameContentSecurityPolicy(stage).length > 0)
  }
})
