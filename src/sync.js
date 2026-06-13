// ─────────────────────────────────────────────────────────────
// SpinStack v2 sync — one shared Supabase row, no login.
//
// Every device reads/writes the same row (SHARED_ID). On boot we
// PULL and MERGE the cloud row into localStorage BEFORE React
// renders; afterwards every local write schedules a debounced
// PUSH of the merged snapshot. Merges are field-aware (unions for
// sets, max for counters/timestamps) so two devices can't clobber
// each other's saves even if they swipe offline at the same time.
//
// Plain fetch against PostgREST — no supabase-js dependency.
// ─────────────────────────────────────────────────────────────

const SUPABASE_URL = "https://ietqxkurqiigmniimbab.supabase.co";
const SUPABASE_KEY = "sb_publishable_c5CVuaR4k4xNohC_Pc2fyA_8GoQy1jC"; // public anon key
const SHARED_ID = "1d8bb4fc-0d6e-499b-82b3-afc5be7e9337"; // your devices' shared row
const ENDPOINT = `${SUPABASE_URL}/rest/v1/shared_state`;

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

// localStorage keys that participate in sync (everything app-owned).
export const SYNC_KEYS = [
  "ss2_saved", // {id: paper} — papers you kept
  "ss2_skipped", // {id: true} — papers you dismissed
  "ss2_topics", // [{id, name, category?, addedAt, updatedAt?, hidden?, deleted?,
  //                 sources?: string[], arxivCat?, keywords?}]
  //               category missing = science; deleted = tombstone (kept so
  //               the per-name union can't resurrect removed topics);
  //               sources/arxivCat/keywords steer both live search and the
  //               daily harvester (read from this row)
  "ss2_affinity", // {topics:{name:weight}, authors:{name:weight}}
  "ss2_analyses", // {paperId: {text, at}} — Claude "why this matters" cache
  "ss2_settings", // {uiMode, harvestUrl, ...}
  "ss2_annot", // {paperId: [{id, page, quote, prefix, suffix, color, note?, deleted?, at}]}
  "ss2_chats", // {paperId: [{role, text, at}]} — paper chat history, capped 60/paper
  "ss2_ink", // {paperId: [{id, page: n|"board", color, w, pts, deleted?, at}]} — drawings
  "ss2_last_seen", // ISO timestamp — newest harvest the user has seen
  "ss2_swipe_log", // [{id, kept, at}] capped log
];

const sGet = (k, fallback) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
};
const sSetRaw = (k, v) => {
  // never let a QuotaExceededError (or private-mode block) bubble into a
  // React render and white-screen the app — the cloud row is the source
  // of truth anyway.
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch (e) {
    console.warn("sync: local write failed for", k, e && e.name);
  }
};

let pushTimer = null;
let pullDone = false;
let statusListener = null;
let lastStatus = "syncing";

export function onSyncStatus(fn) {
  statusListener = fn;
  fn(lastStatus); // deliver current state to late subscribers (React mounts after pull)
}
function emit(status) {
  lastStatus = status;
  if (statusListener) statusListener(status);
}

// ── field-aware merge of two snapshots ──
function mergeSnapshots(local, remote) {
  const out = {};

  // saved: union by paper id, newer savedAt wins per id
  const sl = local.ss2_saved || {};
  const sr = remote.ss2_saved || {};
  const saved = { ...sr };
  for (const [id, p] of Object.entries(sl)) {
    if (!saved[id] || (p.savedAt || "") > (saved[id].savedAt || "")) saved[id] = p;
  }
  out.ss2_saved = saved;

  // skipped: union — but a paper saved anywhere is never skipped
  out.ss2_skipped = { ...(remote.ss2_skipped || {}), ...(local.ss2_skipped || {}) };
  for (const id of Object.keys(out.ss2_skipped)) {
    if (saved[id]) delete out.ss2_skipped[id];
  }

  // topics: union by lowercase name, per-name newest-wins on updatedAt
  // (preserves hidden flags + renames; missing updatedAt = epoch, so any
  // edited copy beats an untouched one; ties go to local)
  const topicMap = new Map();
  for (const t of [...(remote.ss2_topics || []), ...(local.ss2_topics || [])]) {
    if (!t || !t.name) continue;
    const k = t.name.toLowerCase();
    const prev = topicMap.get(k);
    if (!prev || (t.updatedAt || "") >= (prev.updatedAt || "")) topicMap.set(k, t);
  }
  out.ss2_topics = [...topicMap.values()];

  // affinity: per key, keep the value with larger magnitude
  // (learning accumulates; magnitude ≈ how much evidence that device saw)
  const mergeWeights = (a = {}, b = {}) => {
    const m = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (!(k in m) || Math.abs(v) > Math.abs(m[k])) m[k] = v;
    }
    return m;
  };
  const al = local.ss2_affinity || {};
  const ar = remote.ss2_affinity || {};
  out.ss2_affinity = {
    topics: mergeWeights(ar.topics, al.topics),
    authors: mergeWeights(ar.authors, al.authors),
  };

  // analyses: union by paper id, newer wins
  const anl = local.ss2_analyses || {};
  const anr = remote.ss2_analyses || {};
  const analyses = { ...anr };
  for (const [id, a] of Object.entries(anl)) {
    if (!analyses[id] || (a.at || "") > (analyses[id].at || "")) analyses[id] = a;
  }
  out.ss2_analyses = analyses;

  // annotations: per-paper union by annotation id, newer `at` wins on
  // conflict (removals are `deleted` tombstones so they survive the
  // union), cap 300 per paper
  const annot = { ...(remote.ss2_annot || {}) };
  for (const [pid, list] of Object.entries(local.ss2_annot || {})) {
    const byId = new Map((annot[pid] || []).map((a) => [a.id, a]));
    for (const a of list || []) {
      const prev = byId.get(a.id);
      if (!prev || (a.at || "") >= (prev.at || "")) byId.set(a.id, a);
    }
    annot[pid] = [...byId.values()]
      .sort((x, y) => (x.at || "").localeCompare(y.at || ""))
      .slice(-300);
  }
  out.ss2_annot = annot;

  // ink strokes: same scheme as annotations — per-paper union by stroke
  // id, newer at wins (deletions are tombstones), cap 300 per paper
  const inkAll = { ...(remote.ss2_ink || {}) };
  for (const [pid, list] of Object.entries(local.ss2_ink || {})) {
    const byId = new Map((inkAll[pid] || []).map((s) => [s.id, s]));
    for (const s of list || []) {
      const prev = byId.get(s.id);
      if (!prev || (s.at || "") >= (prev.at || "")) byId.set(s.id, s);
    }
    inkAll[pid] = [...byId.values()]
      .sort((x, y) => (x.at || "").localeCompare(y.at || ""))
      .slice(-300);
  }
  out.ss2_ink = inkAll;

  // chats: per-paper union by (at, role), sorted by at, cap 60
  const chats = { ...(remote.ss2_chats || {}) };
  for (const [pid, list] of Object.entries(local.ss2_chats || {})) {
    const byKey = new Map((chats[pid] || []).map((m) => [`${m.at}|${m.role}`, m]));
    for (const m of list || []) byKey.set(`${m.at}|${m.role}`, m);
    chats[pid] = [...byKey.values()]
      .sort((x, y) => (x.at || "").localeCompare(y.at || ""))
      .slice(-60);
  }
  out.ss2_chats = chats;

  // settings: newer updatedAt wins wholesale
  const setl = local.ss2_settings || {};
  const setr = remote.ss2_settings || {};
  out.ss2_settings = (setl.updatedAt || "") >= (setr.updatedAt || "") ? setl : setr;

  // last_seen: max
  out.ss2_last_seen =
    (local.ss2_last_seen || "") > (remote.ss2_last_seen || "")
      ? local.ss2_last_seen
      : remote.ss2_last_seen;

  // swipe log: union by (id, at), keep newest 500
  const seen = new Set();
  out.ss2_swipe_log = [...(local.ss2_swipe_log || []), ...(remote.ss2_swipe_log || [])]
    .filter((e) => {
      const key = `${e.id}|${e.at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.at || "").localeCompare(a.at || ""))
    .slice(0, 500);

  return out;
}

function localSnapshot() {
  const o = {};
  for (const k of SYNC_KEYS) {
    const v = sGet(k, undefined);
    if (v !== undefined) o[k] = v;
  }
  return o;
}

function applySnapshot(snap) {
  for (const k of SYNC_KEYS) {
    if (snap[k] !== undefined) sSetRaw(k, snap[k]);
  }
}

// ── pull: fetch cloud row, merge into localStorage ──
export async function pull() {
  try {
    const res = await fetch(`${ENDPOINT}?id=eq.${SHARED_ID}&select=data`, {
      headers: HEADERS,
    });
    if (!res.ok) throw new Error(`pull ${res.status}`);
    const rows = await res.json();
    const remote = rows[0]?.data || {};
    const merged = mergeSnapshots(localSnapshot(), remote);
    applySnapshot(merged);
    pullDone = true;
    emit("synced");
    return true;
  } catch (err) {
    // Offline or DB unreachable — proceed with local state, push later.
    pullDone = true; // local-first: don't block writes forever
    emit(navigator.onLine ? "error" : "offline");
    return false;
  }
}

// ── push: upsert merged snapshot (pull-merge-push to be race-safe) ──
async function pushNow() {
  if (!pullDone) {
    schedulePush(); // boot pull still in flight — retry, don't drop the write
    return;
  }
  if (!navigator.onLine) {
    emit("offline");
    return;
  }
  emit("syncing");
  try {
    // Re-pull right before pushing so we never overwrite a newer row.
    const res = await fetch(`${ENDPOINT}?id=eq.${SHARED_ID}&select=data`, {
      headers: HEADERS,
    });
    const rows = res.ok ? await res.json() : [];
    const remote = rows[0]?.data || {};
    const merged = mergeSnapshots(localSnapshot(), remote);
    applySnapshot(merged);

    const up = await fetch(`${ENDPOINT}?on_conflict=id`, {
      method: "POST",
      headers: { ...HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        id: SHARED_ID,
        data: merged,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!up.ok) throw new Error(`push ${up.status}`);
    emit("synced");
  } catch {
    emit(navigator.onLine ? "error" : "offline");
  }
}

export function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 1500);
}

// Flush queued changes the moment we come back online.
window.addEventListener("online", () => {
  emit("syncing");
  schedulePush();
});
window.addEventListener("offline", () => emit("offline"));

// Persist helper for the app: write locally, then sync.
export function persist(key, value) {
  sSetRaw(key, value);
  schedulePush();
}

export { sGet };
