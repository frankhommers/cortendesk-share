// Build the guest viewer into ../public/rdclient/ and, with --server, the
// sidecar server into ../dist/. Both run in the Docker build.
//
//   npm run build            one-shot production bundle
//   npm run build -- --watch rebuild on change (dev only)
//
// Two independent entry points:
//   src/ui/app.ts             -> ../public/rdclient/app.js       (main thread)
//   src/worker/session.worker -> ../public/rdclient/session.worker.js (worker)
//
// WASM (libsodium-wrappers ships base64-inlined already; zstddec ships a .wasm)
// is inlined as base64 data URIs via the `binary` loader so the output stays a
// self-contained static asset tree with no extra fetches.

import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(__dirname, '../public/rdclient');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  format: 'esm',
  target: ['chrome110', 'edge110'],
  platform: 'browser',
  sourcemap: true,
  minify: !dev,
  legalComments: 'linked',
  logLevel: 'info',
  loader: {
    '.wasm': 'binary',
    '.css': 'css',
  },
  alias: {
    // libsodium-wrappers' ESM build imports './libsodium.mjs' from the sibling
    // `libsodium` package — unresolvable. Bundle the CJS build instead (same
    // alias as vitest.config.ts).
    'libsodium-wrappers': require.resolve('libsodium-wrappers'),
    // jMuxer imports node's `stream` for its optional createStream() wrapper,
    // which this client never calls. Stub it rather than bundling a polyfill
    // for an unreachable path.
    stream: resolve(__dirname, 'src/shims/node-stream.ts'),
  },
  define: {
    'process.env.NODE_ENV': dev ? '"development"' : '"production"',
  },
};

const entryPoints = {
  app: resolve(__dirname, 'src/ui/app.ts'),
  'session.worker': resolve(__dirname, 'src/worker/session.worker.ts'),
};

// The sidecar server (src/sidecar/main.ts): one ESM file for Node.
if (process.argv.includes('--server')) {
  await build({
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node22'],
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    logLevel: 'info',
    entryPoints: [resolve(__dirname, 'src/sidecar/main.ts')],
    outfile: resolve(__dirname, '../dist/sidecar.mjs'),
    alias: { 'libsodium-wrappers': require.resolve('libsodium-wrappers') },
    // CJS dependencies call require(); give them one.
    banner: { js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);" },
    external: ['bufferutil', 'utf-8-validate'],
  });
  console.log('[esbuild] built server -> ../dist/sidecar.mjs');
  process.exit(0);
}

if (watch) {
  const ctx = await context({ ...shared, entryPoints, outdir });
  await ctx.watch();
  console.log(`[esbuild] watching -> ${outdir}`);
} else {
  await build({ ...shared, entryPoints, outdir });
  console.log(`[esbuild] built -> ${outdir}`);
}
