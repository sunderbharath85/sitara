import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initBackend } from "./lib/api";
import { store } from "./lib/store";

// dev builds only: lets end-to-end tests drive the UI state directly
if (import.meta.env.DEV) Object.assign(window, { __sitara: { store } });

initBackend().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
