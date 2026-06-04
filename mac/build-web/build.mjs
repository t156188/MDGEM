import { build } from 'esbuild';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../Resources/vendor');

// Stamp the bundle with this package's version so the sidebar can show it
// without an IPC roundtrip. Kept in sync via the release-bump rule (see
// CLAUDE.md).
const pkg = JSON.parse(
  await readFile(resolve(__dirname, 'package.json'), 'utf-8')
);
const APP_VERSION = pkg.version || '0.0.0';

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// The viewer entry that pulls in markdown-it + plugins + highlight.js + KaTeX.
// Mermaid is loaded on-demand from a separate bundle.
await build({
  entryPoints: [resolve(__dirname, 'entries/viewer.entry.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'MDViewer',
  outfile: resolve(outDir, 'viewer.bundle.js'),
  target: ['safari16'],
  legalComments: 'none',
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
});

await build({
  entryPoints: [resolve(__dirname, 'entries/mermaid.entry.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'MDMermaid',
  outfile: resolve(outDir, 'mermaid.bundle.js'),
  target: ['safari16'],
  legalComments: 'none',
});

// Code editor (CodeMirror 6), loaded on demand the first time an editable
// file is opened in edit mode. Exposes window.MDEditor = { createEditor, … }.
await build({
  entryPoints: [resolve(__dirname, 'entries/editor.entry.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'MDEditor',
  outfile: resolve(outDir, 'editor.bundle.js'),
  target: ['safari16'],
  legalComments: 'none',
});

// Standalone settings page, loaded in its own window on each platform.
await build({
  entryPoints: [resolve(__dirname, 'entries/settings.entry.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  outfile: resolve(outDir, 'settings.bundle.js'),
  target: ['safari16'],
  legalComments: 'none',
});

// Copy the highlight.js + KaTeX CSS so we can ship them as static stylesheets.
const hlCssSrc = resolve(__dirname, 'node_modules/highlight.js/styles/github.css');
const hlCssDarkSrc = resolve(__dirname, 'node_modules/highlight.js/styles/github-dark.css');
const katexCssSrc = resolve(__dirname, 'node_modules/katex/dist/katex.min.css');
const katexFontsSrc = resolve(__dirname, 'node_modules/katex/dist/fonts');

await cp(hlCssSrc, resolve(outDir, 'hljs-light.css'));
await cp(hlCssDarkSrc, resolve(outDir, 'hljs-dark.css'));
await cp(katexCssSrc, resolve(outDir, 'katex.min.css'));
await cp(katexFontsSrc, resolve(outDir, 'fonts'), { recursive: true });

// hterm terminal engine — a prebuilt IIFE bundle (window.MDTerm = { lib, hterm })
// vendored under vendor-src/. It is NOT an esbuild-friendly npm module, so it is
// generated out-of-band (see vendor-src/README.md) and copied verbatim; loaded on
// demand the first time the terminal panel opens.
const htermSrc = resolve(__dirname, 'vendor-src/hterm_all.js');
await cp(htermSrc, resolve(outDir, 'hterm_all.js'));

console.log('✅ Front-end assets built to', outDir);
