# Sip & Sizzle Voice Bot — Streaming Voice with PDF Menus (Fixed)

This build replaces **pdf-parse** with **pdfjs-dist** to avoid the ENOENT test-file error during deployment.

## Deploy (Web Service on Render)
1) Upload files at repo **root**.
2) Render → Web Service
   - Build: `npm install`
   - Start: `npm start`
3) Add environment variables (copy from `.env.example`).
4) Deploy latest commit (or Clear build cache & deploy). Home page should show **OK**.

## Twilio
- Voice webhook (POST): `https://<your-render-url>/voice`
- (Optional) SMS webhook (POST): `https://<your-render-url>/sms`

## How menu answers work
- AI emits `[[MENU_SEARCH: salmon]]` etc.
- Server searches text from your Day, Dinner, Beverage PDFs (parsed with pdfjs-dist).
- AI reads back concise results and can text links:
  - `[[SEND:MENU_DAY]]` `[[SEND:MENU_DINNER]]` `[[SEND:MENU_BEVERAGE]]`
  - Also supports `[[SEND:OPENTABLE]]` and `[[SEND:TOAST]]`.

## Production texting
Use a Twilio Messaging Service (10DLC or Verified Toll-Free) and set `MESSAGING_SERVICE_SID=MG...`.
