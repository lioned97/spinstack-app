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

## Phase A — manual checklist

After deploying, verify by hand:

- [ ] Theme toggle (Setup → Theme, AUTO/DARK/LIGHT) switches the palette
      and persists across reload; AUTO follows the system preference.
- [ ] "Re-run search" (Stack empty state or Setup → Maintenance) adds
      papers on a fresh profile and toasts the count.
- [ ] Sort chips above the feed (RELEVANCE/NEWEST/YEAR) reorder cards;
      choice persists. Swipe deck stays relevance-ordered.
- [ ] Hiding a topic (eye icon in Topics) removes its filter chip and its
      scoring boost from the feed; restore/rename/DEFAULT chip work.
- [ ] Topic filter chips (ALL + topics above the Stack) narrow the feed.
- [ ] Share works on every card — native sheet on mobile, the
      WhatsApp/Email/Copy fallback on desktop at minimum.
- [ ] Analyze failures appear in Vercel runtime logs as `analyze: …`.

## Notes
- Sync: all devices share one DB row (`SHARED_ID` in `src/sync.js`).
  No login means anyone who reads your site's JS could find that ID —
  fine for a personal tool, but don't post the URL publicly.
- Old files from v1 (`src/spinstack-v5.jsx`, `src/cloudsync.js`) are not
  imported by v2 and won't affect the build; delete them when convenient.
- Offline: the app shell and last feed are cached; swipes made offline
  sync automatically when you reconnect.
