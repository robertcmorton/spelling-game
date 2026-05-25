# Spelling Bee

A browser-based spelling-bee game for kids aged 7–16. The game reads a word
aloud and the child types it — same format as a real spelling-bee contest.

Live: **https://spelling-game-henna.vercel.app**

## Play

Open `index.html` in any modern browser, or visit the deployed version.

## Features

- **Multiplayer leaderboard** — enter a name + age on the welcome screen.
  Scores from completed rounds are saved to a shared leaderboard grouped by
  age. Falls back to a per-device leaderboard if the server is offline or
  the KV store isn't configured.
- **Age-based difficulty** — pick an age (7–16) and the word pool adjusts to
  match. Every age has 10 difficulty levels, from *Warm up* to *Master*.
  Hard words at a younger age overlap with easy words at an older age.
- **Spelling-bee format** — tap 🔊 to hear the word, 🐢 for it slower, or
  💬 to hear it used in a sentence.
- **AI voice (optional)** — runs [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
  fully in the browser via ONNX. ~85 MB one-time download, then offline.
  On macOS / iOS / Edge the native Australian voices (Karen, Catherine, Lee)
  are listed at the top of the picker and used if installed.
- **Persistent audio cache** — generated audio is stored in IndexedDB so it
  survives page reloads. A background loop prefetches upcoming words so the
  child never waits.
- **Progress tracking** — per-word right/wrong counts kept in `localStorage`.
  Stats screen shows mastered words and tricky words to practise.
- **Level-up mechanic** — score 8 / 10 in a round to unlock the next level.
  Smart picker biases toward words the child got wrong before.

## Word lists

Master pool of ~470 words tagged by spelling age (5 → 17), sourced from:

- Schonell Graded Word Spelling Test
- Australian curriculum word lists (Years 2 – 11)
- Dolch sight words
- Scripps National Spelling Bee material

## Tech

Single-page HTML game (`index.html`) plus one Vercel Serverless Function
(`api/leaderboard.js`) for the shared leaderboard.

- Vanilla JS, no build step
- Web Speech API for browser TTS, `kokoro-js` lazy-loaded from jsDelivr for AI
- `@upstash/redis` for the leaderboard storage

## Deploying

1. Push to GitHub — Vercel auto-detects `api/` and runs it as Serverless
   Functions, with `index.html` served statically.
2. (One-time, ~2 min) Enable the shared leaderboard:
   - Vercel dashboard → **spelling-game** project → **Storage** tab
   - **Create Database** → choose **KV** (Marketplace → Upstash Redis)
   - **Connect to project** → keep default env-var names
   - Vercel will redeploy automatically; KV_REST_API_URL and KV_REST_API_TOKEN
     are now injected at runtime
3. The frontend gracefully falls back to a local-only leaderboard if KV isn't
   connected, so step 2 is optional but recommended for cross-device sharing.

Free tier is generous (Upstash gives ~10k commands/day) — fine for a family game.

## Made by

Robert C Morton, with Claude.
