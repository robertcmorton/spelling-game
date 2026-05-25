# Spelling Bee

A browser-based spelling-bee game for kids aged 7–16. The game reads a word
aloud and the child types it — same format as a real spelling-bee contest.

Live: **https://spelling-game-henna.vercel.app**

## Play

Open `index.html` in any modern browser, or visit the deployed version.

## Features

- **Achernar AI voice (Australian female)** — high-quality Gemini 3.1 Flash
  TTS Preview, fetched per word and cached locally so repeats are free.
- **Native Aussie fallback** — Karen / Lee on macOS, iOS, and Edge work
  without any setup or network.
- **Multiplayer leaderboard** — name + age on the welcome screen. Scores
  from completed rounds are saved to a shared leaderboard (Vercel KV)
  grouped by age. Falls back to a per-device leaderboard if KV isn't set up
  or the device is offline.
- **Age-based difficulty** — pick an age (7–16) and the word pool adjusts.
  Every age has 10 difficulty levels, from *Warm up* to *Master*. Hard
  words at a younger age overlap with easy words at an older age.
- **Spelling-bee format** — tap 🔊 to hear the word, 🐢 for it slower, or
  💬 to hear it used in a sentence.
- **Persistent audio cache** — generated audio is stored in IndexedDB so it
  survives page reloads. A background loop prefetches upcoming words so the
  child never waits.
- **Progress tracking** — per-word right/wrong counts kept in `localStorage`.
  Stats screen shows mastered words and tricky words to practise.
- **Level-up mechanic** — score 8 / 10 in a round to unlock the next level.

## Word lists

Master pool of ~470 words tagged by spelling age (5 → 17), sourced from:

- Schonell Graded Word Spelling Test
- Australian curriculum word lists (Years 2 – 11)
- Dolch sight words
- Scripps National Spelling Bee material

## Tech

Single-page HTML game (`index.html`) plus two Vercel Serverless Functions:

- `api/tts.js` — proxies Google Gemini 3.1 Flash TTS Preview (Achernar voice, en-AU)
- `api/leaderboard.js` — shared leaderboard backed by Vercel KV / Upstash Redis

Vanilla JS, no build step, Web Speech API for native browser voices.

## Deploying

Push to GitHub → Vercel picks it up automatically. To enable the two server
features:

### 1. Gemini AI voice (~2 min, one-time)

1. Get a free key at [aistudio.google.com](https://aistudio.google.com).
   *If Safari's iCloud Keychain misbehaves with the Google login, use Chrome
   for this step.*
2. In Vercel → spelling-game → **Settings → Environment Variables**, add:
   - **Name**: `GEMINI_API_KEY`
   - **Value**: `<your key>`
   - **Apply to**: Production + Preview + Development
3. Redeploy (next push, or "Redeploy" in the Deployments tab).

Until this is set, `/api/tts` returns 503 and the app uses the device's
native Aussie voice (Karen / Lee on macOS / iOS / Edge).

### 2. Shared leaderboard (~2 min, one-time)

1. Vercel → spelling-game → **Storage** → **Create Database**
2. Choose **KV** (Marketplace → Upstash Redis), free Hobby tier
3. **Connect to project** — Vercel injects `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` automatically.

Until this is set, scores save per-device only.

## Cost

- **Gemini 3.1 Flash TTS Preview**: free tier is generous; beyond it, audio is billed
  per character — pennies for a family-scale game. IndexedDB cache means each
  word is fetched exactly once.
- **Vercel KV (Upstash)**: free Hobby tier covers ~10k commands/day — fine.
- **Vercel hosting**: free Hobby tier.

## Made by

Robert C Morton, with Claude.
