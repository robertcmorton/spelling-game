#!/usr/bin/env node
//
// Fire-and-forget audio generator. Run it once, leave it. It will:
//   1. Generate up to MAX_PER_CYCLE audios per cycle (under the 100 RPD cap)
//   2. When the cap is hit, sleep until just after the next Pacific midnight
//      (Gemini's daily reset)
//   3. Wake, generate the next batch, repeat
//   4. Exit when every word in the Junior + Senior lists has audio
//
// Usage:
//   node scripts/keep-updating-from-gemini.js
//   AUTO_GIT=true node scripts/keep-updating-from-gemini.js   # commit+push each cycle
//
// Stop with Ctrl-C any time. Resumable — already-generated files are kept.
// ~2,100 words / 95 per day ≈ 22 cycles ≈ 3 weeks. Keep the laptop awake
// (e.g. `caffeinate -d node scripts/keep-updating-from-gemini.js` on macOS).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';

// ---------- Load .env.local ----------
try {
  const env = readFileSync('.env.local', 'utf-8');
  for (const line of env.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (k && !process.env[k]) process.env[k] = v;
  }
} catch (e) { /* no .env.local */ }

const GEMINI_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_KEY) {
  console.error('GEMINI_API_KEY not set in .env.local');
  process.exit(1);
}

// ---------- Config (MUST match the frontend + /api/tts) ----------
const GEMINI_MODEL = 'gemini-3.1-flash-tts-preview';
const VOICE_NAME   = 'Achernar';
const LANG_CODE    = 'en-AU';
const VOICE_ID     = 'gemini_achernar';
const OUT_DIR      = path.join('public', 'audio');

const PACE_MS              = parseInt(process.env.PACE_MS || '7000', 10);     // ≈8.5 RPM, under 10 RPM
const MAX_PER_CYCLE        = parseInt(process.env.MAX_PER_CYCLE || '95', 10); // stop 5 under 100 RPD
const RATE_BACKOFF_MS      = 60_000;
const MAX_429_PER_TASK     = 2;
const MAX_ERRORS_PER_CYCLE = 5;
const PACIFIC_BUFFER_MIN   = 5;
const AUTO_GIT             = process.env.AUTO_GIT === 'true';

const hashKey = (voiceId, text) => createHash('sha1').update(`${voiceId}::${text}`).digest('hex');

// ---------- Collect words from the two list files ----------
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

const tasks = [];
const seen = new Set();
function addTask(text, label) {
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

for (const w of allWords) addTask(`${w}.`, w);                      // every "Say the word" clip first
for (const w of allWords)                                           // then the "In a sentence" clips
  if (sentences[w]) addTask(`${w}. ${sentences[w]}. ${w}.`, `${w} (sentence)`);
addTask("G'day! I'll say words for you to spell.", 'welcome phrase');

await mkdir(OUT_DIR, { recursive: true });

// ---------- Helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

function pcmToWav(pcmBuf, sampleRate) {
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
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
    {
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
    }
  );
}

// Returns 'ok' | 'capped' | 'error'
async function generateOne(task) {
  const outPath = path.join(OUT_DIR, `${task.hash}.wav`);
  for (let attempt = 1; attempt <= MAX_429_PER_TASK + 1; attempt++) {
    try {
      const res = await fetchGemini(task.text);
      if (res.status === 429) {
        if (attempt > MAX_429_PER_TASK) return 'capped';
        await sleep(RATE_BACKOFF_MS);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`     ${res.status}: ${body.slice(0, 200)}`);
        return 'error';
      }
      const data = await res.json();
      const inline = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!inline?.data) return 'error';
      const pcm = Buffer.from(inline.data, 'base64');
      const m = (inline.mimeType || '').match(/rate=(\d+)/);
      await writeFile(outPath, pcmToWav(pcm, m ? parseInt(m[1], 10) : 24000));
      return 'ok';
    } catch (e) {
      console.error(`     network error: ${e.message}`);
      return 'error';
    }
  }
  return 'error';
}

function msUntilNextPacificMidnight() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = fmt.formatToParts(new Date());
  const get = type => parseInt(parts.find(p => p.type === type).value, 10);
  const secs = get('hour') * 3600 + get('minute') * 60 + get('second');
  return ((24 * 3600 - secs) + PACIFIC_BUFFER_MIN * 60) * 1000;
}

function fmtDuration(ms) {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function writeIndex() {
  const onDisk = tasks.filter(t => existsSync(path.join(OUT_DIR, `${t.hash}.wav`))).map(t => t.hash);
  return writeFile(path.join(OUT_DIR, 'index.json'), JSON.stringify(onDisk)).then(() => onDisk.length);
}

function gitCommitAndPush(message) {
  try {
    execSync('git add public/audio/', { stdio: 'pipe' });
    if (!execSync('git status --porcelain', { stdio: 'pipe' }).toString().trim()) {
      console.log('  (nothing new to commit)');
      return;
    }
    execSync(`git commit -m ${JSON.stringify(message)}`, { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('  ✓ committed & pushed');
  } catch (e) {
    console.error('  git failed:', e.message);
  }
}

// ---------- Main loop ----------
const todoTasks = () => tasks.filter(t => !existsSync(path.join(OUT_DIR, `${t.hash}.wav`)));

console.log('keep-updating-from-gemini');
console.log(`  Voice: ${VOICE_NAME} (${VOICE_ID})  Output: ${OUT_DIR}/`);
console.log(`  Pace: ${PACE_MS}ms, ${MAX_PER_CYCLE}/cycle  Auto-git: ${AUTO_GIT ? 'yes' : 'no'}`);
console.log(`  Total tasks: ${tasks.length}\n`);
await writeIndex();

let cycle = 0;
while (true) {
  cycle++;
  const todo = todoTasks();
  console.log(`\n=== Cycle ${cycle} — ${new Date().toLocaleString()} ===`);
  console.log(`${todo.length} remaining (${tasks.length - todo.length}/${tasks.length} done).`);

  if (todo.length === 0) {
    console.log('🎉 All audio generated. Exiting.');
    if (AUTO_GIT) gitCommitAndPush('Pre-generated audio: complete');
    break;
  }

  let generated = 0, errors = 0;
  for (const task of todo) {
    if (generated >= MAX_PER_CYCLE) { console.log(`  Reached MAX_PER_CYCLE (${MAX_PER_CYCLE}).`); break; }
    process.stdout.write(`  [${(generated + 1).toString().padStart(3)}] ${task.label} → ${task.hash.slice(0, 8)}.wav ... `);
    const result = await generateOne(task);
    if (result === 'ok') { generated++; console.log('ok'); }
    else if (result === 'capped') { console.log('capped (daily limit)'); break; }
    else {
      errors++; console.log('error');
      if (errors >= MAX_ERRORS_PER_CYCLE) { console.log(`  ${MAX_ERRORS_PER_CYCLE} errors — stopping cycle.`); break; }
    }
    await sleep(PACE_MS);
  }

  const done = await writeIndex();
  console.log(`\nCycle ${cycle}: generated=${generated} errors=${errors} (${done}/${tasks.length} on disk)`);
  if (AUTO_GIT && generated > 0) gitCommitAndPush(`Pre-generated audio: ${done}/${tasks.length} (auto cycle ${cycle})`);

  if (todoTasks().length === 0) { console.log('🎉 All audio generated.'); break; }

  const sleepMs = msUntilNextPacificMidnight();
  console.log(`Sleeping ${fmtDuration(sleepMs)} until ${new Date(Date.now() + sleepMs).toLocaleString()} (next Pacific midnight + ${PACIFIC_BUFFER_MIN}min).`);
  if (!AUTO_GIT) console.log('You can commit + push the new audio now if you like — the script keeps its place.');
  await sleep(sleepMs);
}

console.log('\nDone.');
