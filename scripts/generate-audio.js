#!/usr/bin/env node
//
// Download fresh Gemini TTS audio for every word in the Junior + Senior
// spelling lists (junior_wordlist.txt + senior_wordlist.txt) and save them as
// static .wav files in public/audio/. The frontend serves them from Vercel's
// CDN — zero Gemini API calls in production.
//
// Usage:
//   1. Put your key in .env.local at the project root:
//        GEMINI_API_KEY=AIza...
//   2. node scripts/generate-audio.js          (or: npm run generate-audio)
//   3. git add public/audio && git commit && git push
//
// Resumable: skips files that already exist on re-run.
// Paced: 7s between requests to stay under the 10 RPM preview limit.
// Daily cap: stops after MAX_PER_RUN to stay under the 100 RPD preview cap.
// On 429: backs off 60s and retries the same item.
//
// Output:
//   public/audio/<sha1("gemini_achernar::word.")>.wav   — one per unique word
//   public/audio/index.json                              — hashes that exist on
//                                                           disk (frontend uses
//                                                           it to skip 404s)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// --- Load .env.local manually (no dotenv dependency) ---
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
  console.error('GEMINI_API_KEY not set. Create .env.local at the project root with:');
  console.error('  GEMINI_API_KEY=AIza...');
  process.exit(1);
}

// Config — MUST match the frontend (hashTextKey + wordTextFor) and /api/tts.
const GEMINI_MODEL = 'gemini-2.5-flash-preview-tts';   // swap back to 3.1 when it's GA
const VOICE_NAME   = 'Achernar';         // Gemini voice
const LANG_CODE    = 'en-AU';
const VOICE_ID     = 'gemini_achernar';  // matches state.aiVoiceId in the frontend
const OUT_DIR      = path.join('public', 'audio');

// Gemini 3.1 Flash TTS Preview limits: 10 RPM, 100 RPD. Pace ~7s (≈8.5 RPM) and
// stop ~5 under the daily cap each run; ~2,100 words spread over ~22 days.
const PACE_MS              = parseInt(process.env.PACE_MS || '7000', 10);
const RATE_BACKOFF_MS      = 60000;
const MAX_429_PER_TASK     = 2;
const MAX_CONSECUTIVE_FAILS = 5;
const MAX_PER_RUN          = parseInt(process.env.MAX_PER_RUN || '95', 10);

// SHA-1(voiceId::text) — must match hashTextKey() in index.html.
const hashKey = (voiceId, text) => createHash('sha1').update(`${voiceId}::${text}`).digest('hex');

// Collect words from a "LEVEL N" + one-word-per-line list file.
function parseWords(file) {
  const words = [];
  let inLevel = false;
  for (const line0 of readFileSync(file, 'utf-8').split('\n')) {
    const line = line0.trim();
    if (!line || /^=+$/.test(line) || /^alphabetical wordlist$/i.test(line)) continue;
    if (/^LEVEL\s+\d+/i.test(line)) { inLevel = true; continue; }
    if (inLevel && !/\s/.test(line)) words.push(line);
  }
  return words;
}

const allWords = new Set([
  ...parseWords('junior_wordlist.txt'),
  ...parseWords('senior_wordlist.txt'),
]);

// "Say the word" audio = the word followed by a period (matches wordTextFor()).
const tasks = [];
const seen = new Set();
function add(text, label) {
  const h = hashKey(VOICE_ID, text);
  if (seen.has(h)) return;
  seen.add(h);
  tasks.push({ hash: h, text, label });
}
// Sentences for the "In a sentence" feature live in sentences.txt as
// "word|sentence". Generate the judge-format clip only for words that have one.
const sentences = {};
try {
  for (const line of readFileSync('sentences.txt', 'utf-8').split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('|');
    if (i > 0) sentences[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
} catch (e) { /* no sentences.txt yet */ }

for (const w of allWords) add(`${w}.`, w);                          // every "Say the word" clip first
for (const w of allWords)                                           // then the "In a sentence" clips
  if (sentences[w]) add(`${w}. ${sentences[w]}. ${w}.`, `${w} (sentence)`);
add("G'day! I'll say words for you to spell.", 'welcome phrase');

console.log(`${tasks.length} unique audio files (${allWords.size} words + 1 phrase).`);
await mkdir(OUT_DIR, { recursive: true });

// --- WAV header wrap (Gemini returns raw 16-bit PCM) ---
function pcmToWav(pcmBuf, sampleRate = 24000) {
  const numChannels = 1, bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcmBuf.length;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataSize, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(numChannels, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28); wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34); wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40); pcmBuf.copy(wav, 44);
  return wav;
}

async function fetchGemini(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
  return fetch(url, {
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
}

// --- Main loop (resumable, paced, daily-cap aware) ---
let generated = 0, skipped = 0, failed = 0, consecutiveFails = 0, bailedEarly = false;

for (let n = 0; n < tasks.length; n++) {
  const task = tasks[n];
  const outPath = path.join(OUT_DIR, `${task.hash}.wav`);
  const prefix = `[${n + 1}/${tasks.length}]`;

  if (existsSync(outPath)) { skipped++; continue; }

  if (generated >= MAX_PER_RUN) {
    console.log(`\nReached MAX_PER_RUN (${MAX_PER_RUN}). Stopping to stay under the 100/day quota.`);
    console.log('Re-run tomorrow (quota resets ~midnight Pacific) to continue where it stopped.');
    bailedEarly = true;
    break;
  }

  let succeeded = false;
  for (let attempt = 1; attempt <= MAX_429_PER_TASK + 1; attempt++) {
    process.stdout.write(`${prefix} ${task.label} → ${task.hash.slice(0, 8)}.wav ... `);
    try {
      const res = await fetchGemini(task.text);
      if (res.status === 429) {
        if (attempt > MAX_429_PER_TASK) { console.log('429 (gave up)'); failed++; consecutiveFails++; break; }
        console.log(`429 (cooling ${RATE_BACKOFF_MS / 1000}s, retry ${attempt}/${MAX_429_PER_TASK})`);
        await new Promise(r => setTimeout(r, RATE_BACKOFF_MS));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.log(`FAIL ${res.status}`); console.error('   ', body.slice(0, 300));
        failed++; consecutiveFails++; break;
      }
      const data = await res.json();
      const inline = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!inline?.data) { console.log('FAIL (no audio)'); failed++; consecutiveFails++; break; }
      const pcm = Buffer.from(inline.data, 'base64');
      const m = (inline.mimeType || '').match(/rate=(\d+)/);
      const wav = pcmToWav(pcm, m ? parseInt(m[1], 10) : 24000);
      await writeFile(outPath, wav);
      console.log(`ok (${(wav.length / 1024).toFixed(0)} KB)`);
      generated++; consecutiveFails = 0; succeeded = true; break;
    } catch (e) {
      console.log(`error: ${e.message}`); failed++; consecutiveFails++; break;
    }
  }

  if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
    bailedEarly = true;
    console.log(`\nStopping early: ${MAX_CONSECUTIVE_FAILS} consecutive failures (quota exhausted or API down).`);
    console.log('Wait for quota reset (or raise the cap in Google Cloud → Billing), then re-run.');
    break;
  }

  if (succeeded && n < tasks.length - 1) await new Promise(r => setTimeout(r, PACE_MS));
}

// index.json lists only files that exist on disk, so the frontend tries the CDN
// only for words we actually have and goes straight to /api/tts for the rest.
const onDisk = tasks.filter(t => existsSync(path.join(OUT_DIR, `${t.hash}.wav`))).map(t => t.hash);
await writeFile(path.join(OUT_DIR, 'index.json'), JSON.stringify(onDisk));

console.log(`\nRun summary: generated=${generated} skipped=${skipped} failed=${failed}`);
console.log(`On disk now: ${onDisk.length}/${tasks.length}. Output: ${OUT_DIR}/`);
if (!bailedEarly && failed === 0 && onDisk.length === tasks.length) {
  console.log('\nAll audio generated. Next:\n  git add public/audio/\n  git commit -m "Pre-generated audio"\n  git push');
} else {
  console.log('\nRe-run "npm run generate-audio" later to continue where it stopped.');
}
