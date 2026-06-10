# spinstack-app (v2)

Tinder-for-papers PWA for NV-center research. Feed/swipe toggle, swipe
learning, daily harvest feed, Gemini summaries (pre-generated), Claude
"why this matters" on demand, no-login cross-device sync.

## One-time setup
1. **Supabase** — open SQL Editor, paste `setup.sql`, Run.
2. **Vercel** — Project → Settings → Environment Variables, add:
   - `ANTHROPIC_API_KEY` = your key from https://console.anthropic.com
   (optional: `ANTHROPIC_MODEL` to override the default Haiku model)
   Then redeploy once so the function picks it up.
3. Upload this repo's files to GitHub `main` — Vercel auto-deploys.
4. On your phone: open the Vercel URL → "Add to Home Screen". Same on
   desktop Chrome via the install icon in the address bar.

## Notes
- Sync: all devices share one DB row (`SHARED_ID` in `src/sync.js`).
  No login means anyone who reads your site's JS could find that ID —
  fine for a personal tool, but don't post the URL publicly.
- Old files from v1 (`src/spinstack-v5.jsx`, `src/cloudsync.js`) are not
  imported by v2 and won't affect the build; delete them when convenient.
- Offline: the app shell and last feed are cached; swipes made offline
  sync automatically when you reconnect.
