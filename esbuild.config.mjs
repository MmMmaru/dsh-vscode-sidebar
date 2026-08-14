// esbuild build script for the extension host bundle, tests, and the smoke script.
// Usage:
//   node esbuild.config.mjs           -> bundle src/extension/extension.ts to dist/extension.js
//   node esbuild.config.mjs --watch   -> same, watch mode
//   node esbuild.config.mjs --tests   -> bundle tests/*.test.ts to .temp/test-dist/*.mjs
//   node esbuild.config.mjs --smoke   -> bundle .temp/smoke.ts to .temp/smoke-dist/smoke.mjs
import { build, context } from 'esbuild'
import { readdir } from 'node:fs/promises'

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

const args = process.argv.slice(2)
if (args.includes('--tests')) await buildTests()
else if (args.includes('--smoke')) await buildSmoke()
else await buildExtension(args.includes('--watch'))
