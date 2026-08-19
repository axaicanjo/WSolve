# Wordle Solver

An offline-capable web app (PWA) that solves Wordle against the **Expanded Wordle Solution List** —
the 2,315 original answers plus the 143 curated additions (2,458 words total).

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

Words with a green outline are the 143 added candidates — words that were never official
Wordle answers.

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
| `words.js` | The 2,458-word list (concatenated, 5 chars each) + indices of the 143 added words |
| `sw.js` | Service worker for offline use |
| `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png` | Home-screen install metadata |

## How the solver works

On load, the worker precomputes the full 2,458 × 2,458 feedback matrix (~6 MB) — every possible
guess against every possible answer, encoded as one of 243 colour patterns. Duplicate letters are
scored exactly as the real game does: greens claim their letter first, then yellows consume the
remaining copies left to right.

After each clue, the candidate set is filtered to words that would have produced the exact pattern
you entered. Every one of the 2,458 words is then scored by the Shannon entropy of the partition
it induces on the remaining candidates; ties go to a word that could itself be the answer.

Measured over 300 simulated games starting from RAISE: **3.51 guesses on average, worst case 5,
zero failures.**

Best openers by entropy: RAISE (5.883 bits), SLATE (5.847), ARISE (5.820), IRATE (5.817),
STARE (5.803).
