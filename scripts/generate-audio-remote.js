#!/usr/bin/env node
//
// Generates the spelling-bee audio by calling the DEPLOYED /api/tts endpoint
// instead of Gemini directly — so it needs NO local API key. This is what the
// Claude Code cloud routine runs: the cloud sandbox gets a fresh git checkout
// with no secrets, and the Gemini key lives server-side in Vercel.
//
// Usage:
//   node scripts/generate-audio-remote.js
//   MAX_PER_RUN=95 PACE_MS=7000 node scripts/generate-audio-remote.js
//   TTS_API=https://other.example/api/tts node scripts/generate-audio-remote.js
//
// Resumable: skips clips already in public/audio/. Paced ~7s for Gemini's 10 RPM
// limit, and stops at MAX_PER_RUN to stay under the ~100/day cap.
// Keyword-words (tone, style, stage…) are handled server-side by /api/tts, which
// retries them with a framed "The word is X." prompt.

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const TTS_API     = process.env.TTS_API || 'https://spelling-game-henna.vercel.app/api/tts';
const VOICE_ID    = 'gemini_leda';   // must match state.aiVoiceId in index.html
const OUT_DIR     = path.join('public', 'audio');
const PACE_MS     = parseInt(process.env.PACE_MS || '7000', 10);
const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN || '95', 10);
const MAX_CONSECUTIVE_FAILS = 8;

const hashKey = (voiceId, text) => createHash('sha1').update(`${voiceId}::${text}`).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// "word|sentence" lines power the "In a sentence" clips.
const sentences = {};
try {
  for (const line of readFileSync('sentences.txt', 'utf-8').split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('|');
    if (i > 0) sentences[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
} catch (e) { /* no sentences.txt yet */ }

const tasks = [];
const seen = new Set();
function add(text, label) {
  const h = hashKey(VOICE_ID, text);
  if (seen.has(h)) return;
  seen.add(h);
  tasks.push({ hash: h, text, label });
}
for (const w of allWords) add(`${w}.`, w);                              // "say the word" first
for (const w of allWords)                                               // then "in a sentence"
  if (sentences[w]) add(`${w}. ${sentences[w]}. ${w}.`, `${w} (sentence)`);
add("G'day! I'll say words for you to spell.", 'welcome phrase');

console.log(`${tasks.length} unique clips. API: ${TTS_API}`);
await mkdir(OUT_DIR, { recursive: true });

let generated = 0, skipped = 0, failed = 0, consecutiveFails = 0;

for (let n = 0; n < tasks.length; n++) {
  const task = tasks[n];
  const outPath = path.join(OUT_DIR, `${task.hash}.wav`);

  if (existsSync(outPath)) { skipped++; continue; }
  if (generated >= MAX_PER_RUN) {
    console.log(`\nReached MAX_PER_RUN (${MAX_PER_RUN}) — stopping to stay under the daily cap.`);
    break;
  }

  process.stdout.write(`[${n + 1}/${tasks.length}] ${task.label} → ${task.hash.slice(0, 8)}.wav ... `);
  try {
    const res = await fetch(TTS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: task.text })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.log(`FAIL ${res.status}`);
      if (body) console.error('    ', body.slice(0, 200));
      failed++; consecutiveFails++;
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) {
        console.log(`FAIL (suspiciously small: ${buf.length} bytes)`);
        failed++; consecutiveFails++;
      } else {
        await writeFile(outPath, buf);
        console.log(`ok (${(buf.length / 1024).toFixed(0)} KB)`);
        generated++; consecutiveFails = 0;
      }
    }
  } catch (e) {
    console.log(`error: ${e.message}`);
    failed++; consecutiveFails++;
  }

  if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
    console.log(`\nStopping: ${MAX_CONSECUTIVE_FAILS} consecutive failures (daily quota likely exhausted).`);
    break;
  }

  if (n < tasks.length - 1) await sleep(PACE_MS);
}

// index.json lists what's actually on disk so the frontend only asks the CDN for
// clips we really have.
const onDisk = tasks.filter(t => existsSync(path.join(OUT_DIR, `${t.hash}.wav`))).map(t => t.hash);
await writeFile(path.join(OUT_DIR, 'index.json'), JSON.stringify(onDisk));

console.log(`\nSummary: generated=${generated} skipped=${skipped} failed=${failed}`);
console.log(`On disk: ${onDisk.length}/${tasks.length}`);
