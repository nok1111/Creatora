import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/app/App";
import "@/i18n";
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
