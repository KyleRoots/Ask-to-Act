---
name: CSP nonce via AsyncLocalStorage
description: How per-request CSP nonces flow to both helmet and server-rendered HTML in api-server, and why style-src-attr still allows unsafe-inline.
---

# CSP nonce via AsyncLocalStorage

The api-server serves several hand-rendered HTML pages (landing, legal, connector
setup, enroll form) outside any template engine. To run a strict CSP with
per-request nonces, the nonce is generated once per request and shared two ways:

- A middleware (runs **before** helmet) generates a fresh random nonce, sets
  `res.locals.cspNonce`, and runs the rest of the chain inside an
  `AsyncLocalStorage` store holding that nonce.
- helmet's `scriptSrc`/`styleSrc` use a **directive function** that reads
  `res.locals.cspNonce`, so the response header carries the same nonce.
- HTML builders call `nonceAttr()` / `currentNonce()` which read the ALS value,
  so every `<script>`/`<style>` tag emits the matching nonce.

**Why ALS, not a passed argument:** the HTML builder helpers (`page()`,
`legalPage()`, etc.) are called deep in route handlers and would otherwise need
the nonce threaded through every signature. ALS keeps them ergonomic and avoids
accidental cross-request reuse (each request has its own store).

**How to verify:** the header nonce must equal the rendered `<style nonce="...">`
on a page. They agreeing is proof the ALS value and helmet value are the same.

**Residual `style-src-attr 'unsafe-inline'`:** intentionally kept. It only allows
inline `style="..."` *attributes* (presentational, not executable). `script-src`,
`script-src-attr 'none'`, and `style-src` are all nonce-only / no-unsafe-inline.
Eliminating it would require nonce-incompatible refactors of inline style attrs
for marginal benefit. Do not "fix" it without that context.

**Gotcha:** any new server-rendered `<script>`/`<style>` MUST include
`nonceAttr()` or it will be CSP-blocked at runtime (tsc/tests won't catch it —
only a live request shows the violation).
