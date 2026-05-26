#!/usr/bin/env node
//
// Pre-generate Gemini TTS audio for every word + sentence in MASTER_WORDS
// and save them as static .wav files in public/audio/. The frontend then
// fetches them directly from Vercel's CDN — zero Gemini API calls in
// production.
//
// Usage:
//   1. Put your key in .env.local at the project root:
//        GEMINI_API_KEY=AIza...
//   2. node scripts/generate-audio.js
//   3. git add public/audio && git commit && git push
//
// Resumable: skips files that already exist on re-run.
// Paced: 300ms between requests so we stay well under per-minute quotas.
// On 429: sleeps 60s and retries the same item.
//
// Output:
//   public/audio/<sha1(voiceId::text)>.wav    — one per unique audio file
//   public/audio/index.json                    — array of all hashes (frontend
//                                                uses this to skip 404 lookups)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// --- Load .env.local manually (no dependency on dotenv) ---
try {
  const env = readFileSync('.env.local', 'utf-8');
  for (const line of env.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (k && !process.env[k]) process.env[k] = v;
  }
} catch (e) { /* no .env.local — fall back to real env */ }

const GEMINI_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_KEY) {
  console.error('GEMINI_API_KEY not set.');
  console.error('Create .env.local at the project root with:');
  console.error('  GEMINI_API_KEY=AIza...');
  process.exit(1);
}

// Config — must match what the frontend sends to /api/tts and what
// /api/tts.js sends to Gemini.
const GEMINI_MODEL  = 'gemini-3.1-flash-tts-preview';
const VOICE_NAME    = 'Achernar';        // Gemini voice
const LANG_CODE     = 'en-AU';
const VOICE_ID      = 'gemini_achernar'; // matches state.aiVoiceId in the frontend
const OUT_DIR       = path.join('public', 'audio');
const REQUEST_PACE_MS = 300;             // delay between successful requests
const RATE_LIMIT_BACKOFF_MS = 60000;

// These two functions must match wordTextFor() and sentenceFormFor() in index.html.
const wordTextFor    = w => `${w.word}.`;
const sentenceFormFor = w => `${w.word}. ${w.sentence}. ${w.word}.`;

// SHA-1(voiceId::text) — must match hashTextKey() in the frontend.
function hashKey(voiceId, text) {
  return createHash('sha1').update(`${voiceId}::${text}`).digest('hex');
}

// --- Extract MASTER_WORDS literal from index.html via brace-balancing ---
function extractObjectLiteral(text, varName) {
  const startMarker = `const ${varName} = `;
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error(`Could not find "${startMarker}" in index.html`);
  const open = text.indexOf('{', start);
  let depth = 1, i = open + 1, inString = null;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i += 2; continue; }
      if (c === inString) inString = null;
    } else {
      if (c === '"' || c === "'" || c === '`') inString = c;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    i++;
  }
  return text.slice(open, i + 1);
}

const html = await readFile('index.html', 'utf-8');
const literal = extractObjectLiteral(html, 'MASTER_WORDS');
// Safe-ish eval: the input is our own source code, and Function() is
// scoped — it can't reach the surrounding closure.
const MASTER_WORDS = new Function('return ' + literal)();

// --- Build the list of unique audio tasks ---
const tasks = [];
const seen = new Set();
function add(text, label) {
  const h = hashKey(VOICE_ID, text);
  if (seen.has(h)) return;
  seen.add(h);
  tasks.push({ hash: h, text, label });
}
for (const age of Object.keys(MASTER_WORDS)) {
  for (const w of MASTER_WORDS[age]) {
    add(wordTextFor(w),     `${w.word}`);
    add(sentenceFormFor(w), `${w.word} (sentence)`);
  }
}
// Also pre-generate the welcome test phrase
add("G'day! I'll say words for you to spell.", 'test phrase');

console.log(`${tasks.length} unique audio files to generate.`);

await mkdir(OUT_DIR, { recursive: true });

// --- WAV header wrap (Gemini returns raw PCM) ---
function pcmToWav(pcmBuf, sampleRate = 24000) {
  const numChannels = 1, bitsPerSample = 16;
  const byteRate    = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign  = numChannels * bitsPerSample / 8;
  const dataSize    = pcmBuf.length;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
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

async function fetchGemini(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } },
          languageCode: LANG_CODE
        }
      }
    })
  });
  return res;
}

// --- Main loop ---
let generated = 0, skipped = 0, failed = 0;
for (let n = 0; n < tasks.length; n++) {
  const task = tasks[n];
  const outPath = path.join(OUT_DIR, `${task.hash}.wav`);
  const prefix = `[${n + 1}/${tasks.length}]`;

  if (existsSync(outPath)) {
    skipped++;
    // Don't spam the log for skipped files
    if (skipped <= 3 || n === tasks.length - 1) console.log(`${prefix} ${task.label}: skip (already exists)`);
    continue;
  }

  let attempt = 0;
  while (true) {
    attempt++;
    process.stdout.write(`${prefix} ${task.label} → ${task.hash.slice(0, 8)}.wav ... `);
    try {
      const res = await fetchGemini(task.text);
      if (res.status === 429) {
        console.log('429 (cooling 60s)');
        await new Promise(r => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.log(`FAIL ${res.status}`);
        console.error('   ', body.slice(0, 300));
        failed++;
        break;
      }
      const data = await res.json();
      const inline = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!inline?.data) {
        console.log('FAIL (no audio in response)');
        failed++;
        break;
      }
      const pcm = Buffer.from(inline.data, 'base64');
      const m = (inline.mimeType || '').match(/rate=(\d+)/);
      const sr = m ? parseInt(m[1], 10) : 24000;
      const wav = pcmToWav(pcm, sr);
      await writeFile(outPath, wav);
      console.log(`ok (${(wav.length / 1024).toFixed(0)} KB)`);
      generated++;
      break;
    } catch (e) {
      console.log(`error: ${e.message}`);
      failed++;
      break;
    }
  }

  // Small pacing delay between successful requests
  if (n < tasks.length - 1) {
    await new Promise(r => setTimeout(r, REQUEST_PACE_MS));
  }
}

// --- Write the hash index so the frontend can skip 404 lookups ---
const indexHashes = tasks.map(t => t.hash);
await writeFile(path.join(OUT_DIR, 'index.json'), JSON.stringify(indexHashes));

console.log();
console.log(`Done. generated=${generated} skipped=${skipped} failed=${failed}`);
console.log(`Output: ${OUT_DIR}/ (${tasks.length} hashes in index.json)`);
console.log();
console.log('Next: git add public/audio && git commit -m "Pre-generated audio" && git push');
