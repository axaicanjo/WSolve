# Wordle Solver

An offline-capable web app (PWA) that solves Wordle against the **Expanded Wordle Solution List** —
the 2,315 original answers plus 174 curated additions (2,489 words total).

Install it on an iPhone home screen and it runs fullscreen, with no browser chrome and no network.

## How to use it

1. Type your guess on the on-screen keyboard.
2. Tap each letter tile to set its colour: **grey → yellow → green → grey**.
3. Press **ENTER**. The app shows how many words are still possible, lists them, and ranks the
   best next guesses by information gain (entropy).
4. Tap a suggested word to see the colour-pattern groups it would split the pool into; tap **USE**
   to load it as your next guess.
5. Repeat. When you're done, tap **"… was the solution — finish"**. (An all-green row finishes
   automatically.)

**Undo** removes the last guess (or clears the row you're typing). **New** starts a fresh puzzle.

Words with a green outline are the 174 added candidates — words that were never official
Wordle answers. CAPON, TWEEN and INTEL were added on 1 Sep 2026.

## Answer history and "Use Historic Info"

The NYT began **recycling old answers on 2 Feb 2026** — the first repeat was CIGAR, the very
first puzzle. Known repeats since include HASTY (Apr 2022 → Mar 2026), SANDY (Oct 2024 →
Apr 2026) and BATON (Dec 2021 → Jul 2026), so roughly 3% of answers are now repeats and the
gap has never been shorter than about 18 months.

The app uses that. Once it has the answer archive, the candidate list is always split into:

- **Never been an answer** — listed alphabetically;
- **Previously an answer** — listed oldest use first, each with the date it was used.

Every word carries its probability of being today's answer:

```
never used:      (1 − ρ) / (number of never-used candidates)
previously used:  ρ · ageWeight(w) / Σ ageWeight
ageWeight(a days since last use) = max(0, a − 365) + 0.05 · min(a, 365)
```

ρ defaults to 3% and is adjustable in the app from 0 to 25%. The 365-day cooldown reflects the
observed gap; the 0.05 tail keeps a recently-used word merely unlikely rather than impossible,
since the cooldown is inferred from a handful of repeats, not a published rule.

The **Use Historic Info** toggle controls only the *ranking*. Off, suggestions are ranked by plain
entropy with every candidate equally likely — identical to the solver without this feature. On,
the entropy is computed over the weighted distribution above, so the app stops spending
information on words it thinks are unlikely to come up. The list ordering and the percentages are
shown either way.

### Where the history comes from

`past.json` holds one answer per puzzle number, index 0 = 19 Jun 2021.

**It deliberately stops at yesterday.** Today's answer is never written to the file and is ignored
if it somehow appears there. Otherwise the solver would find today's word already in the archive,
age it at zero days, and weight it down to nothing — ruling out the one word that is correct. The
file is public, so storing it would also spoil the puzzle for anyone who opened it.

Two things keep the file current:

1. **The app**, each time it opens, asks the NYT's own endpoint
   (`nytimes.com/svc/wordle/v2/YYYY-MM-DD.json`) for any recent days the file is missing, and
   caches what it learns in the browser.
2. **A GitHub Action** (`.github/workflows/wordle-history.yml`) runs daily at 09:10 UTC and
   commits the day's answer to `past.json`. It is one self-contained file — the fetching script
   is embedded in it, so nothing else needs to be present for it to work.

**Run the backfill once, after your first push:** GitHub → **Actions** → *Update Wordle answer
history* → **Run workflow** → tick **backfill** → Run. It walks every date since launch (~1,900
requests, a few minutes) and commits the complete file. Until you do, the history section will say
it has nothing loaded.

If the NYT endpoint turns out not to allow browser (cross-origin) requests, step 1 silently does
nothing and the workflow is what keeps the file fresh — the app will show "from file" rather than
"live". If instead you'd rather not use Actions at all, the app has a **Fetch history from the NYT
now** button that pulls the whole archive directly into the browser; that only works if
cross-origin requests are allowed.

## Deploying to GitHub Pages

From this folder:

```bash
git remote add origin https://github.com/<your-username>/wordle-solver.git
git branch -M main
git push -u origin main
```

Then on github.com: **Settings → Pages → Source: Deploy from a branch → Branch: `main` / `(root)` → Save.**

After a minute the app is live at:

```
https://<your-username>.github.io/wordle-solver/
```

The repo can be private only on a paid GitHub plan; on the free plan a Pages site requires a
public repo. Nothing here is sensitive.

### Add to your iPhone home screen

1. Open the Pages URL in **Safari** (not Chrome — only Safari can install to the home screen).
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Launch it from the icon. It runs fullscreen and works offline after the first load.

To pick up a later update, open the app, then close it fully and reopen — the service worker
refreshes cached files in the background. To force it, bump `CACHE` in `sw.js`.

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup and styles |
| `app.js` | UI: board, keyboard, panels |
| `worker.js` | Solver in a Web Worker — pattern matrix, filtering, entropy ranking |
| `words.js` | The 2,489-word list (concatenated, 5 chars each) + indices of the 174 added words |
| `past.json` | Dated archive of Wordle answers, one per puzzle number |
| `.github/workflows/wordle-history.yml` | Self-contained daily task that rewrites `past.json`; `backfill` input seeds it |
| `scripts/update-history.mjs` | The same script as a standalone file, if you'd rather run it by hand |
| `sw.js` | Service worker for offline use |
| `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png` | Home-screen install metadata |

## How the solver works

On load, the worker precomputes the full 2,489 × 2,489 feedback matrix (~6 MB) — every possible
guess against every possible answer, encoded as one of 243 colour patterns. Duplicate letters are
scored exactly as the real game does: greens claim their letter first, then yellows consume the
remaining copies left to right.

After each clue, the candidate set is filtered to words that would have produced the exact pattern
you entered. Every one of the 2,489 words is then scored by the Shannon entropy of the partition
it induces on the remaining candidates; ties go to a word that could itself be the answer.

Measured over 300 simulated games starting from RAISE: **3.51 guesses on average, worst case 5,
zero failures.**

Best openers by entropy: RAISE (5.883 bits), SLATE (5.847), ARISE (5.820), IRATE (5.817),
STARE (5.803).
