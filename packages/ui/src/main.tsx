import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./fonts.js";
import "./tokens/tokens.css";
import "./base.css";
import { App } from "./App.js";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
