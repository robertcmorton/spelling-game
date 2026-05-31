#!/usr/bin/env bash
#
# Download the Spelling Bee audio from Google Gemini (Achernar voice, en-AU).
# Run it and leave it. Uses Gemini 3.1 Flash TTS (Leda). The preview model is
# capped at ~10 requests/min AND ~100 requests/day, so it does a daily batch
# (~95 clips), then sleeps until the quota resets (~next midnight Pacific) and
# continues. All ~4,200 clips take a few weeks of these daily batches. It commits +
# pushes each batch and resumes where it left off if interrupted (Ctrl-C safe).
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

# 3.1 Flash TTS: ~10 RPM and ~100/day. Pace 7s (under 10/min); when the daily cap
# is hit the daemon sleeps until reset and resumes. MAX_PER_CYCLE chunks commits.
export MAX_PER_CYCLE=95
export PACE_MS=7000

echo "Downloading Spelling Bee audio (push each batch: $AUTO_GIT)."
echo "Ctrl-C to stop any time — it's safe to re-run and resumes where it left off."
exec caffeinate -i node scripts/keep-updating-from-gemini.js
