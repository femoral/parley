import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./fonts.js";
import "./tokens/tokens.css";
import "./base.css";
import { App } from "./App.js";

// Ship's log — a note for whoever opens the hold (dev tools). Flavor only;
// nothing operational lives here.
console.info(
  "%c⚓ Parley Cove%c — ship's log\n%cFair winds. The fleet reports in over live water; islands rise as voyages set out.\nOn deck: press N to sail to the crew that needs you, / to leaf through the roster.",
  "font-weight:700;font-size:14px;color:#f0c25a;",
  "color:#c9b184;",
  "font-style:italic;color:#967c54;",
);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
