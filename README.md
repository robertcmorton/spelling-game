# Spelling Bee

A browser-based spelling-bee game for kids, with two modes — **Junior** and
**Senior**. The game reads a word aloud and the child types it, same format as
a real spelling-bee contest.

Live: **https://spelling-game-henna.vercel.app**

## Play

Open `index.html` in any modern browser, or visit the deployed version.
Enter your name, pick **🐝 Junior** or **🎓 Senior**, and spell.

## How it works

- **Two modes, five levels each.** Junior and Senior each have levels 1–5
  (*Warm-up → Easy → Steady → Tricky → Champion*). Levels unlock as you go.
- **10 words per level.** Score **9 / 10** (90%) to unlock the next level.
- **Hear the word.** Tap 🔊 to hear it (Australian voice). Type it, check it.
- **Per-mode progress.** Junior and Senior track their own unlocked levels.
- **Leaderboard.** Name on the welcome screen; completed rounds post to a
  shared leaderboard (Vercel KV) with separate **Junior** and **Senior**
  boards. Falls back to per-device scores if KV isn't set up or you're offline.
- **Progress tracking.** Per-word right/wrong counts in `localStorage`; the
  stats screen shows mastered and tricky words.

## Voice

- **Achernar AI voice (Australian female)** — Google Gemini Flash TTS, fetched
  per word and cached in IndexedDB so repeats are free. Audio for the whole
  word list is pre-generated and served as static files (see below), so the
  deployed game costs **$0 ongoing** in Gemini fees.
- **Native fallback** — if `/api/tts` is unavailable, the app uses the
  device's built-in Australian voice (Karen / Lee on macOS, iOS, Edge), so
  the child never gets silence.

## Word lists

~2,101 words from the **NSW Premier's Spelling Bee**, in two plain-text files
at the repo root:

- `junior_wordlist.txt` — levels 1–5 (→ Junior levels 1–5)
- `senior_wordlist.txt` — levels 2–6 (→ Senior levels 1–5, renumbered so
  there's no gap)

These are single words with no example sentence, so the game presents the word
by audio only. To change the words, edit the `.txt` files **and** the
`WORD_LISTS` literal in `index.html` (they must agree), then re-generate audio.

## Tech

Single-page vanilla-JS game (`index.html`, no build step) plus two Vercel
serverless functions:

- `api/tts.js` — proxies Gemini Flash TTS (Achernar, en-AU). Used only as a
  fallback for any word not in the pre-generated static set.
- `api/leaderboard.js` — shared leaderboard backed by Vercel KV / Upstash
  Redis, keyed by mode (`junior` / `senior`).

Static audio for every word lives at `public/audio/<sha1("gemini_achernar::word.")>.wav`.
The frontend tries the static file first and only calls `/api/tts` for misses.

## Deploying

Push to GitHub → Vercel deploys automatically. To enable the two server
features:

### 1. Gemini AI voice (~2 min, one-time)

1. Get a key at [aistudio.google.com](https://aistudio.google.com).
2. In Vercel → spelling-game → **Settings → Environment Variables**, add
   `GEMINI_API_KEY = <your key>` (Production + Preview + Development).
3. Redeploy.

Until this is set, `/api/tts` returns 503 and the app uses the device's native
voice.

### 2. Shared leaderboard (~2 min, one-time)

1. Vercel → spelling-game → **Storage → Create Database**
2. Choose **KV** (Marketplace → Upstash Redis), free Hobby tier
3. **Connect to project** — Vercel injects `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` automatically.

Until this is set, scores save per-device only.

## Pre-generating audio

Pre-generating audio for every word and committing the `.wav` files lets
Vercel's CDN serve them — no Gemini calls at runtime.

```bash
# 1. Clone (Node 18+), then add your Gemini key:
cp .env.local.example .env.local
#    edit .env.local — paste your key from https://aistudio.google.com

# 2. Generate (resumable, paced ~7s/request):
npm run generate-audio

# 3. Commit + push the audio:
git add public/audio/ && git commit -m "Pre-generated audio" && git push
```

This downloads one short clip per word (~2,101 total) into `public/audio/` and
writes `public/audio/index.json` (the list of hashes the frontend looks up).

The Gemini **3.1 Flash TTS Preview** model is capped at **10 requests/minute and
100/day**, so a full run takes **~22 days**. The script is resumable (it skips
files that already exist) and stops ~5 short of the daily cap each run. For an
unattended multi-day run that sleeps until the next quota reset:

```bash
AUTO_GIT=true node scripts/keep-updating-from-gemini.js
```

Both scripts read the words from `junior_wordlist.txt` + `senior_wordlist.txt`,
so after editing those, just re-run — only the new words are generated.

## Cost

- **Gemini Flash TTS**: free tier is generous; pre-generated audio + IndexedDB
  cache mean each word is fetched at most once.
- **Vercel KV (Upstash)** and **Vercel hosting**: free Hobby tiers.

## Made by

Robert C Morton, with Claude.
