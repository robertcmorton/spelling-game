#!/usr/bin/env bash
#
# Download the Spelling Bee audio from Google Gemini (Achernar voice, en-AU).
# Run it and leave it. Gemini 2.5 Flash TTS has no daily cap, so it does the whole
# set in one sitting — but the preview model is rate-limited to ~10 requests/min,
# so ~4,200 clips takes several hours. Best run overnight. It commits + pushes each
# batch as it goes and resumes where it left off if interrupted (Ctrl-C safe).
#
# It downloads every "Say the word" clip first, then the "In a sentence" clips
# for words that have a sentence (see sentences.txt).
#
# Usage:
#   bash download-audio.sh           # generate + commit + push each batch (live site updates)
#   bash download-audio.sh --local   # generate + commit locally only (no push / no deploy)
#
# Resumable: press Ctrl-C any time; re-run and it skips clips it already has.
# Keeps your Mac awake while running (caffeinate) — leave it plugged in.
#
set -e
cd "$(dirname "$0")"

if [ ! -f .env.local ]; then
  echo "Error: .env.local with GEMINI_API_KEY not found (copy .env.local.example)." >&2
  exit 1
fi

export AUTO_GIT=true
[ "$1" = "--local" ] && export AUTO_GIT=false

# No daily cap, but ~10 RPM on the preview model — pace at 7s to avoid empty
# responses / 429s. Big cycles are fine (no per-day limit); each cycle is pushed.
export MAX_PER_CYCLE=300
export PACE_MS=7000

echo "Downloading Spelling Bee audio (push each batch: $AUTO_GIT)."
echo "Ctrl-C to stop any time — it's safe to re-run and resumes where it left off."
exec caffeinate -i node scripts/keep-updating-from-gemini.js
