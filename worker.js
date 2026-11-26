/* Beat the Bot v2 — pattern matrix, entropy ranking and small-list look-ahead (runs off the main thread) */
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
  /* `cnt` counts the answer's unmatched letters. Only the five slots s0..s4 are
     ever touched, so they are zeroed again on the way out rather than clearing
     all 26 — this runs 25M times on an opening move with the full dictionary. */
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
  cnt[s0] = 0; cnt[s1] = 0; cnt[s2] = 0; cnt[s3] = 0; cnt[s4] = 0;
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
   reproduces the plain solver exactly. */
let LASTUSED = null;
let TODAYNUM = -1;
const AGE0 = 500, AGE1 = 1600;
const ageW = a => (a <= AGE0 ? 0 : Math.min(1, (a - AGE0) / (AGE1 - AGE0)));

let FIT = null;

function poolState() {
  let F = 0, S = 0;
  for (let i = 0; i < N; i++) {
    const lu = LASTUSED[i];
    if (lu < 0) F++; else S += ageW(TODAYNUM - lu);
  }
  return { F, S };
}

/* Returns null when the archive cannot support a result. */
function fitLam(seq) {
  const n = seq.length;
  if (!n) return null;
  let first = -1;
  const seen = new Set(), lastAt = new Map();
  for (let k = 0; k < n; k++) { if (seen.has(seq[k][0])) { first = k; break; } seen.add(seq[k][0]); }
  if (first < 0) return null;
  const from = seq[first][1];
  for (let k = first; k < n; k++) if (seq[k][1] !== from + (k - first)) return null;  // gap

  seen.clear();
  let fresh = 0;
  const Fs = [], Ss = [], rep = [];
  for (let k = 0; k < n; k++) {
    const [word, num] = seq[k];
    if (k >= first) {
      let S = 0;
      for (const at of lastAt.values()) S += ageW(num - at);
      Fs.push(N - fresh); Ss.push(S); rep.push(seen.has(word) ? 1 : 0);
    }
    if (!seen.has(word)) { seen.add(word); if (IDX.has(word)) fresh++; }
    lastAt.set(word, num);
  }
  const R = rep.reduce((a, b) => a + b, 0);
  const expected = lam => {
    let e = 0;
    for (let i = 0; i < Fs.length; i++) e += lam * Ss[i] / (Fs[i] + lam * Ss[i]);
    return e;
  };
  let lo = 1e-6, hi = 10;
  if (expected(hi) < R + 0.5) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (expected(mid) < R + 0.5) lo = mid; else hi = mid;
  }
  const lam = Math.min(2, Math.max(0.002, (lo + hi) / 2));
  return { lam, days: Fs.length, repeats: R };
}

/* Same arithmetic, with lam taken from the rate the user set. */
function lamForRate(rho) {
  const { F, S } = poolState();
  if (S <= 0 || rho <= 0) return 0;
  if (rho >= 1) return 1e6;
  return (rho / (1 - rho)) * (F / S);
}

function weightsFor(cand, useHist, rho, autoRate) {
  const n = cand.length;
  const w = new Float64Array(n);
  if (!useHist || !LASTUSED || TODAYNUM < 0) { w.fill(1 / n); return w; }
  const lam = autoRate && FIT ? FIT.lam : lamForRate(rho);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const lu = LASTUSED[cand[i]];
    w[i] = lu < 0 ? 1 : lam * ageW(TODAYNUM - lu);
    sum += w[i];
  }
  if (sum <= 0) { w.fill(1 / n); return w; }   // nothing left to distinguish them
  for (let i = 0; i < n; i++) w[i] /= sum;
  return w;
}

const byValue = (a, b) => (b.H - a.H) || (b.isCand - a.isCand) || (a.worst - b.worst);
/* v2 look-ahead order: fewest expected guesses, then could-be-the-answer, then information. */
const byLook = (a, b) => (a.eg - b.eg) || (b.isCand - a.isCand) || (b.H - a.H) || (a.worst - b.worst);

/* ---------- the guess pool ----------
   Every candidate is a solution word, so MAT already covers each
   (solution guess × candidate) pair. The 10,589 extra valid guesses are not in
   it: a full 12,972² table would be ~170 MB, far too much for a phone. They
   carry letter codes only and are scored on the fly, which costs ~25M pattern
   computations on the opening move and almost nothing after that, because the
   candidate set collapses as soon as there is a clue. */
let X = [], M = 0, XCODES = null;
const XIDX = new Map();

const SCRATCH = { bins: new Float64Array(243), cnts: new Int32Array(243), cnt: new Uint8Array(26) };

/* Score one guess against the surviving candidates. Pass gi >= 0 to read the
   precomputed row; otherwise give the guess's letter codes and an offset. */
function scoreCodes(codes, off, cand, w, gi, candSet) {
  const bins = SCRATCH.bins, cnts = SCRATCH.cnts;
  bins.fill(0); cnts.fill(0);
  if (gi >= 0) {
    const base = gi * N;
    for (let i = 0; i < cand.length; i++) { const p = MAT[base + cand[i]]; bins[p] += w[i]; cnts[p]++; }
  } else {
    for (let i = 0; i < cand.length; i++) {
      const p = patCodes(codes, off, CODES, cand[i] * 5, SCRATCH.cnt);
      bins[p] += w[i]; cnts[p]++;
    }
  }
  let H = 0, exp = 0, worst = 0;
  for (let p = 0; p < 243; p++) {
    const q = bins[p];
    if (q <= 0) continue;
    H -= q * (Math.log(q) / LOG2);
    exp += q * cnts[p];
    if (cnts[p] > worst) worst = cnts[p];
  }
  return { H, exp, worst, isCand: gi >= 0 && candSet[gi] === 1 };
}

/* Score any word at all, whether it is a solution word, one of the extra valid
   guesses, or something the user typed that is neither. */
function scoreWord(word, cand, w, candSet) {
  const gi = IDX.has(word) ? IDX.get(word) : -1;
  if (gi >= 0) return scoreCodes(null, 0, cand, w, gi, candSet);
  const xi = XIDX.has(word) ? XIDX.get(word) : -1;
  if (xi >= 0) return scoreCodes(XCODES, xi * 5, cand, w, -1, candSet);
  const codes = new Uint8Array(5);
  for (let i = 0; i < 5; i++) codes[i] = word.charCodeAt(i) - 97;
  return scoreCodes(codes, 0, cand, w, -1, candSet);
}

/* ---------- hard mode ----------
   Wordle's rule is that every hint already revealed must be used again:
   a letter shown green has to stay in that square, and a letter shown green or
   yellow has to appear at least as many times as it has been shown. Grey
   letters may be reused, and a yellow may be tried in the same square again —
   both of those match the game. Any word still consistent with the clues
   passes automatically, so this only ever removes probe words. */
function hardFrom(history) {
  if (!history.length) return null;
  const fixed = new Int8Array(5).fill(-1);
  const need = new Int8Array(26);
  for (const h of history) {
    const marks = decode(h.pattern);
    const seen = new Int8Array(26);
    for (let i = 0; i < 5; i++) {
      const c = h.guess.charCodeAt(i) - 97;
      if (marks[i] === 2) fixed[i] = c;
      if (marks[i] > 0) seen[c]++;
    }
    for (let c = 0; c < 26; c++) if (seen[c] > need[c]) need[c] = seen[c];
  }
  let any = false;
  for (let c = 0; c < 26; c++) if (need[c]) { any = true; break; }
  return { fixed, need, any };
}

/* Its own counter, deliberately not SCRATCH.cnt: patCodes is entitled to find
   that one full of zeros, and borrowing it here left letter counts behind that
   silently corrupted the next pattern it worked out. */
const HCNT = new Uint8Array(26);
function hardOkCodes(codes, off, hard) {
  const { fixed, need, any } = hard;
  for (let i = 0; i < 5; i++) if (fixed[i] >= 0 && codes[off + i] !== fixed[i]) return false;
  if (!any) return true;
  HCNT.fill(0);
  for (let i = 0; i < 5; i++) HCNT[codes[off + i]]++;
  for (let c = 0; c < 26; c++) if (need[c] && HCNT[c] < need[c]) return false;
  return true;
}
const hardOkWord = (word, hard) => {
  const codes = new Uint8Array(5);
  for (let i = 0; i < 5; i++) codes[i] = word.charCodeAt(i) - 97;
  return hardOkCodes(codes, 0, hard);
};

/* Every word in the active pool, scored and ordered. */
function rankAll(cand, w, wholeDictionary, hard) {
  const candSet = new Uint8Array(N);
  for (let i = 0; i < cand.length; i++) candSet[cand[i]] = 1;
  const res = [];
  for (let g = 0; g < N; g++) {
    if (hard && !hardOkCodes(CODES, g * 5, hard)) continue;
    const r = scoreCodes(null, 0, cand, w, g, candSet);
    res.push({ word: W[g], H: r.H, exp: r.exp, worst: r.worst, isCand: r.isCand });
  }
  if (wholeDictionary) {
    for (let g = 0; g < M; g++) {
      if (hard && !hardOkCodes(XCODES, g * 5, hard)) continue;
      const r = scoreCodes(XCODES, g * 5, cand, w, -1, candSet);
      res.push({ word: X[g], H: r.H, exp: r.exp, worst: r.worst, isCand: false });
    }
  }
  res.sort(byValue);
  return res;
}

function rank(cand, limit, w, wholeDictionary, hard) {
  return rankAll(cand, w, wholeDictionary, hard).slice(0, limit);
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

/* ---------- v2: look-ahead for small candidate lists ----------
   Below LOOK_MAX candidates the suggestions are ranked by the expected number
   of guesses still needed to finish (this one included), not by information.
   Information gives no credit for a guess that might itself be the answer;
   this does. Every plan must also solve EVERY remaining candidate — including
   words the historic model gives zero weight — within the six guesses, so a
   bet on the likely words can never cost the game.

   The search is approximate: at each step it tries every remaining candidate,
   the LOOK_K most informative guesses and the LOOK_W guesses with the smallest
   worst case. Below the first step the guesses come from the LOOK_SUB best
   guesses at the top. In hard mode every hypothetical later guess obeys the
   clues before it, as the game would require. If the search runs past LOOK_MS it gives up and
   the plain information ranking is used instead. */
const LOOK_MAX = 50, LOOK_K = 8, LOOK_W = 4, LOOK_SUB = 150, LOOK_MS = 4000;
const LOOK_INF = 1e9;

function lamNow(useHist, rho, autoRate) {
  if (!useHist || !LASTUSED || TODAYNUM < 0) return 0;
  return autoRate && FIT ? FIT.lam : lamForRate(rho);
}

/* A guess for the search: index into W when it is a solution word (so MAT
   applies), otherwise its letter codes. */
function lookGuess(word) {
  const gi = IDX.has(word) ? IDX.get(word) : -1;
  if (gi >= 0) return { word, gi, codes: CODES, off: gi * 5 };
  const xi = XIDX.has(word) ? XIDX.get(word) : -1;
  if (xi >= 0) return { word, gi: -1, codes: XCODES, off: xi * 5 };
  const c = new Uint8Array(5);
  for (let i = 0; i < 5; i++) c[i] = word.charCodeAt(i) - 97;
  return { word, gi: -1, codes: c, off: 0 };
}
const LCNT = new Uint8Array(26);
const lookPat = (g, s) => g.gi >= 0 ? MAT[g.gi * N + s] : patCodes(g.codes, g.off, CODES, s * 5, LCNT);

/* Hard mode inside the search: each hypothetical guess adds its clue to the
   rules the next one must follow, exactly as hardFrom does for real guesses. */
function hardExtend(hs, g, p) {
  const fixed = Int8Array.from(hs.fixed), need = Int8Array.from(hs.need);
  const marks = decode(p), seen = new Int8Array(26);
  for (let i = 0; i < 5; i++) {
    const c = g.codes[g.off + i];
    if (marks[i] === 2) fixed[i] = c;
    if (marks[i] > 0) seen[c]++;
  }
  let any = false;
  for (let c = 0; c < 26; c++) { if (seen[c] > need[c]) need[c] = seen[c]; if (need[c]) any = true; }
  return { fixed, need, any };
}
const hardKey = hs => hs ? Array.from(hs.fixed).join('.') + ':' + Array.from(hs.need).join('') : '';
const NOHARD = () => ({ fixed: new Int8Array(5).fill(-1), need: new Int8Array(26), any: false });

function makeLook(useHist, rho, autoRate, rootGuesses, deadline, hard0) {
  const lam = lamNow(useHist, rho, autoRate);
  const histOn = useHist && LASTUSED && TODAYNUM >= 0;
  const raw = i => !histOn ? 1 : (LASTUSED[i] < 0 ? 1 : lam * ageW(TODAYNUM - LASTUSED[i]));
  const memo = new Map();
  const bins = new Float64Array(243), cnts = new Int32Array(243);

  function norm(S) {
    const w = new Float64Array(S.length); let t = 0;
    for (let i = 0; i < S.length; i++) { w[i] = raw(S[i]); t += w[i]; }
    if (t > 0) for (let i = 0; i < S.length; i++) w[i] /= t; else w.fill(1 / S.length);
    return w;
  }
  /* guesses worth trying on subset S, best first */
  function poolFor(S, w, guesses, hs) {
    const sc = [];
    for (const g of guesses) {
      if (hs && !hardOkCodes(g.codes, g.off, hs)) continue;
      bins.fill(0); cnts.fill(0);
      for (let i = 0; i < S.length; i++) { const p = lookPat(g, S[i]); bins[p] += w[i]; cnts[p]++; }
      let H = 0, worst = 0;
      for (let p = 0; p < 243; p++) {
        if (bins[p] > 0) H -= bins[p] * Math.log(bins[p]) / LOG2;
        if (cnts[p] > worst) worst = cnts[p];
      }
      sc.push({ g, H, worst });
    }
    const byH = sc.slice().sort((a, b) => b.H - a.H);
    const byW = sc.slice().sort((a, b) => a.worst - b.worst || b.H - a.H);
    const out = new Map();
    for (const s of S) out.set(W[s], lookGuess(W[s]));
    for (const x of byH.slice(0, LOOK_K)) out.set(x.g.word, x.g);
    for (const x of byW.slice(0, LOOK_W)) out.set(x.g.word, x.g);
    return { pool: [...out.values()], ranked: byH.map(x => x.g) };
  }
  function cost(S, left, hs) {
    if (Date.now() > deadline) throw new Error('look-ahead timeout');
    const key = S.join(',') + '|' + left + '|' + hardKey(hs);
    const hit = memo.get(key);
    if (hit) return hit;
    let r;
    const w = norm(S);
    if (left < 1) r = { e: LOOK_INF, g: null };
    else if (S.length === 1) r = { e: 1, g: W[S[0]] };
    else if (left === 1) r = { e: LOOK_INF, g: null };
    else if (S.length === 2) { const j = w[1] > w[0] ? 1 : 0; r = { e: 2 - w[j], g: W[S[j]] }; }
    else {
      const { pool } = poolFor(S, w, SUBPOOL, hs);
      r = { e: LOOK_INF, g: null };
      for (const g of pool) {
        const e = after(g, S, w, left, hs);
        if (e < r.e) r = { e, g: g.word };
      }
    }
    memo.set(key, r);
    return r;
  }
  /* expected guesses to finish when g is played now with `left` guesses
     remaining (g included) */
  function after(g, S, w, left, hs) {
    const parts = new Map();
    for (let i = 0; i < S.length; i++) {
      const p = lookPat(g, S[i]);
      let a = parts.get(p); if (!a) { a = { s: [], q: 0 }; parts.set(p, a); }
      a.s.push(S[i]); a.q += w[i];
    }
    if (parts.size === 1 && !parts.has(242)) return LOOK_INF;   // learns nothing
    let e = 1;
    for (const [p, a] of parts) {
      if (p === 242) continue;
      const c = cost(a.s, left - 1, hs ? hardExtend(hs, g, p) : null).e;
      if (c >= LOOK_INF) return LOOK_INF;
      e += a.q * c;
    }
    return e;
  }
  let SUBPOOL = rootGuesses.slice(0, LOOK_SUB);
  return {
    norm, after,
    /* score every guess in the root pool; returns them sorted, feasible first */
    root(S, left, extraWords) {
      const w = norm(S);
      const { pool } = poolFor(S, w, rootGuesses.slice(0, Math.max(LOOK_SUB, LOOK_K)), hard0);
      const seen = new Set(pool.map(g => g.word));
      for (const x of extraWords || []) if (!seen.has(x)) { pool.push(lookGuess(x)); seen.add(x); }
      for (const s of S) SUBPOOL.push(lookGuess(W[s]));
      return pool.map(g => ({ word: g.word, eg: after(g, S, w, left, hard0) }));
    }
  };
}

/* Re-rank the suggestions by look-ahead. `ranked` is the full information
   ranking (already filtered for hard mode and the guess pool). Returns null when
   the look-ahead does not apply or runs out of time, so the caller keeps the
   information ranking. */
function lookAhead(cand, ranked, m, extraWords) {
  const S = Array.from(cand);
  const left = 6 - m.history.length;
  if (S.length < 2 || S.length >= LOOK_MAX || left < 1) return null;
  try {
    const rootG = ranked.map(r => lookGuess(r.word));
    const hard0 = m.hardMode ? (hardFrom(m.history) || NOHARD()) : null;
    const L = makeLook(!!m.useHist, m.rho, !!m.autoRate, rootG, Date.now() + LOOK_MS, hard0);
    let scored = L.root(S, left, extraWords);
    let guarantee = scored.some(x => x.eg < LOOK_INF);
    if (!guarantee) {
      /* Already too late to be sure of six (or nothing tried can promise it):
         drop the limit and just minimise the expected count. */
      const L2 = makeLook(!!m.useHist, m.rho, !!m.autoRate, rootG, Date.now() + LOOK_MS, hard0);
      scored = L2.root(S, 20, extraWords);
    }
    const info = new Map(ranked.map(r => [r.word, r]));
    return { guarantee, left, scored, info };
  } catch (err) {
    return null;
  }
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
    X = m.extras || []; M = X.length;
    XCODES = new Uint8Array(M * 5);
    for (let i = 0; i < M; i++) {
      XIDX.set(X[i], i);
      for (let j = 0; j < 5; j++) XCODES[i * 5 + j] = X[i].charCodeAt(j) - 97;
    }
    build();
    postMessage({ type: 'ready', n: N, extras: M });
    return;
  }
  if (m.type === 'history') {
    LASTUSED = new Int32Array(N).fill(-1);
    TODAYNUM = m.todayNum;
    let hits = 0;
    for (const [word, num] of m.pairs) {
      const i = IDX.get(word);
      if (i === undefined) continue;                 // answer outside our word list
      if (num > LASTUSED[i]) { if (LASTUSED[i] < 0) hits++; LASTUSED[i] = num; }
    }
    const seq = m.pairs.slice().sort((a, b) => a[1] - b[1]);
    FIT = fitLam(seq);
    if (FIT) {
      const { F, S } = poolState();
      FIT.rho = F + FIT.lam * S > 0 ? FIT.lam * S / (F + FIT.lam * S) : 1;
      FIT.left = F;
    }
    postMessage({ type: 'historyOk', matched: hits, fit: FIT });
    return;
  }
  if (m.type === 'compute') {
    const cand = filter(m.history);
    let suggestions = [], groups = [], pick = null, words = [], lastUsed = [], probs = [];
    let mode = 'info', guarantee = true;
    const showHist = !!m.useHist;
    if (cand.length > 0) {
      const w = weightsFor(cand, showHist, m.rho, !!m.autoRate);
      const all = rankAll(cand, w, !!m.wholeDictionary, m.hardMode ? hardFrom(m.history) : null);
      suggestions = all.slice(0, 10);
      const la = lookAhead(cand, all, m);
      if (la) {
        mode = 'look'; guarantee = la.guarantee;
        suggestions = la.scored
          .filter(x => x.eg < LOOK_INF)
          .map(x => Object.assign({}, la.info.get(x.word), { eg: x.eg }))
          .sort(byLook)
          .slice(0, 10);
      }
      pick = m.focus && suggestions.some(s => s.word === m.focus) ? m.focus : suggestions[0].word;
      groups = groupsFor(pick, cand, showHist);
      // Probabilities are part of the historic model, so they go with it. With
      // the toggle off every word is equally likely and there is nothing to say.
      const pw = showHist ? weightsFor(cand, true, m.rho, !!m.autoRate) : null;
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
      suggestions, groups, pick, mode, guarantee, token: m.token
    });
    return;
  }
  if (m.type === 'groups') {
    const cand = filter(m.history);
    postMessage({ type: 'groupsOnly', pick: m.word, groups: groupsFor(m.word, cand, !!m.useHist), token: m.token });
    return;
  }
  /* Score any word the user chose — a surviving candidate they long-pressed, or
     anything they typed — with exactly the numbers the ten suggestions carry,
     plus where it sits in the full ordering so they can see what the choice
     costs. A word outside the list has no rank; `rank` comes back null. */
  if (m.type === 'analyse') {
    const cand = filter(m.history);
    const showHist = !!m.useHist;
    if (!cand.length) {
      postMessage({ type: 'analysis', word: m.word, stats: null, groups: [], token: m.token });
      return;
    }
    const w = weightsFor(cand, showHist, m.rho, !!m.autoRate);
    const candSet = new Uint8Array(N);
    for (let i = 0; i < cand.length; i++) candSet[cand[i]] = 1;
    const st = scoreWord(m.word, cand, w, candSet);
    /* Rank is counted rather than looked up, so a word outside the active pool
       still gets a meaningful "it would come in at #N" against that pool. */
    const hard = m.hardMode ? hardFrom(m.history) : null;
    const all = rankAll(cand, w, !!m.wholeDictionary, hard);
    let rankPos = 1, total = all.length, eg = null;
    const la = lookAhead(cand, all, m, [m.word]);
    if (la) {
      /* Rank against the same look-ahead list the suggestions come from. */
      const mine = la.scored.find(x => x.word === m.word);
      eg = mine ? mine.eg : null;
      const me = Object.assign({}, st, { eg: eg == null ? LOOK_INF : eg });
      const others = la.scored.filter(x => x.word !== m.word && x.eg < LOOK_INF)
        .map(x => Object.assign({}, la.info.get(x.word), { eg: x.eg }));
      rankPos = 1 + others.filter(o => byLook(o, me) < 0).length;
      total = others.length + 1;
    } else {
      for (const e of all) if (byValue(e, st) < 0) rankPos++;
    }
    postMessage({
      type: 'analysis', word: m.word, token: m.token,
      stats: { word: m.word, H: st.H, exp: st.exp, worst: st.worst, isCand: st.isCand,
               rank: rankPos, total, eg, look: !!la, guarantee: la ? la.guarantee : true,
               inSolutions: IDX.has(m.word), validGuess: IDX.has(m.word) || XIDX.has(m.word),
               hardOk: hard ? hardOkWord(m.word, hard) : true },
      groups: groupsFor(m.word, cand, showHist)
    });
  }
};
