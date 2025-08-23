import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import twilio from 'twilio';

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- ENV ---
const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  STAFF_TRANSFER_NUMBER,
  RESTAURANT_NAME,
  RESTAURANT_CITY,
  RESTAURANT_ADDRESS,
  RESTAURANT_PARKING,
  OPEN_TABLE_LINK,
  TOAST_ORDER_LINK,
  HOURS_JSON = '{}',
  SPECIALS_JSON = '[]',
  PORT = 3000
} = process.env;

const OpenTable = OPEN_TABLE_LINK;
const ToastLink = TOAST_ORDER_LINK;
const hours = JSON.parse(HOURS_JSON || '{}');
const specials = JSON.parse(SPECIALS_JSON || '[]');

const VoiceResponse = twilio.twiml.VoiceResponse;
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Simple in-memory sessions keyed by CallSid
const SESSIONS = new Map();
const getSession = (sid) => {
  if (!SESSIONS.has(sid)) SESSIONS.set(sid, { history: [] });
  return SESSIONS.get(sid);
};

// --- SYSTEM PROMPT ---
const systemPrompt = () => `You are the friendly automated host for ${RESTAURANT_NAME} in ${RESTAURANT_CITY}.
Facts you can rely on:
- Address: ${RESTAURANT_ADDRESS}
- Parking: ${RESTAURANT_PARKING}
- Hours by day (lowercase keys): ${JSON.stringify(hours)}
- Specials: ${JSON.stringify(specials)}
- Reservations: Guests book via OpenTable link.
- Pickup orders: Guests order via Toast online ordering link.

Style: Warm, concise, professional. Never invent prices or availability.
If unsure, say you'll text the official link.

Allergens: provide general info only; advise guests to confirm with staff.

Return a JSON object ONLY, with these fields:
{
  "reply_tts": string,
  "send_sms": null | {
    "type": "opentable" | "toast" | "generic",
    "body": string,
    "link": string | null
  },
  "transfer": boolean,
  "end_call": boolean
}

Capabilities:
- If caller asks to book: offer to text the OpenTable link and keep talking while they open it.
- If caller asks to order pickup: offer to text the Toast link.
- If caller asks hours, address, parking, specials: answer from facts above.
- If caller asks for a person or special request you cannot complete: offer transfer to staff.
`;

// --- Helpers ---
async function askLLM(callSid, userText) {
  const session = getSession(callSid);
  const messages = [
    { role: 'system', content: systemPrompt() },
    ...session.history,
    { role: 'user', content: userText }
  ];

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages
  });

  const content = completion.choices[0].message.content || '{}';
  let data;
  try { data = JSON.parse(content); } catch (e) { data = { reply_tts: "Sorry, I had trouble. Let me transfer you to the team.", send_sms: null, transfer: true, end_call: false }; }

  // Save assistant reply into history
  session.history.push({ role: 'user', content: userText });
  session.history.push({ role: 'assistant', content: data.reply_tts });
  return data;
}

async function maybeSendSMS(to, payload) {
  if (!payload) return;
  let link = payload.link;
  if (!link) {
    if (payload.type === 'opentable') link = OpenTable;
    if (payload.type === 'toast') link = ToastLink;
  }
  const body = link ? `${payload.body}\n${link}` : payload.body;
  if (!body) return;
  try {
    await client.messages.create({ to, from: TWILIO_NUMBER, body });
  } catch (err) {
    console.error('SMS send failed:', err.message);
  }
}

// --- Voice entrypoint ---
app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech dtmf',
    numDigits: 1,
    action: '/gather',
    method: 'POST',
    language: 'en-US',
    speechTimeout: 'auto',
    hints: 'reservation, book, open table, table, order, toast, pickup, hours, address, parking, menu, specials, gluten, vegan, transfer, happy hour'
  });

  gather.say({ voice: 'alice' }, `Hi! You’ve reached ${RESTAURANT_NAME}. How can I help today? You can say things like book a table, place a pickup order, hours, or specials.`);

  // Fallback if no input
  twiml.say({ voice: 'alice' }, `Sorry, I didn't catch that.`);
  twiml.redirect('/voice');

  res.type('text/xml').send(twiml.toString());
});

// --- Gather handler ---
app.post('/gather', async (req, res) => {
  const { CallSid, From, To, SpeechResult, Digits } = req.body;
  const twiml = new VoiceResponse();

  try {
    let userText = (SpeechResult || '').trim();

    // DTMF shortcuts
    if (!userText && Digits) {
      if (Digits === '1') userText = "What are today's hours?";
      if (Digits === '2') userText = "What's the address and parking?";
      if (Digits === '3') userText = 'Please send me the OpenTable link to book.';
      if (Digits === '4') userText = 'Please send me the Toast ordering link.';
      if (Digits === '0') userText = 'I want to talk to a person.';
    }

    if (!userText) {
      twiml.say({ voice: 'alice' }, `Sorry, I didn't hear anything.`);
      twiml.redirect('/voice');
      return res.type('text/xml').send(twiml.toString());
    }

    const data = await askLLM(CallSid, userText);

    // Send SMS if requested
    await maybeSendSMS(From, data.send_sms);

    // Transfer if requested
    if (data.transfer && STAFF_TRANSFER_NUMBER) {
      twiml.say({ voice: 'alice' }, 'Sure—one moment while I transfer you.');
      const dial = twiml.dial({ callerId: From });
      dial.number(STAFF_TRANSFER_NUMBER);
      return res.type('text/xml').send(twiml.toString());
    }

    // Speak reply
    twiml.say({ voice: 'alice' }, data.reply_tts || 'Okay.');

    if (data.end_call) {
      twiml.say({ voice: 'alice' }, 'Thanks for calling and have a great day!');
      twiml.hangup();
    } else {
      const gather = twiml.gather({
        input: 'speech dtmf',
        numDigits: 1,
        action: '/gather',
        method: 'POST',
        language: 'en-US',
        speechTimeout: 'auto'
      });
      gather.say({ voice: 'alice' }, 'Anything else I can help with?');
    }

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('Gather error:', err);
    twiml.say({ voice: 'alice' }, 'Sorry, I ran into a problem. Let me transfer you to the team.');
    if (STAFF_TRANSFER_NUMBER) {
      const dial = twiml.dial({ callerId: From });
      dial.number(STAFF_TRANSFER_NUMBER);
    } else {
      twiml.say({ voice: 'alice' }, 'Please call back in a few minutes.');
      twiml.hangup();
    }
    res.type('text/xml').send(twiml.toString());
  }
});

// Optional inbound SMS handler
app.post('/sms', async (req, res) => {
  const { From, Body } = req.body;
  const msg = `Thanks for texting ${RESTAURANT_NAME}! For reservations use OpenTable: ${OpenTable}\nFor pickup orders use Toast: ${ToastLink}`;
  try { await client.messages.create({ to: From, from: TWILIO_NUMBER, body: msg }); } catch (e) { console.error('SMS autoreply failed:', e.message); }
  res.status(204).end();
});

app.get('/', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`Voice bot listening on :${PORT}`));
