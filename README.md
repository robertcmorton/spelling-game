# Spelling Bee

A browser-based spelling-bee game for kids aged 7–16. The game reads a word
aloud and the child types it — same format as a real spelling-bee contest.

## Play

Open `index.html` in any modern browser, or visit the deployed version.

## Features

- **Age-based difficulty** — pick an age (7–16) and the word pool adjusts
  to match. Every age has 10 difficulty levels, from *Warm up* to *Master*.
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

Single self-contained HTML file. No build step, no backend, no API keys.
Vanilla JS, the Web Speech API for browser TTS, and `kokoro-js` lazy-loaded
from jsDelivr for the AI voice.

## Made by

Robert C Morton, with Claude.
