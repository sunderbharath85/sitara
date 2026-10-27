import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initBackend } from "./lib/api";

initBackend().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
