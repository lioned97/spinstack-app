import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { pull } from "./sync.js";
import "./styles.css";

function render() {
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

// Pull + merge the shared cloud row BEFORE first render, with a hard
// timeout so a slow network can never block the UI.
const timeout = new Promise((r) => setTimeout(r, 3500));
Promise.race([pull(), timeout]).finally(render);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("SW failed:", err));
  });
}
