import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Same CSP as the vercel.json header, as a <meta> tag so it also applies on any static host.
// Build only: the dev server injects CSS as <style> tags. frame-ancestors is header-only.
const csp = JSON.parse(readFileSync('vercel.json', 'utf8'))
  .headers[0].headers.find((h: { key: string }) => h.key === 'Content-Security-Policy')
  .value.replace(/;\s*frame-ancestors[^;]*/, '');

export default defineConfig({
  plugins: [
    {
      name: 'csp-meta',
      apply: 'build',
      transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' }],
    },
  ],
});
