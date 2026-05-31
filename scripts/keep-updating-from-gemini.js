#!/usr/bin/env node
//
// Long-running audio generator. Run it once, leave it. It will:
//   1. Generate up to 95 audios per cycle (under Gemini 3.1 Flash TTS's
//      100 RPD daily cap)
//   2. When the cap is hit (or 95 is reached), sleep until just after the
//      next Pacific midnight (Gemini's daily reset)
//   3. Wake up, generate the next batch, repeat
//   4. Exit cleanly when all 828 audios are generated
//
// Usage:
//   node scripts/keep-updating-from-gemini.js
//
//   # or with auto commit+push between cycles so you can fully fire-and-forget:
//   AUTO_GIT=true node scripts/keep-updating-from-gemini.js
//
// Stop with Ctrl-C any time. Resumable — already-generated files are kept.
//
// Expected duration: 828 / 95 ≈ 9 cycles ≈ 8-9 days running in the
// background. Leave your laptop awake (or use `caffeinate -d node ...`
// on macOS to keep it from sleeping).

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

// ---------- Config ----------
const GEMINI_MODEL  = 'gemini-3.1-flash-tts-preview';
const VOICE_NAME    = 'Achernar';
const LANG_CODE     = 'en-AU';
const VOICE_ID      = 'gemini_achernar';
const OUT_DIR       = path.join('public', 'audio');

const PACE_MS               = parseInt(process.env.PACE_MS || '7000', 10);    // 7s = ~8.5 RPM, safely under 10 RPM
const MAX_PER_CYCLE         = parseInt(process.env.MAX_PER_CYCLE || '95', 10); // stop 5 under 100 RPD
const RATE_BACKOFF_MS       = 60_000;
const MAX_429_PER_TASK      = 2;
const MAX_ERRORS_PER_CYCLE  = 5;
const PACIFIC_BUFFER_MIN    = 5;     // wait this long past Pacific midnight before retrying
const AUTO_GIT              = process.env.AUTO_GIT === 'true';

const wordTextFor    = w => `${w.word}.`;
const sentenceFormFor = w => `${w.word}. ${w.sentence}. ${w.word}.`;

function hashKey(voiceId, text) {
  return createHash('sha1').update(`${voiceId}::${text}`).digest('hex');
}

// ---------- Extract MASTER_WORDS from index.html ----------
function extractObjectLiteral(text, varName) {
  const start = text.indexOf(`const ${varName} = `);
  if (start < 0) throw new Error(`Could not find ${varName}`);
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
const MASTER_WORDS = new Function('return ' + extractObjectLiteral(html, 'MASTER_WORDS'))();

// ---------- Build task list ----------
const tasks = [];
const seen = new Set();
function addTask(text, label) {
  const h = hashKey(VOICE_ID, text);
  if (seen.has(h)) return;
  seen.add(h);
  tasks.push({ hash: h, text, label });
}
for (const age of Object.keys(MASTER_WORDS)) {
  for (const w of MASTER_WORDS[age]) {
    addTask(wordTextFor(w), w.word);
    if (w.sentence) addTask(sentenceFormFor(w), `${w.word} (sentence)`);   // no sentence audio for sentence-less words
  }
}
addTask("G'day! I'll say words for you to spell.", 'test phrase');

await mkdir(OUT_DIR, { recursive: true });

// ---------- Helpers ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pcmToWav(pcmBuf, sampleRate) {
  const numChannels = 1, bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcmBuf.length;
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
      const sr = m ? parseInt(m[1], 10) : 24000;
      const wav = pcmToWav(pcm, sr);
      await writeFile(outPath, wav);
      return 'ok';
    } catch (e) {
      console.error(`     network error: ${e.message}`);
      return 'error';
    }
  }
  return 'error';
}

// Milliseconds from now until next Pacific midnight + buffer
function msUntilNextPacificMidnight() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const parts = fmt.formatToParts(new Date());
  const get = type => parseInt(parts.find(p => p.type === type).value, 10);
  const h = get('hour'), m = get('minute'), s = get('second');
  const secondsSincePacificMidnight = h * 3600 + m * 60 + s;
  const secondsUntilNextMidnight = (24 * 3600) - secondsSincePacificMidnight;
  return (secondsUntilNextMidnight + PACIFIC_BUFFER_MIN * 60) * 1000;
}

function fmtDuration(ms) {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function gitCommitAndPush(message) {
  try {
    execSync('git add public/audio/', { stdio: 'pipe' });
    const status = execSync('git status --porcelain', { stdio: 'pipe' }).toString();
    if (!status.trim()) {
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
function todoTasks() {
  return tasks.filter(t => !existsSync(path.join(OUT_DIR, `${t.hash}.wav`)));
}

console.log('keep-updating-from-gemini');
console.log(`  Voice: ${VOICE_NAME} (${VOICE_ID})`);
console.log(`  Output: ${OUT_DIR}/`);
console.log(`  Pace: ${PACE_MS}ms between requests, ${MAX_PER_CYCLE} per cycle`);
console.log(`  Auto-git: ${AUTO_GIT ? 'yes' : 'no'}`);
console.log(`  Total tasks: ${tasks.length}`);
console.log();

// Always refresh index.json on startup so the frontend has the latest set
await writeFile(path.join(OUT_DIR, 'index.json'), JSON.stringify(tasks.map(t => t.hash)));

let cycle = 0;
while (true) {
  cycle++;
  const todo = todoTasks();
  console.log(`\n=== Cycle ${cycle} — ${new Date().toLocaleString()} ===`);
  console.log(`${todo.length} tasks remaining (${tasks.length - todo.length}/${tasks.length} done).`);

  if (todo.length === 0) {
    console.log('All audio generated. Exiting.');
    if (AUTO_GIT) {
      console.log('Final commit:');
      gitCommitAndPush('Pre-generated audio: complete');
    }
    break;
  }

  let generated = 0, errors = 0, hitCap = false;
  for (const task of todo) {
    if (generated >= MAX_PER_CYCLE) {
      console.log(`  Reached MAX_PER_CYCLE (${MAX_PER_CYCLE}). Stopping cycle.`);
      hitCap = true;
      break;
    }
    process.stdout.write(`  [${(generated + 1).toString().padStart(3)}] ${task.label} → ${task.hash.slice(0, 8)}.wav ... `);
    const result = await generateOne(task);
    if (result === 'ok') {
      generated++;
      console.log('ok');
    } else if (result === 'capped') {
      console.log('capped (daily limit)');
      hitCap = true;
      break;
    } else {
      errors++;
      console.log('error');
      if (errors >= MAX_ERRORS_PER_CYCLE) {
        console.log(`  ${MAX_ERRORS_PER_CYCLE} errors — stopping cycle.`);
        break;
      }
    }
    await sleep(PACE_MS);
  }

  console.log(`\nCycle ${cycle} complete: generated=${generated} errors=${errors}`);

  // Refresh index.json (full hash list — frontend uses this to decide whether
  // to try /audio/<hash>.wav or fall back to /api/tts)
  await writeFile(path.join(OUT_DIR, 'index.json'), JSON.stringify(tasks.map(t => t.hash)));

  if (AUTO_GIT && generated > 0) {
    console.log('Committing cycle output:');
    const left = tasks.length - todoTasks().length;
    gitCommitAndPush(`Pre-generated audio: ${left}/${tasks.length} (auto cycle ${cycle})`);
  }

  if (todoTasks().length === 0) {
    console.log('🎉 All audio generated.');
    break;
  }

  const sleepMs = msUntilNextPacificMidnight();
  const wakeAt = new Date(Date.now() + sleepMs);
  console.log(`Sleeping ${fmtDuration(sleepMs)} until ${wakeAt.toLocaleString()} (next Pacific midnight + ${PACIFIC_BUFFER_MIN}min).`);
  if (!AUTO_GIT) {
    console.log('You can commit + push the new audio now if you want — script will keep its place.');
  }
  await sleep(sleepMs);
}

console.log('\nDone.');
