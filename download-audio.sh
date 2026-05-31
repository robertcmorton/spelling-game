#!/usr/bin/env bash
#
# Download the Spelling Bee audio from Google Gemini (Achernar voice, en-AU).
# Run it and leave it. With Gemini 2.5 Flash TTS (no daily cap) it generates the
# whole set in one sitting (roughly a couple of hours), committing + pushing each
# batch as it goes. (If the API ever rate-limits, it backs off automatically.)
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

# Gemini 2.5 Flash TTS has no daily cap, so use big batches + a brisk pace.
export MAX_PER_CYCLE=300
export PACE_MS=300

echo "Downloading Spelling Bee audio (push each batch: $AUTO_GIT)."
echo "Ctrl-C to stop any time — it's safe to re-run and resumes where it left off."
exec caffeinate -i node scripts/keep-updating-from-gemini.js
