// Gemini TTS proxy — speaks a word (or sentence) in Leda (en-AU, female).
//
// Setup (one-time):
//   1. Get a free Gemini API key at https://aistudio.google.com (use Chrome
//      if Safari's iCloud Keychain gives you trouble with the Google login).
//   2. Vercel dashboard → spelling-game project → Settings → Environment Variables
//   3. Add GEMINI_API_KEY = <your key>. Apply to Production + Preview + Development.
//   4. Redeploy (any push, or "Redeploy" from the Deployments tab).
//
// Returns 503 until the key is set; the frontend then falls back to the
// native Aussie Karen/Lee voices on the user's device.
//
// Cost control:
//   - 60 requests/min/IP via Redis if KV is set up.
//   - Text payload capped at 500 chars.
//   - Frontend caches per (voice, text) in IndexedDB so each word is
//     fetched once for the entire game.

import { Redis } from '@upstash/redis';

const RATE_KEY_PREFIX = 'spelling-bee:tts-rate:';
const RATE_LIMIT      = 60;
const MAX_TEXT_LEN    = 500;
const GEMINI_MODEL    = 'gemini-3.1-flash-tts-preview';   // 3.1 preview: best audio quality
const DEFAULT_VOICE   = 'Leda';   // soft, paired with en-AU prompt
const DEFAULT_LANG    = 'en-AU';

function getRedis() {
  const url   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Gemini returns signed-16-bit LE PCM mono. Wrap it in a WAV container so
// the browser's <audio> element / new Audio(url).play() can decode it.
function pcmToWav(pcmBuf, sampleRate = 24000) {
  const numChannels   = 1;
  const bitsPerSample = 16;
  const byteRate      = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign    = numChannels * bitsPerSample / 8;
  const dataSize      = pcmBuf.length;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);            // PCM format
  wav.writeUInt16LE(numChannels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  pcmBuf.copy(wav, 44);
  return wav;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'TTS not configured',
      hint: 'Set GEMINI_API_KEY in Vercel → Settings → Environment Variables. Get a free key at https://aistudio.google.com'
    });
  }

  // Rate limit per IP (best-effort — fails open if Redis is down)
  const redis = getRedis();
  if (redis) {
    try {
      const ip = clientIp(req);
      const rateKey = RATE_KEY_PREFIX + ip;
      const count = await redis.incr(rateKey);
      if (count === 1) await redis.expire(rateKey, 60);
      if (count > RATE_LIMIT) {
        return res.status(429).json({ error: 'Rate limit hit. Try again in a minute.' });
      }
    } catch (e) { /* don't block on rate limiter failure */ }
  }

  const text = (req.body?.text || '').toString().trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (text.length > MAX_TEXT_LEN) {
    return res.status(400).json({ error: `text too long (max ${MAX_TEXT_LEN})` });
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const gRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: DEFAULT_VOICE }
            },
            languageCode: DEFAULT_LANG
          }
        }
      })
    });

    if (!gRes.ok) {
      const errBody = await gRes.text().catch(() => '');
      console.error('[tts] Gemini', gRes.status, errBody.slice(0, 400));
      return res.status(502).json({
        error: `Gemini ${gRes.status}`,
        detail: errBody.slice(0, 300)
      });
    }

    const data = await gRes.json();
    const part = data?.candidates?.[0]?.content?.parts?.[0];
    const inline = part?.inlineData;
    if (!inline?.data) {
      return res.status(502).json({ error: 'No audio in Gemini response' });
    }

    const pcm = Buffer.from(inline.data, 'base64');
    const sampleRateMatch = (inline.mimeType || '').match(/rate=(\d+)/);
    const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 24000;
    const wav = pcmToWav(pcm, sampleRate);

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', wav.length.toString());
    return res.status(200).send(wav);
  } catch (e) {
    console.error('[tts] handler error', e);
    return res.status(500).json({ error: e.message || 'TTS failure' });
  }
}
