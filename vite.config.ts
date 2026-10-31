import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Same CSP as the vercel.json header, as a <meta> tag so it also applies on any static host.
// Build only: the dev server injects CSS as <style> tags. frame-ancestors is header-only.
const csp = JSON.parse(readFileSync('vercel.json', 'utf8'))
  .headers[0].headers.find((h: { key: string }) => h.key === 'Content-Security-Policy')
  .value.replace(/;\s*frame-ancestors[^;]*/, '');

// pdf-lib's cipher (CipherTransformFactory) isn't re-exported from its package entry; xref.ts needs it to read
// encrypted objects exactly as pdf-lib does. Point at the same ES module file the package itself uses, and keep the
// package out of dev pre-bundling so dev and build share one copy of its classes.
const pdfLibCrypto = fileURLToPath(new URL('./node_modules/@cantoo/pdf-lib/es/core/crypto.js', import.meta.url));

export default defineConfig({
  resolve: { alias: { 'pdf-lib-crypto': pdfLibCrypto } },
  optimizeDeps: { exclude: ['@cantoo/pdf-lib', 'pdf-lib-crypto'], include: ['@cantoo/pdf-lib > node-html-better-parser', '@cantoo/pdf-lib > html-entities', '@cantoo/pdf-lib > tslib'] },
  plugins: [
    {
      name: 'csp-meta',
      apply: 'build',
      transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' }],
    },
  ],
});
