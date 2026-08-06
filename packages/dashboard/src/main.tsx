import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./fonts.css";
import "./tokens.css";
import "./base.css";
import "./shell.css";
import { App } from "./App.js";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
