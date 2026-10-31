# Security

Fill In My PDF runs entirely in the browser. Documents, typed text, passwords and
signatures never leave the user's device. The main security property we defend is:
**the downloaded PDF shows exactly what the user saw on screen, and nothing else.**

## Reporting a vulnerability

Email **ali@convofi.com** with a description and, if possible, a proof-of-concept PDF.
Please do not open a public issue for security problems. You will get a reply within
a few days, and a fix before any public disclosure.

In scope:

- Any way to make the exported PDF differ from what the editor displayed
  (hidden fields, parser differences, appearance tricks, optional content).
- Any way for a PDF to execute code, make a network request, or escape the page.
- Any leak of document content, passwords or signatures off the device.
- Content Security Policy bypasses on fillinmypdf.com.

Out of scope: issues in the browser itself, and denial of service of the user's own tab
by an absurdly large file they chose to open.
