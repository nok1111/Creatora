import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/app/App";
import "@/i18n";
import "@fontsource-variable/inter";
import "@/index.css";

// With Tauri's native drop handler disabled (required for HTML5 DnD on
// Windows), OS file drops reach the DOM — always cancel them so WebView2
// does not navigate to the dropped file. LibraryPage consumes them.
for (const type of ["dragover", "drop"]) {
  window.addEventListener(type, (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (dt?.types.includes("Files")) e.preventDefault();
  });
}

if (import.meta.env.DEV) {
  void import("@/lib/fx/dev-probe").then((m) => {
    m.installFxProbe();
    void m.installQaHandle();
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
