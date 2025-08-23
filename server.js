import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import twilio from 'twilio';
import WebSocket, { WebSocketServer } from 'ws';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'; // Node-safe PDF parsing
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Static (optional) for hosting any files
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/public', express.static(path.join(__dirname, 'public')));

// --- ENV ---
const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  MESSAGING_SERVICE_SID, // optional
  RESTAURANT_NAME = 'Sip & Sizzle',
  RESTAURANT_CITY = 'Fort Myers, FL',
  RESTAURANT_ADDRESS = '2236 First Street, Fort Myers FL 33901',
  OPEN_TABLE_LINK = 'https://www.opentable.com/r/sip-and-sizzle-reservations-fort-myers?restref=1406116&lang=en-US&ot_source=Lucy',
  TOAST_ORDER_LINK = 'https://order.toasttab.com/online/sip-sizzle-2236-first-street',
  DAY_MENU_LINK = '',
  DINNER_MENU_LINK = '',
  BEVERAGE_MENU_LINK = '',
  OPENAI_REALTIME_MODEL = 'gpt-4o-realtime-preview',
  OPENAI_REALTIME_VOICE = 'verse',
  PUBLIC_HOST
} = process.env;

const LISTEN_PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;

// Root check
app.get('/', (req, res) => res.send('OK'));

// TwiML test route
app.all('/voice-test', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'alice' }, 'Sip and Sizzle test line. If you hear this, webhooks are good.');
  res.type('text/xml').send(twiml.toString());
});

// --- Minimal TwiML streaming route (no extra attributes to prevent 12200) ---
app.all('/voice', (req, res) => {
  const host = PUBLIC_HOST || req.get('X-Forwarded-Host') || req.get('Host');
  const wssUrl = `wss://${host}/twilio-stream`;
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
      `<Say voice="alice">Thank you for calling ${RESTAURANT_NAME}. One moment while I connect you.</Say>` +
      `<Connect><Stream url="${wssUrl}"/></Connect>` +
    `</Response>`;
  res.status(200).type('text/xml').send(xml);
});

// --- SMS quick links ---
app.post('/sms', async (req, res) => {
  const { From } = req.body || {};
  const parts = [
    `Thanks for contacting ${RESTAURANT_NAME}!`,
    `Reservations: ${OPEN_TABLE_LINK}`,
    `Pickup: ${TOAST_ORDER_LINK}`
  ];
  if (DAY_MENU_LINK) parts.push(`Day Menu: ${DAY_MENU_LINK}`);
  if (DINNER_MENU_LINK) parts.push(`Dinner Menu: ${DINNER_MENU_LINK}`);
  if (BEVERAGE_MENU_LINK) parts.push(`Beverage Menu: ${BEVERAGE_MENU_LINK}`);
  try { await sendSMS(From, parts.join('  |  ')); } catch (e) { console.error('SMS auto-reply failed', e.message); }
  res.status(204).end();
});

// --- Menu ingest from PDFs (Uint8Array for pdfjs) ---
const MENU_SOURCES = [
  { key: 'Day', url: DAY_MENU_LINK },
  { key: 'Dinner', url: DINNER_MENU_LINK },
  { key: 'Beverage', url: BEVERAGE_MENU_LINK },
].filter(s => !!s.url);

let MENU_LINES = []; // unified list of {source, text}

async function fetchPdfText(url) {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const ab = await resp.arrayBuffer();
    const data = new Uint8Array(ab); // pdfjs requires Uint8Array
    const loadingTask = getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true });
    const pdf = await loadingTask.promise;
    let txt = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const strings = content.items.map(it => (typeof it.str === 'string' ? it.str : '')).filter(Boolean);
      txt += strings.join(' ') + '\n';
    }
    return txt;
  } catch (e) {
    console.error('Failed to fetch/parse PDF', url, e);
    return '';
  }
}
function normalizeLines(txt) {
  return txt.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
async function ingestMenus() {
  try {
    MENU_LINES = [];
    for (const src of MENU_SOURCES) {
      const t = await fetchPdfText(src.url);
      const lines = normalizeLines(t);
      MENU_LINES.push(...lines.map(l => ({ source: src.key, text: l })));
    }
    console.log(`Ingested ${MENU_LINES.length} menu lines from ${MENU_SOURCES.length} PDFs`);
  } catch (e) {
    console.error('Menu ingest failure', e);
  }
}
function searchMenuLines(query, limit=8) {
  if (!MENU_LINES.length) return [];
  const q = (query||'').toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = MENU_LINES.map(r => {
    const hay = r.text.toLowerCase();
    let score = 0;
    if (hay.includes(q)) score += 3;
    for (const w of tokens) if (w && hay.includes(w)) score += 1;
    if (/\$\s?\d/.test(r.text)) score += 1; // price hint
    return { r, score };
  }).filter(x => x.score > 0);
  scored.sort((a,b)=> b.score - a.score);
  const seen = new Set();
  const results = [];
  for (const {r} of scored) {
    if (seen.has(r.text)) continue;
    results.push(r);
    seen.add(r.text);
    if (results.length >= limit) break;
  }
  return results;
}
function formatMenuAnswer(q, rows) {
  if (!rows.length) return `I didn’t find “${q}” on the current menus. I can text you links to the Day, Dinner, or Beverage menus if you’d like.`;
  const bullets = rows.slice(0,5).map(x => `• (${x.source}) ${x.text}`);
  return `Here’s what I found:\n${bullets.join('\n')}\n(Items and prices can change; I can confirm with the team.)`;
}

// Start ingest (non-blocking)
ingestMenus().catch(e => console.error('Menu ingest failed at boot:', e));

// --- μ-law helpers (Twilio uses 8kHz) ---
const exp_lut = [0,132,396,924,1980,4092,8316,16764];
function ulawToLinear(ulawByte) {
  ulawByte = ~ulawByte & 0xff;
  const sign = (ulawByte & 0x80);
  const exponent = (ulawByte >> 4) & 0x07;
  const mantissa = ulawByte & 0x0f;
  let sample = exp_lut[exponent] + (mantissa << (exponent + 3));
  if (sign) sample = -sample;
  return sample;
}
function linearToUlaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  const CLIP = 32635;
  if (sample > CLIP) sample = CLIP;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  let mantissa = (sample >> (exponent + 3)) & 0x0f;
  const ulawByte = ~(sign | (exponent << 4) | mantissa);
  return ulawByte & 0xff;
}
function mulawB64ToPCM16(b64) {
  const mu = Buffer.from(b64, 'base64');
  const out = Buffer.alloc(mu.length * 2);
  for (let i = 0; i < mu.length; i++) {
    const s = ulawToLinear(mu[i]);
    out.writeInt16LE(s, i*2);
  }
  return out; // 8kHz PCM16 LE
}
function pcm16ToMulawB64(bufPCM16) {
  const frames = bufPCM16.length / 2;
  const out = Buffer.alloc(frames);
  for (let i = 0; i < frames; i++) {
    const s = bufPCM16.readInt16LE(i*2);
    out[i] = linearToUlaw(s);
  }
  return out.toString('base64');
}

// Start HTTP server and WS upgrade
const server = app.listen(LISTEN_PORT, () => console.log(`Voice bot listening on :${LISTEN_PORT}`));
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/twilio-stream')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// Cache callSid -> from number (for SMS)
const callFromCache = new Map();
async function getFromNumber(callSid) {
  if (callFromCache.has(callSid)) return callFromCache.get(callSid);
  const call = await twilioClient.calls(callSid).fetch();
  callFromCache.set(callSid, call.from);
  return call.from;
}

async function sendSMS(to, body) {
  const suffix = " Reply STOP to opt out. HELP for help. Msg&data rates may apply.";
  const finalBody = body.endsWith(suffix) ? body : (body + suffix);
  if (process.env.MESSAGING_SERVICE_SID) {
    return twilioClient.messages.create({ to, body: finalBody, messagingServiceSid: process.env.MESSAGING_SERVICE_SID });
  }
  return twilioClient.messages.create({ to, from: TWILIO_NUMBER, body: finalBody });
}

// --- WS per call: bridge Twilio ↔ OpenAI Realtime ---
wss.on('connection', async (twilioWS, req) => {
  console.log('Twilio WS connected');
  let streamSid = null;
  let callSid = null;
  let textBuffer = "";
  let sentDay = false, sentDinner = false, sentBev = false;

  // Buffers
  const pendingToOpenAI = []; // caller audio before OA WS open
  const pendingToTwilio = []; // OA audio before Twilio stream start

  const oaHeaders = { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' };
  const oaUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;
  const oaWS = new WebSocket(oaUrl, { headers: oaHeaders });

  const greeting = `Thank you for calling ${RESTAURANT_NAME}. We’re in ${RESTAURANT_ADDRESS}, ${RESTAURANT_CITY}. We open daily at 10 a.m. for breakfast and lunch, and 4 to 10 p.m. for dinner. Happy Hour is 3 to 5 p.m. Ask me about menu items, prices, wine pairings, reservations, to-go orders, or parking.`;

  const instructions =
`You are the friendly host for ${RESTAURANT_NAME}. Speak casually and briefly. Never invent prices or availability.

To look up menu items or prices, emit one token line:
[[MENU_SEARCH: <query>]]

If caller wants links, emit one of:
[[SEND:MENU_DAY]] [[SEND:MENU_DINNER]] [[SEND:MENU_BEVERAGE]]
For reservations or to-go: [[SEND:OPENTABLE]] [[SEND:TOAST]]

After emitting a token, continue with a concise spoken answer. Always note that items and prices may change.`;

  // --- OpenAI WS ---
  oaWS.on('open', () => {
    console.log('OpenAI WS open');
    oaWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        voice: OPENAI_REALTIME_VOICE,
        input_audio_format: { type: 'pcm16', sample_rate_hz: 8000 },
        output_audio_format: { type: 'pcm16', sample_rate_hz: 8000 },
        instructions
      }
    }));
    // If caller audio was buffered before open, flush it now
    if (pendingToOpenAI.length) {
      for (const b64 of pendingToOpenAI.splice(0)) {
        oaWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
      }
      oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      oaWS.send(JSON.stringify({ type: 'response.create' }));
    }
  });
  oaWS.on('error', (err) => console.error('OpenAI WS error', err));
  oaWS.on('close', () => { console.log('OpenAI WS closed'); try { twilioWS.close(); } catch {} });

  oaWS.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'output_text.delta' && msg.delta) {
        textBuffer += msg.delta;

        // MENU SEARCH
        const m = textBuffer.match(/\[\[MENU_SEARCH:\s*([^\]]+)\]\]/i);
        if (m) {
          const q = m[1].trim();
          textBuffer = textBuffer.replace(m[0], '');
          const rows = searchMenuLines(q, 8);
          const spoken = formatMenuAnswer(q, rows);
          oaWS.send(JSON.stringify({ type: 'response.create', response: { instructions: spoken } }));
        }

        // SEND LINKS
        if (!sentDay && DAY_MENU_LINK && textBuffer.includes('[[SEND:MENU_DAY]]')) {
          sentDay = true; textBuffer = textBuffer.replace('[[SEND:MENU_DAY]]','');
          if (callSid) { const to = await getFromNumber(callSid); await sendSMS(to, `Sip & Sizzle Day Menu: ${DAY_MENU_LINK}`); }
        }
        if (!sentDinner && DINNER_MENU_LINK && textBuffer.includes('[[SEND:MENU_DINNER]]')) {
          sentDinner = true; textBuffer = textBuffer.replace('[[SEND:MENU_DINNER]]','');
          if (callSid) { const to = await getFromNumber(callSid); await sendSMS(to, `Sip & Sizzle Dinner Menu: ${DINNER_MENU_LINK}`); }
        }
        if (!sentBev && BEVERAGE_MENU_LINK && textBuffer.includes('[[SEND:MENU_BEVERAGE]]')) {
          sentBev = true; textBuffer = textBuffer.replace('[[SEND:MENU_BEVERAGE]]','');
          if (callSid) { const to = await getFromNumber(callSid); await sendSMS(to, `Sip & Sizzle Beverage Menu: ${BEVERAGE_MENU_LINK}`); }
        }

        // Existing tokens for reservations/toast
        if (textBuffer.includes('[[SEND:OPENTABLE]]')) {
          textBuffer = textBuffer.replace('[[SEND:OPENTABLE]]','');
          if (callSid) { const to = await getFromNumber(callSid); await sendSMS(to, `Reservations: ${OPEN_TABLE_LINK}`); }
        }
        if (textBuffer.includes('[[SEND:TOAST]]')) {
          textBuffer = textBuffer.replace('[[SEND:TOAST]]','');
          if (callSid) { const to = await getFromNumber(callSid); await sendSMS(to, `Pickup ordering: ${TOAST_ORDER_LINK}`); }
        }
      }

      // Buffer OpenAI audio until Twilio streamSid is known and socket OPEN
      if (msg.type === 'output_audio.delta' && msg.audio) {
        pendingToTwilio.push(msg.audio); // base64 PCM16
        flushToTwilio();
      }
    } catch (e) { console.error('OpenAI msg parse error', e); }
  });

  function flushToTwilio() {
    if (!streamSid) return;
    if (twilioWS.readyState !== WebSocket.OPEN) return;
    while (pendingToTwilio.length) {
      const b64pcm = pendingToTwilio.shift();
      const b64Mu = pcm16ToMulawB64(Buffer.from(b64pcm, 'base64'));
      twilioWS.send(JSON.stringify({ event: 'media', streamSid, media: { payload: b64Mu } }));
    }
  }

  // --- Twilio WS ---
  twilioWS.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.event === 'start') {
      console.log('Twilio start received');
      streamSid = m.start.streamSid;
      callSid = m.start.callSid;
      // Now that Twilio is ready, send the greeting
      if (oaWS.readyState === WebSocket.OPEN) {
        oaWS.send(JSON.stringify({ type: 'response.create', response: { instructions: greeting } }));
      }
      flushToTwilio();
    } else if (m.event === 'media' && m.media?.payload) {
      // Caller audio -> OpenAI (buffer if OA WS not open yet)
      const pcm16 = mulawB64ToPCM16(m.media.payload);
      const b64pcm = Buffer.from(pcm16).toString('base64');
      if (oaWS.readyState === WebSocket.OPEN) {
        oaWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64pcm }));
        oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        oaWS.send(JSON.stringify({ type: 'response.create' }));
      } else {
        pendingToOpenAI.push(b64pcm);
      }
    } else if (m.event === 'stop') {
      try { oaWS.close(); } catch {}
      try { twilioWS.close(); } catch {}
    }
  });

  twilioWS.on('close', () => { console.log('Twilio WS closed'); try { oaWS.close(); } catch {} });
  twilioWS.on('error', (err) => console.error('Twilio WS error', err));
});

// --- Global error guard ---
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (req.path === '/voice' || req.path === '/voice-test') {
    res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  } else {
    res.status(500).send('');
  }
});
