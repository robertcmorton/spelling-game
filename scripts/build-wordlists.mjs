// Rebuild the WORD_LISTS literal in index.html from the source files.
//   Words:     junior_wordlist.txt (levels 1-5) + senior_wordlist.txt (levels 2-6)
//   Sentences: sentences.txt  ("word|sentence" lines; '#' and blanks ignored)
// Junior = junior levels 1-5; Senior = senior levels 2-6 renumbered to 1-5.
// Run from anywhere:  node scripts/build-wordlists.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'index.html');

function parseLevels(raw) {
  const levels = {}; let cur = null;
  for (const l0 of raw.split('\n')) {
    const l = l0.trim();
    if (!l || /^=+$/.test(l) || /^alphabetical wordlist$/i.test(l)) continue;
    const h = l.match(/^LEVEL\s+(\d+)\s*\(\d+\s*words?\)/i);
    if (h) { cur = +h[1]; levels[cur] = []; continue; }
    if (cur == null) continue;
    if (l.includes('"') || l.includes('\\') || /\s/.test(l)) throw new Error('bad word: ' + JSON.stringify(l));
    levels[cur].push(l);
  }
  return levels;
}

const jun = parseLevels(await readFile(path.join(ROOT, 'junior_wordlist.txt'), 'utf-8'));
const sen = parseLevels(await readFile(path.join(ROOT, 'senior_wordlist.txt'), 'utf-8'));
const junior = [1, 2, 3, 4, 5].map(l => jun[l]);
const senior = [2, 3, 4, 5, 6].map(l => sen[l]);

const sent = {};
for (const l0 of (await readFile(path.join(ROOT, 'sentences.txt'), 'utf-8')).split('\n')) {
  const l = l0.trim();
  if (!l || l.startsWith('#')) continue;
  const i = l.indexOf('|');
  if (i < 1) continue;
  const w = l.slice(0, i).trim(), s = l.slice(i + 1).trim();
  if (w && s) sent[w] = s;
}

const entry = w => `      { word: ${JSON.stringify(w)}, sentence: ${JSON.stringify(sent[w] || '')} }`;
const fmtList = arr => arr.map((w, i) => `    [   // Level ${i + 1} (${w.length} words)\n${w.map(entry).join(',\n')}\n    ]`).join(',\n');

const NEW = `// Five difficulty levels, shared by both modes.
const LEVEL_NAMES = ["Warm-up", "Easy", "Steady", "Tricky", "Champion"];

// Two fixed modes, five levels each, from the NSW Premier Spelling Bee.
//   Junior = junior list levels 1-5.
//   Senior = senior list levels 2-6, renumbered to 1-5 so both modes show Level 1-5.
// Each entry is { word, sentence }; sentence is '' until authored (see sentences.txt).
const WORD_LISTS = {
  junior: [
${fmtList(junior)}
  ],
  senior: [
${fmtList(senior)}
  ]
};

// Words for (mode, level index 0-4) as {word, sentence} objects (fresh copies).
function poolFor(mode, level) {
  const levels = WORD_LISTS[mode] || WORD_LISTS.junior;
  return (levels[level] || levels[0] || []).map(w => ({ word: w.word, sentence: w.sentence || '' }));
}
function poolForCurrent() {
  return poolFor(state.mode || 'junior', state.level || 0);
}`;

let html = await readFile(HTML, 'utf-8');
const startMarker = '// Five difficulty levels, shared by both modes.';
const endMarker = `function poolForCurrent() {\n  return poolFor(state.mode || 'junior', state.level || 0);\n}`;
const s = html.indexOf(startMarker), e = html.indexOf(endMarker);
if (s < 0 || e < 0) throw new Error(`markers not found (s=${s} e=${e})`);
html = html.slice(0, s) + NEW + html.slice(e + endMarker.length);
await writeFile(HTML, html);

const all = [...junior.flat(), ...senior.flat()];
const withS = all.filter(w => sent[w]).length;
console.log('junior levels:', junior.map(a => a.length).join(','), '| senior:', senior.map(a => a.length).join(','));
console.log(`sentences populated: ${withS}/${all.length}`);
