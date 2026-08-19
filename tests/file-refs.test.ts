/**
 * Unit tests for the code-jump feature (TODO 5):
 *   - extractFileRefs / splitFileRefs (src/shared/file-refs.ts): conservative
 *     `path:line` scanning of assistant text.
 *   - resolveCandidates / resolveExistingFile (src/extension/open-file.ts):
 *     session-cwd-first / workspace-root-fallback resolution.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractFileRefs, splitFileRefs, parseFileHref } from '../src/shared/file-refs'
import { resolveCandidates, resolveExistingFile } from '../src/extension/open-file-resolve'

// ---------------------------------------------------------------------------
// extractFileRefs: what matches
// ---------------------------------------------------------------------------

test('extractFileRefs finds relative, absolute and tildes paths', () => {
  assert.deepEqual(
    extractFileRefs('改 src/foo.ts:42 就好').map((r) => ({ path: r.path, line: r.line })),
    [{ path: 'src/foo.ts', line: 42 }],
  )
  assert.deepEqual(
    extractFileRefs('看 /home/x/y.py:10').map((r) => ({ path: r.path, line: r.line })),
    [{ path: '/home/x/y.py', line: 10 }],
  )
  assert.deepEqual(
    extractFileRefs('用 ~/dotfiles/.zshrc:3').map((r) => ({ path: r.path, line: r.line })),
    [{ path: '~/dotfiles/.zshrc', line: 3 }],
  )
})

test('extractFileRefs supports line:col and line ranges', () => {
  assert.deepEqual(extractFileRefs('a.ts:10:5'), [
    { path: 'a.ts', line: 10, col: 5, start: 0, end: 9 },
  ])
  assert.deepEqual(extractFileRefs('a.ts:10-20'), [
    { path: 'a.ts', line: 10, endLine: 20, start: 0, end: 10 },
  ])
})

test('extractFileRefs handles Windows drive paths', () => {
  assert.deepEqual(
    extractFileRefs('编辑 C:\\proj\\app.ts:7').map((r) => r.path),
    ['C:\\proj\\app.ts'],
  )
})

test('extractFileRefs rejects URLs, times and bare fragments', () => {
  assert.deepEqual(extractFileRefs('见 https://example.com:8080/path 的 12:30 和 word:123'), [])
  assert.deepEqual(extractFileRefs('a:1 也是普通文本'), [])
  assert.deepEqual(extractFileRefs('没有引用'), [])
})

test('extractFileRefs survives surrounding punctuation and finds multiple refs', () => {
  const text = '先看 src/a.ts:3，再改 lib/b.js:100-120 或 src/a.ts:3:5。'
  const refs = extractFileRefs(text)
  assert.deepEqual(
    refs.map((r) => ({ path: r.path, line: r.line, endLine: r.endLine, col: r.col })),
    [
      { path: 'src/a.ts', line: 3, endLine: undefined, col: undefined },
      { path: 'lib/b.js', line: 100, endLine: 120, col: undefined },
      { path: 'src/a.ts', line: 3, endLine: undefined, col: 5 },
    ],
  )
})

test('extractFileRefs rejects inverted ranges and extension-less fragments', () => {
  assert.deepEqual(extractFileRefs('x.ts:20-10 是倒序'), [])
  // `abc123:45` has no separator/extension — not a file path.
  assert.deepEqual(extractFileRefs('abc123:45'), [])
})

test('splitFileRefs interleaves plain segments and refs in order', () => {
  const parts = splitFileRefs('先看 src/a.ts:3 再改')
  assert.equal(parts.length, 3)
  assert.equal(parts[0], '先看 ')
  assert.equal(typeof parts[1], 'object')
  assert.equal(parts[2], ' 再改')
  if (typeof parts[1] !== 'string') {
    const ref = parts[1]
    assert.ok(ref !== undefined)
    assert.equal(ref.path, 'src/a.ts')
    assert.equal(ref.line, 3)
  }
  // No refs: the text passes through whole.
  assert.deepEqual(splitFileRefs('平平无奇'), ['平平无奇'])
})

// ---------------------------------------------------------------------------
// Path resolution: session cwd first, workspace root second
// ---------------------------------------------------------------------------

test('resolveCandidates prefers the session cwd over the workspace root', () => {
  const candidates = resolveCandidates({ path: 'src/foo.ts', line: 1 }, '/ws/root')
  assert.deepEqual(candidates, ['/ws/root/src/foo.ts'])
  const withCwd = resolveCandidates({ path: 'src/foo.ts', line: 1, cwd: '/sess/cwd' }, '/ws/root')
  assert.deepEqual(withCwd, ['/sess/cwd/src/foo.ts', '/ws/root/src/foo.ts'])
})

test('resolveCandidates handles absolute paths and home expansion', () => {
  const absolute = resolveCandidates({ path: '/abs/x.ts', line: 1 }, '/ws/root')
  assert.deepEqual(absolute, ['/abs/x.ts'])
  const home = resolveCandidates({ path: '~/x.ts', line: 1 }, '/ws/root')
  assert.equal(home.length, 1)
  const homePath = home[0]
  assert.ok(homePath !== undefined && homePath.endsWith('/x.ts'))
  assert.ok(!homePath.includes('~'))
})

test('resolveExistingFile finds the file in cwd first, then the workspace root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-open-file-'))
  const root = join(dir, 'ws-root')
  const cwd = join(dir, 'sess-cwd')
  mkdirSync(root, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(root, 'only-root.ts'), '')
  writeFileSync(join(cwd, 'only-cwd.ts'), '')
  writeFileSync(join(cwd, 'both.ts'), '')
  writeFileSync(join(root, 'both.ts'), '')

  // cwd wins when both contain the file.
  assert.equal(resolveExistingFile({ path: 'both.ts', line: 1, cwd }, root), join(cwd, 'both.ts'))
  // root fallback when only the root has it.
  assert.equal(resolveExistingFile({ path: 'only-root.ts', line: 1, cwd }, root), join(root, 'only-root.ts'))
  // cwd-only file resolves via cwd.
  assert.equal(resolveExistingFile({ path: 'only-cwd.ts', line: 1, cwd }, root), join(cwd, 'only-cwd.ts'))
  // absolute path passes through.
  assert.equal(resolveExistingFile({ path: join(root, 'both.ts'), line: 1 }, root), join(root, 'both.ts'))
  // missing file resolves to null.
  assert.equal(resolveExistingFile({ path: 'nope.ts', line: 1, cwd }, root), null)
})

test('resolveExistingFile rejects directories (the real vscode openTextDocument rejects them)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-open-file-'))
  const root = join(dir, 'ws-root')
  mkdirSync(join(root, 'src'), { recursive: true })
  // `src` exists but is a directory: existsSync would accept it, only a real
  // file counts (directories fail later inside vscode with a cryptic error).
  assert.equal(resolveExistingFile({ path: 'src', line: 1 }, root), null)
})

// ---------------------------------------------------------------------------
// parseFileHref: markdown link hrefs as jump targets
// ---------------------------------------------------------------------------

test('parseFileHref accepts paths without a line suffix (line stays absent)', () => {
  const absolute = parseFileHref('/home/maru/project/vllm-ascend/vllm_ascend/platform.py')
  assert.deepEqual(absolute, {
    path: '/home/maru/project/vllm-ascend/vllm_ascend/platform.py',
    start: 0,
    end: '/home/maru/project/vllm-ascend/vllm_ascend/platform.py'.length,
  })
  assert.equal(parseFileHref('src/foo.ts')?.path, 'src/foo.ts')
  assert.equal(parseFileHref('~/dotfiles/.zshrc')?.path, '~/dotfiles/.zshrc')
  assert.equal(parseFileHref('C:\\proj\\app.ts')?.path, 'C:\\proj\\app.ts')
})

test('parseFileHref parses colon line, range and column suffixes', () => {
  const line = parseFileHref('/abs/platform.py:32')
  assert.equal(line?.line, 32)
  assert.equal(line?.endLine, undefined)
  const range = parseFileHref('/abs/platform.py:26-29')
  assert.deepEqual(range && { path: range.path, line: range.line, endLine: range.endLine }, {
    path: '/abs/platform.py',
    line: 26,
    endLine: 29,
  })
  const col = parseFileHref('src/a.ts:10:5')
  assert.deepEqual(col && { path: col.path, line: col.line, col: col.col }, {
    path: 'src/a.ts',
    line: 10,
    col: 5,
  })
  assert.equal(parseFileHref('C:\\proj\\app.ts:7')?.line, 7)
})

test('parseFileHref parses GitHub #L and #L-L fragments', () => {
  const single = parseFileHref('/abs/path/platform.py#L32')
  assert.deepEqual(single && { path: single.path, line: single.line, endLine: single.endLine }, {
    path: '/abs/path/platform.py',
    line: 32,
    endLine: undefined,
  })
  const range = parseFileHref('/abs/path/platform.py#L18-L40')
  assert.deepEqual(range && { path: range.path, line: range.line, endLine: range.endLine }, {
    path: '/abs/path/platform.py',
    line: 18,
    endLine: 40,
  })
  // Inverted ranges and zero lines are not jump targets.
  assert.equal(parseFileHref('/abs/platform.py#L40-L18'), null)
  assert.equal(parseFileHref('/abs/platform.py#L0'), null)
})

test('parseFileHref rejects scheme URLs, protocol-relative URLs and anchors', () => {
  assert.equal(parseFileHref('https://example.com/x.py'), null)
  assert.equal(parseFileHref('http://example.com/x.py#L3'), null)
  assert.equal(parseFileHref('mailto:a@b.c'), null)
  assert.equal(parseFileHref('//host/x.py'), null)
  // Pure in-page anchors and non-line fragments are not file targets.
  assert.equal(parseFileHref('#L3'), null)
  assert.equal(parseFileHref('#section'), null)
  assert.equal(parseFileHref('/abs/a.py#section'), null)
  // Bare words without separator/extension are not paths.
  assert.equal(parseFileHref('README'), null)
  // Colon digits mid-href (not a clean suffix) stay ambiguous: rejected.
  assert.equal(parseFileHref('/abs/a.ts:10/extra'), null)
  // A colon line suffix AND a line fragment together are ambiguous: rejected.
  assert.equal(parseFileHref('/abs/a.ts:10#L20'), null)
})
