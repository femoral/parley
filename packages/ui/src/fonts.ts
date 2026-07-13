/*
 * Self-hosted fonts (design-manifest §2.9 / §7). Vite fingerprints the woff2 into
 * the bundle's `assets/`, so the cockpit works fully offline — nothing is ever
 * fetched from a CDN at runtime. Only the weights/styles the manifest actually
 * uses are loaded.
 */
// Cinzel — engraved caps (titles, headers, tabs, buttons): 500 / 700 / 900.
import "@fontsource/cinzel/500.css";
import "@fontsource/cinzel/700.css";
import "@fontsource/cinzel/900.css";
// IM Fell English — flavour lines & questions: regular + italic.
import "@fontsource/im-fell-english/400.css";
import "@fontsource/im-fell-english/400-italic.css";
// Outfit — default HUD text: 300–700.
import "@fontsource/outfit/300.css";
import "@fontsource/outfit/400.css";
import "@fontsource/outfit/500.css";
import "@fontsource/outfit/600.css";
import "@fontsource/outfit/700.css";
// JetBrains Mono — logs, ids, numerals: 400 / 500.
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
