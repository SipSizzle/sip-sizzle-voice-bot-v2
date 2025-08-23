# Sip & Sizzle Voice Bot — Quick Guide

This is your phone-answering robot. It sends guests your OpenTable and Toast links, answers FAQs, and can transfer to a human.

## Easiest deploy: Render (Blueprint)
1) Put these files in a new GitHub repo.
2) Go to render.com → New → **Blueprint** → select your repo.
3) It will ask for 3 secrets: `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`.
4) Click **Apply**. You’ll get a URL like `https://sip-sizzle-voice-bot.onrender.com`.
5) In Twilio → your number → set Voice Webhook to `https://.../voice`, Messaging Webhook to `https://.../sms`.

## Twilio test checklist
- Call the number → say “Book a table Friday at 7” → SMS with OpenTable link.
- Say “Order pickup” → SMS with Toast link.
- Say “Talk to a person” → transfers to your staff number.

## Change hours or specials
Edit env vars in Render → **Environment** → Save → Redeploy.
