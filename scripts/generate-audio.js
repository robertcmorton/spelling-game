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
// Gemini 3.1 Flash TTS Preview rate limits (same across all billing tiers):
//   10 RPM (requests per minute)
//   100 RPD (requests per day)
// Pace at 7s between requests to stay well under 10 RPM. The daily cap (100)
// is hard — once hit, you can't generate more until midnight Pacific. With
// ~828 unique audios total, expect to spread the run over ~8-9 days.
// Override via env vars if you're on a non-preview model with higher limits.
const REQUEST_PACE_MS          = parseInt(process.env.PACE_MS || '7000', 10);
const RATE_LIMIT_BACKOFF_MS    = 60000;
const MAX_429_RETRIES_PER_TASK = 2;
const MAX_CONSECUTIVE_FAILS    = 5;      // bail fast — daily cap is binary, not worth retrying
const MAX_NEW_GENERATIONS_PER_RUN = parseInt(process.env.MAX_PER_RUN || '95', 10);  // stop ~5 under daily cap as safety margin

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
    add(wordTextFor(w), `${w.word}`);
    if (w.sentence) add(sentenceFormFor(w), `${w.word} (sentence)`);   // no sentence audio for sentence-less words
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
let consecutiveFails = 0;
let bailedEarly = false;

for (let n = 0; n < tasks.length; n++) {
  const task = tasks[n];
  const outPath = path.join(OUT_DIR, `${task.hash}.wav`);
  const prefix = `[${n + 1}/${tasks.length}]`;

  if (existsSync(outPath)) {
    skipped++;
    // Only log skips for first few + last
    if (skipped <= 3 || n === tasks.length - 1) console.log(`${prefix} ${task.label}: skip`);
    continue;
  }

  // Voluntary daily cap — stop cleanly before Google's 100 RPD hard cap kicks in.
  if (generated >= MAX_NEW_GENERATIONS_PER_RUN) {
    console.log();
    console.log(`Reached MAX_NEW_GENERATIONS_PER_RUN (${MAX_NEW_GENERATIONS_PER_RUN}). Stopping to stay under the 100/day quota.`);
    console.log(`Re-run tomorrow (quota resets at midnight Pacific / ~5pm AEST) to continue from where we stopped.`);
    bailedEarly = true;
    break;
  }

  let succeeded = false;
  for (let attempt = 1; attempt <= MAX_429_RETRIES_PER_TASK + 1; attempt++) {
    process.stdout.write(`${prefix} ${task.label} → ${task.hash.slice(0, 8)}.wav ... `);
    try {
      const res = await fetchGemini(task.text);
      if (res.status === 429) {
        if (attempt > MAX_429_RETRIES_PER_TASK) {
          console.log(`429 (gave up after ${MAX_429_RETRIES_PER_TASK} retries)`);
          failed++;
          consecutiveFails++;
          break;
        }
        console.log(`429 (cooling ${RATE_LIMIT_BACKOFF_MS / 1000}s, retry ${attempt}/${MAX_429_RETRIES_PER_TASK})`);
        await new Promise(r => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.log(`FAIL ${res.status}`);
        console.error('   ', body.slice(0, 300));
        failed++;
        consecutiveFails++;
        break;
      }
      const data = await res.json();
      const inline = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!inline?.data) {
        console.log('FAIL (no audio in response)');
        failed++;
        consecutiveFails++;
        break;
      }
      const pcm = Buffer.from(inline.data, 'base64');
      const m = (inline.mimeType || '').match(/rate=(\d+)/);
      const sr = m ? parseInt(m[1], 10) : 24000;
      const wav = pcmToWav(pcm, sr);
      await writeFile(outPath, wav);
      console.log(`ok (${(wav.length / 1024).toFixed(0)} KB)`);
      generated++;
      consecutiveFails = 0;
      succeeded = true;
      break;
    } catch (e) {
      console.log(`error: ${e.message}`);
      failed++;
      consecutiveFails++;
      break;
    }
  }

  // Bail out cleanly when something is clearly wrong (quota exhausted, API down)
  if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
    bailedEarly = true;
    console.log();
    console.log(`Stopping early: ${MAX_CONSECUTIVE_FAILS} consecutive failures.`);
    console.log('Likely cause: Gemini quota exhausted (or daily cap hit).');
    console.log('What to do:');
    console.log('  - Wait for quota reset (often Pacific midnight), or');
    console.log('  - Bump the spending cap in Cloud Console → Billing → Budgets, then');
    console.log('  - Re-run "npm run generate-audio" — it picks up where it stopped.');
    break;
  }

  // Small pacing delay between requests
  if (succeeded && n < tasks.length - 1) {
    await new Promise(r => setTimeout(r, REQUEST_PACE_MS));
  }
}

// --- Write/refresh the hash index so the frontend can skip 404 lookups ---
// Include ALL hashes (planned + already-existing), so the frontend knows to
// try every static URL. Hashes whose files don't exist yet will 404 and the
// frontend will fall back to /api/tts.
const indexHashes = tasks.map(t => t.hash);
await writeFile(path.join(OUT_DIR, 'index.json'), JSON.stringify(indexHashes));

console.log();
console.log(`Run summary: generated=${generated} skipped=${skipped} failed=${failed}`);
console.log(`Output: ${OUT_DIR}/`);
if (!bailedEarly && failed === 0) {
  console.log();
  console.log('All audio generated. Next:');
  console.log('  git add public/audio/');
  console.log('  git commit -m "Pre-generated audio"');
  console.log('  git push');
} else if (failed > 0) {
  console.log();
  console.log(`${failed} tasks failed this run. Re-run "npm run generate-audio" later to retry.`);
}
