/* Adds new possible answers to words.js.
 *
 *   node update-wordlist.mjs                 # fetch word.tips' NYT answer list and add anything new
 *   node update-wordlist.mjs word1 word2 …   # add these words by hand (no network)
 *
 * Only ever ADDS to WORDBLOB. A word that moves in is taken out of GUESSBLOB, so the
 * two lists stay disjoint and both stay alphabetical. Nothing is ever removed from
 * the answer list: the NYT recycles old answers, so a word word.tips drops could
 * still come up.
 */
import { readFile, writeFile } from 'node:fs/promises';

const FILE = process.cwd() + '/words.js';
const API = 'https://fly.wordfinderapi.com/api/search?contains=_____&length=5'
  + '&word_sorting=az&group_by_length=true&page_size=5000&dictionary=wordle';

async function fetchWordTips() {
  let last;
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(API, {
        headers: {
          accept: 'application/json',
          origin: 'https://word.tips',
          referer: 'https://word.tips/',
          'user-agent': 'Mozilla/5.0 (wordle-solver-wordlist/1.0)'
        }
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const out = [];
      (function walk(o) {
        if (Array.isArray(o)) o.forEach(walk);
        else if (o && typeof o === 'object') {
          if (typeof o.word === 'string') out.push(o.word.toLowerCase());
          else Object.values(o).forEach(walk);
        }
      })(j.word_pages);
      return out;
    } catch (e) {
      last = e;
      await new Promise(r => setTimeout(r, 3000 * (t + 1)));
    }
  }
  throw last;
}

const src = await readFile(FILE, 'utf8');
const mW = src.match(/const WORDBLOB="([a-z]*)";/);
const mG = src.match(/const GUESSBLOB="([a-z]*)";/);
if (!mW || !mG) throw new Error('words.js is not in the expected two-line format');
const split = b => b.match(/.{5}/g) || [];
const W = split(mW[1]), G = split(mG[1]);
const inW = new Set(W);

const manual = process.argv.slice(2).map(s => s.toLowerCase());
const source = manual.length ? manual : await fetchWordTips();

// Sanity checks — a broken or changed API must never damage the list.
if (source.some(w => !/^[a-z]{5}$/.test(w))) throw new Error('source contains a non-5-letter word');
if (!manual.length) {
  if (source.length < 2000) throw new Error(`source only has ${source.length} words — refusing`);
  const overlap = source.filter(w => inW.has(w)).length;
  if (overlap < 0.95 * W.length) throw new Error(`source only overlaps ${overlap} of ${W.length} current answers — refusing`);
}

const added = [...new Set(source)].filter(w => !inW.has(w)).sort();
if (!manual.length && added.length > 50) throw new Error(`${added.length} new words at once looks wrong — refusing`);
if (!added.length) { console.log(`no new words (${W.length} answers)`); process.exit(0); }

const addSet = new Set(added);
const newW = [...W, ...added].sort();
const newG = G.filter(w => !addSet.has(w));
const out = src
  .replace(mW[0], `const WORDBLOB="${newW.join('')}";`)
  .replace(mG[0], `const GUESSBLOB="${newG.join('')}";`);
await writeFile(FILE, out);
console.log(`added ${added.length}: ${added.join(' ').toUpperCase()}`);
console.log(`answers ${W.length} -> ${newW.length}; other valid guesses ${G.length} -> ${newG.length}`);
