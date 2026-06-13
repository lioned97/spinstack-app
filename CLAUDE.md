# CLAUDE.md — spinstack-app

SpinStack: a personal "Tinder-for-papers" PWA for NV-center / quantum-sensing
research. One user (Lion), installed on phone + desktop. React + Vite on
Vercel, auto-deploys from `main`.

## Architecture (do not break these)

- **No login.** All devices share ONE Supabase row. `src/sync.js` holds
  `SHARED_ID` + the publishable key (public by design). Sync = pull-merge
  on boot BEFORE render (`main.jsx` awaits `pull()` with 3.5 s timeout),
  then debounced pull-merge-push on every write. Merges are field-aware
  (unions for sets, newest-wins for settings). NEVER replace this with
  naive last-write-wins.
- **Any new persisted state** must be: (1) added to `SYNC_KEYS` in
  `src/sync.js`, (2) given a merge rule in `mergeSnapshots()`, (3) written
  via `persist(key, value)` — never raw `localStorage.setItem` (except
  `ss2_pool`, which is intentionally device-local).
- **Secrets never reach the browser.** AI calls with keys go through
  `/api/*` Vercel functions (`ANTHROPIC_API_KEY` env var, Production
  scope). Gemini runs only in the harvester repo.
- **Feed source:** `papers/latest.json` in lioned97/spinstack-harvest
  (raw GitHub URL, in settings). Shape:
  `{generatedAt, topics, count, papers:[{id,title,abstract,authors,year,
  venue,url,pdf?,source,arxivId?,doi?,harvestedAt,summary?,methods?}]}`.
- **Service worker** (`public/sw.js`): bump the `CACHE` name string on any
  SW change or users get stale caches. SW must never intercept `/api/`.
- **vercel.json** rewrite `/((?!api/).*) → /index.html` — keep `/api/`
  excluded or functions break.

## Build discipline

- Every import must exist in `package.json` (a missing dep broke prod
  once). Keep deps minimal: react, react-dom, lucide-react only.
- Before EVERY commit: `npm install && npx vite build` must pass.
- After push: Vercel auto-deploys `main`. Lion (or the architect chat,
  which has a Vercel connector — team `team_W9PH4VyAjTotly7ytuLHgps7`,
  project `prj_90Nmivd8ehfLL7393elx8n4qjziw`) verifies the deploy.

## Design system (src/styles.css)

Instrument-panel aesthetic. CSS vars on `:root`: `--bg --panel --panel-2
--line --ink --dim --red --teal`, mono readout labels (`--mono`) for
metadata/eyebrows, sans for body. Signature element: the ODMR-dip
relevance indicator (`OdmrDip` in App.jsx) — deeper dip = more relevant.
Keep it. New UI should use the existing vars so theming stays one-file.

## Conventions

- localStorage keys are prefixed `ss2_`.
- Timestamps are ISO strings (`nowISO()`).
- Quality filtering exists in BOTH app (`qualityFilter`) and harvester —
  keep them consistent if rules change.
- Commit style: short imperative, e.g. `phase A: dark mode + feed sort`.
