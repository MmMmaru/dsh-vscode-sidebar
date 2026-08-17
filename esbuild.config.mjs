// esbuild build script for the extension host bundle, tests, and the smoke script.
// Usage:
//   node esbuild.config.mjs           -> bundle src/extension/extension.ts to dist/extension.js
//   node esbuild.config.mjs --watch   -> same, watch mode
//   node esbuild.config.mjs --tests   -> bundle tests/*.test.ts to .temp/test-dist/*.mjs
//   node esbuild.config.mjs --smoke   -> bundle .temp/smoke.ts to .temp/smoke-dist/smoke.mjs
//   node esbuild.config.mjs --e2e     -> bundle tests/e2e/harness.ts to .temp/e2e-dist/harness.mjs
import { build, context } from 'esbuild'
import { readdir, writeFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'

/** Shared options for every Node-targeted bundle in this project. */
const base = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
}

async function buildExtension(watch) {
  const opts = {
    ...base,
    format: 'cjs',
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.js',
  }
  if (!watch) return build(opts)
  const ctx = await context(opts)
  await ctx.watch()
}

async function buildTests() {
  const files = (await readdir('tests')).filter((f) => f.endsWith('.test.ts'))
  return build({
    ...base,
    // Keep React's Node server entry and the renderer native; bundling their
    // CJS util imports into the ESM test artifact breaks Node's require shim.
    external: [...base.external, 'react', 'react-dom/server', 'react-test-renderer'],
    entryPoints: files.map((f) => `tests/${f}`),
    outdir: '.temp/test-dist',
    outExtension: { '.js': '.mjs' },
  })
}

async function buildSmoke() {
  return build({
    ...base,
    entryPoints: ['.temp/smoke.ts'],
    outdir: '.temp/smoke-dist',
    outExtension: { '.js': '.mjs' },
  })
}

async function buildE2eHarness() {
  const outdir = '.temp/e2e-dist'
  await build({
    ...base,
    // The harness runs the REAL extension host code (bridge / dsh-client /
    // host-manager) with the `vscode` module aliased to the test stub.
    alias: { vscode: resolvePath('tests/e2e/vscode-stub.ts') },
    entryPoints: ['tests/e2e/harness.ts'],
    outdir,
    outExtension: { '.js': '.mjs' },
    external: [...base.external, 'ws'],
  })
  // Type declaration for the spec's import of the bundle (types re-exported
  // from the source so there is no drift between the two).
  await writeFile(
    resolvePath(outdir, 'harness.d.mts'),
    `import type { Harness } from '../../tests/e2e/harness'\nexport type { Harness, StubTextEditor } from '../../tests/e2e/harness'\nexport declare function startHarness(): Promise<Harness>\n`,
  )
}

const args = process.argv.slice(2)
if (args.includes('--tests')) await buildTests()
else if (args.includes('--smoke')) await buildSmoke()
else if (args.includes('--e2e')) await buildE2eHarness()
else await buildExtension(args.includes('--watch'))
