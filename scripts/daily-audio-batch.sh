#!/bin/bash
# One daily batch of ~95 Gemini 3.1 Flash TTS clips (Leda voice), then commit + push.
# Run automatically by the launchd agent "com.spellingbee.audiogen" (no Terminal needed).
# Watch progress:  tail -f /tmp/spelling-audio.log
# launchd runs with a bare environment, so we set PATH + an absolute node path here.

export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
NODE="/opt/homebrew/bin/node"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

cd "$REPO" || { echo "[$(date)] repo not found at $REPO"; exit 1; }

echo "[$(date)] === daily batch start (in $REPO) ==="

# Generate up to 95 clips (under Gemini 3.1's ~100/day cap), paced ~7s for the 10 RPM limit.
MAX_PER_RUN=95 PACE_MS=7000 "$NODE" scripts/generate-audio.js

# Commit + push whatever was generated this run.
git add public/audio
if git diff --cached --quiet; then
  echo "[$(date)] nothing new (today's quota likely already used) — will try again next run"
else
  N=$(ls public/audio/*.wav 2>/dev/null | wc -l | tr -d ' ')
  git commit -m "Pre-generated audio (launchd daily): ${N}/4203"
  git push && echo "[$(date)] pushed ${N}/4203" || echo "[$(date)] push failed (will retry next run)"
fi
echo "[$(date)] === daily batch done ==="
