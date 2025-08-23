# Sip & Sizzle Voice Bot — Menus Fixed (pdfjs import)

This patch removes the default import of `pdf.worker.mjs` and uses:
```js
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
GlobalWorkerOptions.workerSrc = undefined;
```
which is correct for Node runtimes and fixes the “does not provide a default export” error.

## Deploy
1) Replace files in your repo with this bundle (root).
2) Render → Clear build cache & deploy.
3) If Render still picks Node 24 and you see odd pdfjs errors, set **Environment**: `NODE_VERSION=20` and redeploy.
