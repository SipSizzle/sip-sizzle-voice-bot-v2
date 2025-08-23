import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import twilio from 'twilio';
import WebSocket, { WebSocketServer } from 'ws';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/public', express.static(path.join(__dirname, 'public')));

// --- ENV ---
const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  MESSAGING_SERVICE_SID,
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
  PUBLIC_HOST,
  DISABLE_MENU_INGEST = 'false',
} = process.env;

const LISTEN_PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const { VoiceResponse } = twilio.twiml;

// Root
app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.json({ ok: true }));

// TwiML test route
app.all('/voice-test', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'alice' }, 'Sip and Sizzle test line. If you hear this, webhooks are good.');
  res.type('text/xml').send(twiml.toString());
});

function safeForSpeech(s) { return String(s || '').replace(/&/g, 'and'); }

// --- Twilio streaming TwiML ---
app.all('/voice', (req, res) => {
  const host = PUBLIC_HOST || req.get('X-Forwarded-Host') || req.get('Host');
  const httpBase = `https://${host}`;
  const wssUrl = `wss://${host}/twilio-stream`;

  const twiml = new VoiceResponse();
  twiml.say({ voice: 'alice' }, `Thank you for calling ${safeForSpeech(RESTAURANT_NAME)}. One moment while I connect you.`);
  const connect = twiml.connect();
  connect.stream({ url: wssUrl, statusCallback: `${httpBase}/stream-status`, statusCallbackMethod: 'POST' });

  res.status(200).type('text/xml').send(twiml.toString());
});

app.post('/stream-status', (req, res) => {
  try { console.log('STREAM STATUS:', JSON.stringify(req.body)); }
  catch { console.log('STREAM STATUS (raw):', req.body); }
  res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
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
  try { if (From) await sendSMS(From, parts.join('  |  ')); } catch (e) { console.error('SMS auto-reply failed', e.message); }
  res.status(204).end();
});

// --- Menu ingest from PDFs (Uint8Array for pdfjs) ---
const MENU_SOURCES = [
  { key: 'Day', url: DAY_MENU_LINK },
  { key: 'Dinner', url: DINNER_MENU_LINK },
  { key: 'Beverage', url: BEVERAGE_MENU_LINK },
].filter(s => !!s.url);

let MENU_LINES = [];

async function fetchPdfText(url) {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const ab = await resp.arrayBuffer();
    const data = new Uint8Array(ab);
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
  if (DISABLE_MENU_INGEST === 'true') { console.log('Menu ingest disabled by env'); return; }
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
    if (/\$\s?\d/.test(r.text)) score += 1;
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
  return `Here’s what I found:\n${bullets.join('\n')}\n(Items and prices may change.)`;
}

ingestMenus().catch(e => console.error('Menu ingest failed at boot:', e));

// --- Helpers: PCM16 (24k) -> μ-law (8k) ---
function linearToUlaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  const CLIP = 32635;
  if (sample > CLIP) sample = CLIP;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}
// naive decimation 24k -> 8k (pick every 3rd sample). Good enough for voice.
function pcm24kToUlaw8k(pcm16LEBuf) {
  const inSamples = pcm16LEBuf.length / 2;
  const outSamples = Math.floor(inSamples / 3);
  const out = Buffer.alloc(outSamples);
  for (let i=0;i<outSamples;i++) {
    const si = i*3*2;
    const s = pcm16LEBuf.readInt16LE(si);
    out[i] = linearToUlaw(s);
  }
  return out;
}

// --- Start HTTP server + WS ---
const server = app.listen(LISTEN_PORT, () => console.log(`Voice bot listening on :${LISTEN_PORT}`));
const wss = new WebSocketServer({ server, path: '/twilio-stream' });
wss.on('headers', (headers, req) => { console.log('WS upgrade headers sent for', req.url); });

// Cache callSid -> from
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

// --- Bridge Twilio ↔ OpenAI Realtime ---
wss.on('connection', async (twilioWS, req) => {
  console.log('Twilio WS connected', req.url);
  let streamSid = null;
  let callSid = null;
  let textAccum = "";
  let sentDay = false, sentDinner = false, sentBev = false;

  let bytesSinceCommit = 0;
  const COMMIT_BYTES = 1600; // 200ms at 8k

  const pendingToTwilio = [];
  let twilioReady = false;
  let oaReady = false;
  let greetingSent = false;
  let activeResponse = false;

  const oaHeaders = { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' };
  const oaUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;
  const oaWS = new WebSocket(oaUrl, { headers: oaHeaders });

  const greeting = `Thank you for calling ${safeForSpeech(RESTAURANT_NAME)}. We’re in ${RESTAURANT_ADDRESS}, ${RESTAURANT_CITY}. We open daily at 10 a.m. for breakfast and lunch, and 4 to 10 p.m. for dinner. Happy Hour is 3 to 5 p.m. Ask me about menu items, prices, wine pairings, reservations, to-go orders, or parking.`;

  const instructions =
`You are the friendly host for ${safeForSpeech(RESTAURANT_NAME)}. Speak casually and briefly. Never invent prices or availability.

To look up menu items or prices, emit one token line:
[[MENU_SEARCH: <query>]]

If caller wants links, emit one of:
[[SEND:MENU_DAY]] [[SEND:MENU_DINNER]] [[SEND:MENU_BEVERAGE]]
For reservations or to-go: [[SEND:OPENTABLE]] [[SEND:TOAST]]

After emitting a token, continue with a concise spoken answer. Always note that items and prices may change.`;

  function maybeStartGreeting() {
    if (twilioReady && oaReady && !greetingSent && !activeResponse) {
      greetingSent = true;
      activeResponse = true;
      console.log('Sending AI greeting (audio+text)…');
      oaWS.send(JSON.stringify({
        type: 'response.create',
        response: { modalities: ['audio','text'], instructions: greeting }
      }));
    }
  }

  // --- OpenAI WS ---
  oaWS.on('open', () => {
    console.log('OpenAI WS open');
    oaReady = true;
    oaWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['audio','text'],
        voice: OPENAI_REALTIME_VOICE,
        // Keep Twilio input as mulaw 8k, output as PCM16 24k (we will resample to mulaw 8k)
        input_audio_format: { type: 'mulaw', sample_rate_hz: 8000 },
        output_audio_format: { type: 'pcm16', sample_rate_hz: 24000 },
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 150, silence_duration_ms: 500 },
        instructions
      }
    }));
    maybeStartGreeting();
  });
  oaWS.on('error', (err) => console.error('OpenAI WS error', err));
  oaWS.on('close', () => { console.log('OpenAI WS closed'); try { twilioWS.close(); } catch {} });

  oaWS.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'response.created') { activeResponse = true; console.log('OA response.created'); }
      if (msg.type === 'response.done') { activeResponse = false; console.log('OA response.done'); }
      if (msg.type === 'error') { console.error('OA ERROR:', msg.error || msg); }

      if (msg.type === 'response.text.delta' && msg.delta) {
        textAccum += msg.delta;

        const m = textAccum.match(/\[\[MENU_SEARCH:\s*([^\]]+)\]\]/i);
        if (m) {
          const q = m[1].trim();
          textAccum = textAccum.replace(m[0], '');
          const rows = searchMenuLines(q, 8);
          const spoken = formatMenuAnswer(q, rows);
          if (!activeResponse) {
            activeResponse = true;
            console.log('Sending menu answer (audio+text)…');
            oaWS.send(JSON.stringify({ type: 'response.create', response: { modalities: ['audio','text'], instructions: spoken } }));
          }
        }

        if (!sentDay && DAY_MENU_LINK && textAccum.includes('[[SEND:MENU_DAY]]')) {
          sentDay = true; textAccum = textAccum.replace('[[SEND:MENU_DAY]]','');
          if (callSid) { const to = await getFromNumber(callSid); await sendSMS(to, `Sip & Sizzle Day Menu: ${DAY_MENU_LINK}`); }
        }
        if (!sentDinner && DINNER_MENU_LINK && textAccum.includes('[[SEND:MENU_DINNER]]')) {
          sentDinner = true; textAccum = textAccum.replace('[[SEND:MENU_DINNER]]','');
          if (callSid) { const to = await getFromNumber(callSid); await sendSMS(to, `Sip & Sizzle Dinner Menu: ${DINNER_MENU_LINK}`); }
        }
        if (!sentBev && BEVERAGE_MENU_LINK && textAccum.includes('[[SEND:MENU_BEVERAGE]]')) {
          sentBev = true; textAccum = textAccum.replace('[[SEND:MENU_BEVERAGE]]','');
          if (callSid) { const to = await getFromNumber(callSid); await sendSMS(to, `Sip & Sizzle Beverage Menu: ${BEVERAGE_MENU_LINK}`); }
        }

        if (textAccum.includes('[[SEND:OPENTABLE]]')) {
          textAccum = textAccum.replace('[[SEND:OPENTABLE]]','');
          if (callSid) { const to = await getFromNumber(callSid); await sendSMS(to, `Reservations: ${OPEN_TABLE_LINK}`); }
        }
        if (textAccum.includes('[[SEND:TOAST]]')) {
          textAccum = textAccum.replace('[[SEND:TOAST]]','');
          if (callSid) { const to = await getFromNumber(callSid); await sendSMS(to, `Pickup ordering: ${TOAST_ORDER_LINK}`); }
        }
      }

      // OA audio (PCM16 24k) -> μ-law 8k for Twilio
      if (msg.type === 'response.audio.delta' && msg.delta) {
        const pcm = Buffer.from(msg.delta, 'base64'); // little-endian 16-bit PCM @ 24k
        const mu = pcm24kToUlaw8k(pcm);
        const b64mu = mu.toString('base64');
        pendingToTwilio.push(b64mu);
        flushToTwilio();
      }
    } catch (e) { console.error('OpenAI msg parse error', e); }
  });

  function flushToTwilio() {
    if (!streamSid) return;
    if (twilioWS.readyState !== WebSocket.OPEN) return;
    while (pendingToTwilio.length) {
      const b64mu = pendingToTwilio.shift();
      twilioWS.send(JSON.stringify({ event: 'media', streamSid, media: { payload: b64mu } }));
    }
  }

  function sendBeep() {
    if (!streamSid || twilioWS.readyState !== WebSocket.OPEN) return;
    // tiny clickless 200ms 440Hz beep in μ-law 8k
    const sampleRate = 8000, ms = 200, freq = 440;
    const samples = Math.floor(sampleRate * (ms / 1000));
    const amp = 7000;
    const mu = Buffer.alloc(samples);
    for (let i = 0; i < samples; i++) {
      const t = i / sampleRate;
      const s = Math.sin(2 * Math.PI * freq * t) * amp;
      mu[i] = linearToUlaw(s);
    }
    const b64Mu = mu.toString('base64');
    twilioWS.send(JSON.stringify({ event: 'media', streamSid, media: { payload: b64Mu } }));
  }

  // --- Twilio WS ---
  twilioWS.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.event === 'start') {
        console.log('Twilio start received');
        streamSid = m.start.streamSid;
        callSid = m.start.callSid;
        twilioReady = true;
        bytesSinceCommit = 0;
        sendBeep();
        maybeStartGreeting();
      } else if (m.event === 'media' && m.media?.payload) {
        const b64mu = m.media.payload; // base64 μ-law 8k
        if (oaWS.readyState === WebSocket.OPEN) {
          oaWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64mu }));
          bytesSinceCommit += Buffer.from(b64mu, 'base64').length;
          if (bytesSinceCommit >= COMMIT_BYTES) {
            oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            // rely on server_vad to trigger responses
            bytesSinceCommit = 0;
          }
        }
      } else if (m.event === 'stop') {
        console.log('Twilio stop received');
        try { oaWS.close(); } catch {}
        try { twilioWS.close(); } catch {}
      }
    } catch (e) {
      console.error('Twilio msg parse error', e);
    }
  });

  twilioWS.on('ping', () => { try { twilioWS.pong(); } catch {} });
  twilioWS.on('close', (code, reason) => { console.log('Twilio WS closed', code, reason?.toString()); try { oaWS.close(); } catch {} });
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
