# Sip & Sizzle Voice Bot — Streaming Voice with PDF Menus

This build fetches your **Day, Dinner, and Beverage** menu PDFs at startup, indexes the text, and lets the AI answer item/price questions with a natural streaming voice.

## Deploy (Web Service on Render)
1) Upload these files at your repo **root**.
2) Render → New → Web Service → pick repo.
   - Build command: `npm install`
   - Start command: `npm start`
3) Add environment variables (copy from `.env.example`; do not commit real secrets).
4) Deploy latest commit (or Clear build cache & deploy). Visiting the homepage should show **OK**.

## Twilio
- In Twilio → your number (+1-239-666-7974):
  - Voice webhook (POST): `https://<your-render-url>/voice`
  - (Optional) SMS webhook (POST): `https://<your-render-url>/sms`

## How menu answers work
- The Realtime agent emits a token like `[[MENU_SEARCH: salmon]]`.
- The server searches all three PDFs’ text for relevant lines and asks the agent to speak a concise answer, e.g., “Seared salmon with lemon butter — $24 (Dinner menu).”
- It can also **text links** to the menus:
  - `[[SEND:MENU_DAY]]`, `[[SEND:MENU_DINNER]]`, `[[SEND:MENU_BEVERAGE]]`
  - `[[SEND:OPENTABLE]]` and `[[SEND:TOAST]]` are also supported.

> Note: PDF text sometimes has line breaks—your answers will stay concise but may not capture every modifier. For perfect control, you can also maintain a `data/menu.json` later.

## Testing prompts
- “Do you have a kids menu?”
- “How much is the ribeye on the dinner menu?”
- “What’s in your Old Fashioned?”
- “Can you text me the beverage menu?”

## Production texting (A2P)
Use a Messaging Service with an approved 10DLC campaign or a verified Toll-Free number. Then add `MESSAGING_SERVICE_SID=MG...` in your Render environment.

