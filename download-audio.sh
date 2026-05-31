#!/usr/bin/env bash
#
# Download the Spelling Bee audio from Google Gemini (Achernar voice, en-AU).
# Run it and leave it: it generates one daily batch (~95 clips) under Gemini's
# 10/min + 100/day preview limits, then sleeps until the quota resets
# (~midnight Pacific) and continues. The full set takes a few weeks.
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

echo "Downloading Spelling Bee audio (push each batch: $AUTO_GIT)."
echo "Ctrl-C to stop any time — it's safe to re-run and resumes where it left off."
exec caffeinate -i node scripts/keep-updating-from-gemini.js
