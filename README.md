# Fill In My PDF

Fill in and sign PDFs in the browser. Drop a PDF, click to type, place check marks and a drawn
signature, then download a flattened copy. No accounts, no uploads, no server.

## Run / build

```sh
npm install
npm run dev       # local dev server
npm run build     # type-check + production build into dist/
npm run preview   # serve dist/
```

`dist/` is a static site; `vercel.json` adds the security and cache headers on Vercel.

## How it works

pdf.js renders the pages and reports form fields, which become click targets for overlay text,
check marks and signatures stored in PDF points. On download, pdf-lib (`@cantoo/pdf-lib`) loads
the original bytes, flattens any form, draws the overlays and saves a new file.

## Privacy and security

- Client-side only: the PDF is read with the File API and never leaves the device. The only thing
  stored is your drawn signature, in this browser's localStorage ("Forget saved signature" in the
  signature dialog removes it).
- Strict Content-Security-Policy (header on Vercel, `<meta>` in the built `index.html`):
  `script-src 'self' 'wasm-unsafe-eval'` (WebAssembly image decoders only; no JS `eval`), no inline
  scripts or styles, `connect-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`.
- PDF JavaScript and XFA are never executed (pdf.js scripting and XFA rendering are off).
- Password-protected PDFs are decrypted locally; the downloaded copy is unencrypted.
- The download is flattened exactly as shown and stripped of auto-run/JavaScript/launch/submit actions.

## Known limitations

- Values already baked into a form are not editable; you can only fill blank fields or type on top.
- Text in a multiline field can overflow past the field's bottom edge (the editor shows the same).
- Fonts are the PDF standard fonts (Helvetica, Courier); characters outside WinAnsi export as `?`.
- On phones, use pinch-zoom to reach small fields; there is no in-app zoom.
