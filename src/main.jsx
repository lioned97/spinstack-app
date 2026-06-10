import React from "react";
import ReactDOM from "react-dom/client";
import App from "./spinstack-v5.jsx";

// Cross-device sync. startSync() pulls your cloud data into localStorage
// BEFORE the app renders, so SpinStack boots with your synced state.
import { startSync } from "./cloudsync.js";

function render() {
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

// Never let sync block the UI for more than its internal timeout.
startSync().catch(() => {}).finally(render);

// Service worker → installable standalone PWA.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) =>
      console.warn("SW registration failed:", err)
    );
  });
}
