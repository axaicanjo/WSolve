/* Wordle Solver — pattern matrix + entropy ranking (runs off the main thread) */
'use strict';

let W = [];          // words, lowercase
let N = 0;
let CODES = null;    // Uint8Array N*5, letter index 0..25
let MAT = null;      // Uint8Array N*N, MAT[g*N+s] = pattern code 0..242
const IDX = new Map();

const P3 = [81, 27, 9, 3, 1];

/* feedback pattern for guess codes gc[0..4] vs solution codes sc[0..4]
   2 = green, 1 = yellow, 0 = grey. Duplicate letters handled the same way
   the real game does: greens claim their letter first, then yellows consume
   whatever copies are left over, left to right. */
function patCodes(gc, go, sc, so, cnt) {
  cnt.fill(0);
  let m0 = 0, m1 = 0, m2 = 0, m3 = 0, m4 = 0;
  const g0 = gc[go], g1 = gc[go + 1], g2 = gc[go + 2], g3 = gc[go + 3], g4 = gc[go + 4];
  const s0 = sc[so], s1 = sc[so + 1], s2 = sc[so + 2], s3 = sc[so + 3], s4 = sc[so + 4];
  if (g0 === s0) m0 = 2; else cnt[s0]++;
  if (g1 === s1) m1 = 2; else cnt[s1]++;
  if (g2 === s2) m2 = 2; else cnt[s2]++;
  if (g3 === s3) m3 = 2; else cnt[s3]++;
  if (g4 === s4) m4 = 2; else cnt[s4]++;
  if (m0 === 0 && cnt[g0] > 0) { m0 = 1; cnt[g0]--; }
  if (m1 === 0 && cnt[g1] > 0) { m1 = 1; cnt[g1]--; }
  if (m2 === 0 && cnt[g2] > 0) { m2 = 1; cnt[g2]--; }
  if (m3 === 0 && cnt[g3] > 0) { m3 = 1; cnt[g3]--; }
  if (m4 === 0 && cnt[g4] > 0) { m4 = 1; cnt[g4]--; }
  return m0 * 81 + m1 * 27 + m2 * 9 + m3 * 3 + m4;
}

function build() {
  MAT = new Uint8Array(N * N);
  const cnt = new Uint8Array(26);
  let last = -1;
  for (let g = 0; g < N; g++) {
    const go = g * 5, base = g * N;
    for (let s = 0; s < N; s++) {
      MAT[base + s] = patCodes(CODES, go, CODES, s * 5, cnt);
    }
    const pct = ((g + 1) / N * 100) | 0;
    if (pct !== last && pct % 4 === 0) { last = pct; postMessage({ type: 'progress', p: pct }); }
  }
}

/* pattern for an arbitrary guess string (may be outside the list) */
function patStr(guess, si) {
  const gc = new Uint8Array(5);
  for (let i = 0; i < 5; i++) gc[i] = guess.charCodeAt(i) - 97;
  const cnt = new Uint8Array(26);
  return patCodes(gc, 0, CODES, si * 5, cnt);
}

function decode(p) {
  const out = [0, 0, 0, 0, 0];
  for (let i = 4; i >= 0; i--) { out[i] = p % 3; p = (p - out[i]) / 3; }
  return out;
}

/* candidates left after applying every guess/pattern in history */
function filter(history) {
  let cand = new Int32Array(N);
  for (let i = 0; i < N; i++) cand[i] = i;
  let n = N;
  for (const h of history) {
    const gi = IDX.has(h.guess) ? IDX.get(h.guess) : -1;
    const target = h.pattern;
    const next = new Int32Array(n);
    let k = 0;
    if (gi >= 0) {
      const base = gi * N;
      for (let i = 0; i < n; i++) { const s = cand[i]; if (MAT[base + s] === target) next[k++] = s; }
    } else {
      for (let i = 0; i < n; i++) { const s = cand[i]; if (patStr(h.guess, s) === target) next[k++] = s; }
    }
    cand = next; n = k;
    if (n === 0) break;
  }
  return cand.subarray(0, n);
}

const LOG2 = Math.log(2);

/* ---------- historic-answer weighting ----------
   LASTUSED[i] = puzzle number of the most recent time word i was the answer,
   or -1 if it has never been an answer. TODAYNUM = today's puzzle number.

   With "Use Historic Info" off every candidate is equally likely, which
   reproduces the plain solver exactly. With it on:
     - never-used words share (1 - RHO) of the probability, evenly;
     - previously-used words share RHO, in proportion to how long ago they
       were used, counting mainly the age beyond COOLDOWN days.
   RHO defaults to the observed repeat rate since the NYT began recycling
   answers on 2 Feb 2026; COOLDOWN reflects that no repeat so far has come
   back sooner than about a year and a half. Inside the cooldown a word keeps
   a small residual weight (TAIL) rather than dropping to exactly zero — the
   cooldown is an inference from a handful of repeats, not a published rule. */
let LASTUSED = null;
let TODAYNUM = -1;
const COOLDOWN = 365;
const TAIL = 0.05;
const ageWeight = a => Math.max(0, a - COOLDOWN) + TAIL * Math.min(a, COOLDOWN);

function weightsFor(cand, useHist, rho) {
  const n = cand.length;
  const w = new Float64Array(n);
  if (!useHist || !LASTUSED || TODAYNUM < 0) { w.fill(1 / n); return w; }
  let nNew = 0, sumRaw = 0;
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lu = LASTUSED[cand[i]];
    if (lu < 0) { nNew++; raw[i] = -1; }
    else { const r = ageWeight(TODAYNUM - lu); raw[i] = r; sumRaw += r; }
  }
  const nUsed = n - nNew;
  if (nUsed === 0 || sumRaw === 0) {
    // nothing recyclable left: spread everything over the never-used words
    if (nNew === 0) { w.fill(1 / n); return w; }
    for (let i = 0; i < n; i++) w[i] = raw[i] < 0 ? 1 / nNew : 0;
    return w;
  }
  if (nNew === 0) {
    for (let i = 0; i < n; i++) w[i] = raw[i] / sumRaw;
    return w;
  }
  const pNew = (1 - rho) / nNew;
  for (let i = 0; i < n; i++) w[i] = raw[i] < 0 ? pNew : rho * raw[i] / sumRaw;
  return w;
}

function rank(cand, limit, w) {
  const n = cand.length;
  const bins = new Float64Array(243);
  const cnts = new Int32Array(243);
  const candSet = new Uint8Array(N);
  for (let i = 0; i < n; i++) candSet[cand[i]] = 1;
  const res = [];
  for (let g = 0; g < N; g++) {
    bins.fill(0); cnts.fill(0);
    const base = g * N;
    for (let i = 0; i < n; i++) { const p = MAT[base + cand[i]]; bins[p] += w[i]; cnts[p]++; }
    let H = 0, exp = 0, worst = 0;
    for (let p = 0; p < 243; p++) {
      const q = bins[p];
      if (q <= 0) continue;
      H -= q * (Math.log(q) / LOG2);
      exp += q * cnts[p];
      if (cnts[p] > worst) worst = cnts[p];
    }
    res.push({ i: g, H: H, exp: exp, worst: worst, isCand: candSet[g] === 1 });
  }
  // best entropy first; a word that could itself be the answer wins ties
  res.sort((a, b) => (b.H - a.H) || (b.isCand - a.isCand) || (a.worst - b.worst));
  return res.slice(0, limit).map(r => ({
    word: W[r.i], H: r.H, exp: r.exp, worst: r.worst, isCand: r.isCand
  }));
}

/* With the historic model ON: never-used first (alphabetical), then
   previously-used, oldest use first.

   With it OFF: plain alphabetical, and every word reported as never used.
   The toggle has to make the distinction disappear completely — ordering and
   per-word dates included — not just stop it driving the ranking. Anything
   that leaks "this word has been an answer before" is the toggle not working.
   `cand` is already ascending and W is stored alphabetically, so index order
   is alphabetical order. */
function orderIdx(list, showHist) {
  const a2 = list.slice();
  if (!showHist || !LASTUSED) return a2.sort((a, b) => a - b);
  return a2.sort((a, b) => {
    const la = LASTUSED[a], lb = LASTUSED[b];
    if (la < 0 && lb < 0) return a - b;          // both new — words are stored alphabetically
    if (la < 0) return -1;
    if (lb < 0) return 1;
    return la - lb || a - b;                     // oldest use first
  });
}

const lastUsedFor = (i, showHist) => (showHist && LASTUSED ? LASTUSED[i] : -1);

function groupsFor(word, cand, showHist) {
  const gi = IDX.has(word) ? IDX.get(word) : -1;
  const map = new Map();
  for (let i = 0; i < cand.length; i++) {
    const s = cand[i];
    const p = gi >= 0 ? MAT[gi * N + s] : patStr(word, s);
    let a = map.get(p);
    if (!a) { a = []; map.set(p, a); }
    a.push(s);
  }
  const out = [];
  for (const [p, arr] of map) {
    const ord = orderIdx(arr, showHist);
    out.push({
      pattern: decode(p), code: p,
      words: ord.map(i => W[i]),
      lastUsed: ord.map(i => lastUsedFor(i, showHist))
    });
  }
  out.sort((a, b) => b.words.length - a.words.length);
  return out;
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    W = m.words; N = W.length;
    CODES = new Uint8Array(N * 5);
    for (let i = 0; i < N; i++) {
      IDX.set(W[i], i);
      for (let j = 0; j < 5; j++) CODES[i * 5 + j] = W[i].charCodeAt(j) - 97;
    }
    build();
    postMessage({ type: 'ready', n: N });
    return;
  }
  if (m.type === 'history') {
    LASTUSED = new Int32Array(N).fill(-1);
    TODAYNUM = m.todayNum;
    let hits = 0;
    for (const [word, num] of m.pairs) {
      const i = IDX.get(word);
      if (i === undefined) continue;                 // answer outside our 2,486-word list
      if (num > LASTUSED[i]) { if (LASTUSED[i] < 0) hits++; LASTUSED[i] = num; }
    }
    postMessage({ type: 'historyOk', matched: hits });
    return;
  }
  if (m.type === 'compute') {
    const cand = filter(m.history);
    let suggestions = [], groups = [], pick = null, words = [], lastUsed = [], probs = [];
    const showHist = !!m.useHist;
    if (cand.length > 0) {
      const w = weightsFor(cand, showHist, m.rho);
      suggestions = rank(cand, 10, w);
      pick = m.focus && suggestions.some(s => s.word === m.focus) ? m.focus : suggestions[0].word;
      groups = groupsFor(pick, cand, showHist);
      // Probabilities are part of the historic model, so they go with it. With
      // the toggle off every word is equally likely and there is nothing to say.
      const pw = showHist ? weightsFor(cand, true, m.rho) : null;
      const pos = new Map();
      for (let i = 0; i < cand.length; i++) pos.set(cand[i], i);
      const ord = orderIdx(Array.from(cand), showHist);
      for (const i of ord) {
        words.push(W[i]);
        lastUsed.push(lastUsedFor(i, showHist));
        probs.push(pw ? pw[pos.get(i)] : null);
      }
    }
    postMessage({
      type: 'result', count: cand.length, words, lastUsed, probs,
      suggestions, groups, pick, token: m.token
    });
    return;
  }
  if (m.type === 'groups') {
    const cand = filter(m.history);
    postMessage({ type: 'groupsOnly', pick: m.word, groups: groupsFor(m.word, cand, !!m.useHist), token: m.token });
  }
};
