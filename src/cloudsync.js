// ─────────────────────────────────────────────────────────────
// SpinStack cross-device sync (Stage A)
// Self-contained: mirrors the app's localStorage to Supabase and
// pulls it back on login. Does NOT touch spinstack-v5.jsx.
//
// How it works:
//  • You log in with a magic link (passwordless email).
//  • On login it pulls your saved state blob from Supabase into
//    localStorage and reloads once so the app shows it.
//  • Any later change the app writes to localStorage is debounced
//    and pushed back up. Last-write-wins across devices.
// ─────────────────────────────────────────────────────────────
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://ietqxkurqiigmniimbab.supabase.co";
const SUPABASE_KEY = "sb_publishable_c5CVuaR4k4xNohC_Pc2fyA_8GoQy1jC";
const TABLE = "user_state";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const rawSet = localStorage.setItem.bind(localStorage);
let authed = false;
let pushTimer = null;

// ── full snapshot of app data (skip Supabase's own auth keys) ──
function snapshot() {
  const o = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && !k.startsWith("sb-") && k !== "ss_synced") o[k] = localStorage.getItem(k);
  }
  return o;
}

async function push() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase.from(TABLE).upsert({
    user_id: user.id, data: snapshot(), updated_at: new Date().toISOString(),
  });
  setStatus(error ? "Sync error" : "Synced ✓", error ? "#f87171" : "#5eead4");
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, 1500);
}

// Intercept every app write so changes sync automatically.
localStorage.setItem = (k, v) => {
  rawSet(k, v);
  if (authed && k && !k.startsWith("sb-")) schedulePush();
};

async function pullThenWatch(user) {
  setStatus("Syncing…", "#fbbf24");
  const { data, error } = await supabase
    .from(TABLE).select("data").eq("user_id", user.id).maybeSingle();
  if (error) { setStatus("Sync error", "#f87171"); return; }

  if (data && data.data && Object.keys(data.data).length) {
    let changed = false;
    for (const [k, v] of Object.entries(data.data)) {
      if (localStorage.getItem(k) !== v) { rawSet(k, v); changed = true; }
    }
    // Reload once so React re-reads the freshly synced data.
    if (changed && !sessionStorage.getItem("ss_synced")) {
      sessionStorage.setItem("ss_synced", "1");
      location.reload();
      return;
    }
  } else {
    // First login on this account: seed the cloud with current local data.
    await push();
  }
  setStatus("Synced ✓", "#5eead4");
}

// ── tiny floating login/status control (bottom-left) ──
let statusEl, panel;
function setStatus(text, color) {
  if (statusEl) { statusEl.textContent = text; statusEl.style.color = color || "#9ca3af"; }
}

function buildUI() {
  const wrap = document.createElement("div");
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

  statusEl = document.createElement("div");
  statusEl.style.cssText = "margin-bottom:8px;color:#9ca3af;";
  statusEl.textContent = "Not signed in";
  panel.appendChild(statusEl);

  renderAuth();
  document.body.appendChild(wrap);
}

function renderAuth() {
  // clear everything after the status line
  while (panel.children.length > 1) panel.removeChild(panel.lastChild);

  supabase.auth.getSession().then(({ data: { session } }) => {
    if (session) {
      authed = true;
      statusEl.textContent = "Synced ✓";
      statusEl.style.color = "#5eead4";
      const who = document.createElement("div");
      who.style.cssText = "color:#9ca3af;margin-bottom:8px;font-size:11px;";
      who.textContent = session.user.email;
      const out = mkBtn("Sign out");
      out.onclick = async () => {
        await supabase.auth.signOut();
        sessionStorage.removeItem("ss_synced");
        authed = false; renderAuth();
      };
      const now = mkBtn("Sync now");
      now.style.marginBottom = "6px";
      now.onclick = () => push();
      panel.appendChild(who); panel.appendChild(now); panel.appendChild(out);
    } else {
      authed = false;
      statusEl.textContent = "Sign in to sync across devices";
      statusEl.style.color = "#9ca3af";
      const email = document.createElement("input");
      email.type = "email"; email.placeholder = "your email";
      email.style.cssText =
        "width:100%;box-sizing:border-box;margin-bottom:8px;padding:8px;border-radius:8px;" +
        "border:1px solid #1f2937;background:#111827;color:#e5e7eb;";
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
      panel.appendChild(email); panel.appendChild(send);
    }
  });
}

function mkBtn(label) {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText =
    "width:100%;padding:8px;border-radius:8px;border:1px solid #1f2937;" +
    "background:#111827;color:#5eead4;cursor:pointer;";
  return b;
}

supabase.auth.onAuthStateChange((event, session) => {
  if (session && session.user) {
    authed = true;
    if (statusEl) renderAuth();
    pullThenWatch(session.user);
  } else {
    authed = false;
    if (statusEl) renderAuth();
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", buildUI);
} else {
  buildUI();
}
