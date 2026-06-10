// ─────────────────────────────────────────────────────────────
// SpinStack cross-device sync (Stage A, v2 — gated startup)
//
// Key fix vs v1: we PULL your cloud data into localStorage BEFORE
// the React app boots (see startSync() called from main.jsx), and
// we only start PUSHING after that pull finishes. This prevents the
// app's default startup state from overwriting your synced data.
// ─────────────────────────────────────────────────────────────
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://ietqxkurqiigmniimbab.supabase.co";
const SUPABASE_KEY = "sb_publishable_c5CVuaR4k4xNohC_Pc2fyA_8GoQy1jC";
const TABLE = "user_state";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// Shared client for the app (login UI, auth state) — one client, one session.
export { supabase };

const rawSet = localStorage.setItem.bind(localStorage);
let pushReady = false; // only push after the initial pull/seed
let pushTimer = null;
let currentSession = null;
let statusEl = null;
let panel = null;

function snapshot() {
  const o = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && !k.startsWith("sb-")) o[k] = localStorage.getItem(k);
  }
  return o;
}

async function push() {
  if (!currentSession) return;
  const { error } = await supabase.from(TABLE).upsert({
    user_id: currentSession.user.id,
    data: snapshot(),
    updated_at: new Date().toISOString(),
  });
  setStatus(error ? "Sync error" : "Synced ✓", error ? "#f87171" : "#5eead4");
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, 1200);
}

// Manual push hook for the app (e.g., after a swipe). Gated exactly like the
// automatic mirror: never push before the initial pull, or we'd reintroduce
// the default-state-overwrites-cloud race that v2 fixed.
export function pushToCloud() {
  if (pushReady && currentSession) schedulePush();
}

// Mirror every app write to the cloud (debounced) — but only once pull is done.
localStorage.setItem = (k, v) => {
  rawSet(k, v);
  if (pushReady && currentSession && k && !k.startsWith("sb-")) schedulePush();
};

async function pullIntoLocal() {
  const { data, error } = await supabase
    .from(TABLE).select("data").eq("user_id", currentSession.user.id).maybeSingle();
  if (error) return false;
  if (data && data.data && Object.keys(data.data).length) {
    for (const [k, v] of Object.entries(data.data)) rawSet(k, v);
    return true;
  }
  return false;
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
}

// Called by main.jsx BEFORE React renders. Resolves once localStorage
// holds the right data (or quickly, if logged out / offline).
export async function startSync() {
  try {
    const res = await withTimeout(supabase.auth.getSession(), 3500, { data: { session: null } });
    currentSession = res?.data?.session || null;
  } catch (_) {
    currentSession = null;
  }

  if (currentSession) {
    const applied = await withTimeout(pullIntoLocal(), 3500, false);
    if (!applied) await push().catch(() => {}); // first login → seed cloud from this device
    pushReady = true;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildUI);
  } else {
    buildUI();
  }
}

// Keep the control in sync with auth changes (sign out, token refresh).
// We do NOT pull/reload here — startSync() owns the initial load, and the
// magic-link return is a full page load that re-runs startSync().
supabase.auth.onAuthStateChange((event, session) => {
  const wasSignedIn = !!currentSession;
  currentSession = session || null;
  if (statusEl) renderAuth();
  // If a brand-new sign-in happened in THIS tab (no full reload), reload once
  // so the app boots through startSync() with the pulled data.
  if (event === "SIGNED_IN" && !wasSignedIn && !sessionStorage.getItem("ss_boot")) {
    sessionStorage.setItem("ss_boot", "1");
    location.reload();
  }
  if (event === "SIGNED_OUT") sessionStorage.removeItem("ss_boot");
});

// ── floating control (bottom-left) ──
function setStatus(text, color) {
  if (statusEl) { statusEl.textContent = text; statusEl.style.color = color || "#9ca3af"; }
}

function mkBtn(label) {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText =
    "width:100%;padding:8px;border-radius:8px;border:1px solid #1f2937;" +
    "background:#111827;color:#5eead4;cursor:pointer;margin-top:6px;";
  return b;
}

let wrap = null;
function buildUI() {
  if (wrap) return; // build exactly once
  wrap = document.createElement("div");
  wrap.style.cssText =
    "position:fixed;left:10px;bottom:10px;z-index:99999;font:12px/1.4 system-ui,sans-serif;";

  const btn = document.createElement("button");
  btn.textContent = "☁ Sync";
  btn.style.cssText =
    "background:#0b0f14;color:#5eead4;border:1px solid #1f2937;border-radius:999px;" +
    "padding:6px 12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4);";
  wrap.appendChild(btn);

  panel = document.createElement("div");
  panel.style.cssText =
    "display:none;margin-top:8px;background:#0b0f14;border:1px solid #1f2937;border-radius:12px;" +
    "padding:12px;width:230px;box-shadow:0 6px 24px rgba(0,0,0,.5);color:#e5e7eb;";
  wrap.appendChild(panel);
  btn.onclick = () => { panel.style.display = panel.style.display === "none" ? "block" : "none"; };

  document.body.appendChild(wrap);
  renderAuth();
}

// Fully synchronous rebuild — no async appends, so it can never duplicate.
function renderAuth() {
  if (!panel) return;
  panel.replaceChildren();

  statusEl = document.createElement("div");
  statusEl.style.cssText = "margin-bottom:8px;";
  panel.appendChild(statusEl);

  if (currentSession) {
    setStatus("Synced ✓", "#5eead4");
    const who = document.createElement("div");
    who.style.cssText = "color:#9ca3af;margin-bottom:4px;font-size:11px;";
    who.textContent = currentSession.user.email;
    panel.appendChild(who);

    const now = mkBtn("Sync now");
    now.onclick = () => push();
    const out = mkBtn("Sign out");
    out.onclick = async () => { await supabase.auth.signOut(); };
    panel.appendChild(now);
    panel.appendChild(out);
  } else {
    setStatus("Sign in to sync across devices", "#9ca3af");
    const email = document.createElement("input");
    email.type = "email";
    email.placeholder = "your email";
    email.style.cssText =
      "width:100%;box-sizing:border-box;padding:8px;border-radius:8px;" +
      "border:1px solid #1f2937;background:#111827;color:#e5e7eb;";
    panel.appendChild(email);

    const send = mkBtn("Email me a login link");
    send.onclick = async () => {
      if (!email.value.trim()) return;
      send.textContent = "Sending…";
      const { error } = await supabase.auth.signInWithOtp({
        email: email.value.trim(),
        options: { emailRedirectTo: location.origin },
      });
      send.textContent = error ? "Error — retry" : "Check your email ✉";
    };
    panel.appendChild(send);
  }
}
