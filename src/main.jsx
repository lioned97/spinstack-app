import React from "react";
import ReactDOM from "react-dom/client";

// Cross-device sync layer (self-contained; does not modify the app).
import "./cloudsync.js";

// Your full app. After you upload spinstack-v5.jsx into this same /src folder,
// this import picks it up. The file must end with `export default <Component>`.
import App from "./spinstack-v5.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register the service worker so SpinStack installs as a standalone PWA.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) =>
      console.warn("SW registration failed:", err)
    );
  });
}
