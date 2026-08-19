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

function rank(cand, limit) {
  const n = cand.length;
  const bins = new Int32Array(243);
  const candSet = new Uint8Array(N);
  for (let i = 0; i < n; i++) candSet[cand[i]] = 1;
  const res = [];
  for (let g = 0; g < N; g++) {
    bins.fill(0);
    const base = g * N;
    for (let i = 0; i < n; i++) bins[MAT[base + cand[i]]]++;
    let H = 0, exp = 0, worst = 0;
    for (let p = 0; p < 243; p++) {
      const c = bins[p];
      if (c === 0) continue;
      const q = c / n;
      H -= q * (Math.log(q) / LOG2);
      exp += q * c;
      if (c > worst) worst = c;
    }
    res.push({ i: g, H: H, exp: exp, worst: worst, isCand: candSet[g] === 1 });
  }
  // best entropy first; a word that could itself be the answer wins ties
  res.sort((a, b) => (b.H - a.H) || (b.isCand - a.isCand) || (a.worst - b.worst));
  return res.slice(0, limit).map(r => ({
    word: W[r.i], H: r.H, exp: r.exp, worst: r.worst, isCand: r.isCand
  }));
}

function groupsFor(word, cand) {
  const gi = IDX.has(word) ? IDX.get(word) : -1;
  const map = new Map();
  for (let i = 0; i < cand.length; i++) {
    const s = cand[i];
    const p = gi >= 0 ? MAT[gi * N + s] : patStr(word, s);
    let a = map.get(p);
    if (!a) { a = []; map.set(p, a); }
    a.push(W[s]);
  }
  const out = [];
  for (const [p, arr] of map) out.push({ pattern: decode(p), code: p, words: arr });
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
  if (m.type === 'compute') {
    const cand = filter(m.history);
    const words = [];
    for (let i = 0; i < cand.length; i++) words.push(W[cand[i]]);
    let suggestions = [], groups = [], pick = null;
    if (cand.length > 0) {
      suggestions = rank(cand, 10);
      pick = m.focus && suggestions.some(s => s.word === m.focus) ? m.focus : suggestions[0].word;
      groups = groupsFor(pick, cand);
    }
    postMessage({ type: 'result', count: cand.length, words, suggestions, groups, pick, token: m.token });
    return;
  }
  if (m.type === 'groups') {
    const cand = filter(m.history);
    postMessage({ type: 'groupsOnly', pick: m.word, groups: groupsFor(m.word, cand), token: m.token });
  }
};
