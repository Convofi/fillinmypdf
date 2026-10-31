# Contributing

Thanks for helping. The product rule is simple: **fill in and sign a PDF, with nothing
extra.** Changes that add buttons, settings, accounts, servers or storage will be
declined. Changes that make the existing flow faster, clearer, more reliable or more
secure are welcome.

## Run it

```sh
npm ci
npm run dev      # dev server
npm run build    # production build to dist/
```

## Before opening a pull request

- Keep the diff small and on one topic.
- Do not add runtime dependencies without discussing it in an issue first.
- Test in Chromium and WebKit (Safari). Playwright is a dev dependency.
- If you touch `src/export.ts`, the exported PDF must still render pixel-identical
  to the editor for every page; the export guard enforces this and your change must
  not weaken it.
- Security problems go to the address in SECURITY.md, not to a public issue.
