/**
 * Issue #354 — shell chrome geometry + a11y + density proofs.
 *
 * Proves REQUIRED merge gates:
 * - geometry 1280/1460/1920, no board H-scroll
 * - axe in resting + find-popup-open + settings-open
 * - skip-to-main focus + Tab into content
 * - settings modal focus trap, aria-modal=true, zero tab stops behind
 * - footer doctrine note scrollWidth + text at 3 widths
 * - 1280 chrome density (no silent clip)
 * - live-region transcript (no bootstrap offline; restore after recover)
 *
 * `shellChromeGates` is the registry entry's gates() — screen tickets add
 * their own gates on their entries without editing check.mjs.
 */
import { pathToFileURL } from "node:url";
import { collectA11y, runAxe, ariaSnapshot } from "../lib/a11y.mjs";
import { measureChromeContrast } from "../lib/contrast.mjs";
import {
  ledgerDirs,
  readLedger,
  writeDemoProof,
  printRectSummary,
} from "../lib/ledger.mjs";
import { measureAtViewports, DEFAULT_SELECTORS } from "../lib/measure.mjs";
import { openVerifySession } from "../lib/session.mjs";

const TICKET = "issue-354";
const DEMO = "shell-chrome";

/**
 * Issue-354 merge gates for shell-chrome ledger proofs.
 * Registered on the DEMO_REGISTRY entry so screen tickets can add gates
 * without editing check.mjs.
 *
 * @param {object} _entry registry entry
 * @param {object} ledger full ledger entry.json for the ticket
 */
export function shellChromeGates(_entry, ledger) {
  const chrome = ledger.demos?.["shell-chrome"];
  if (!chrome) throw new Error("shell-chrome: missing demo in ledger");

  if (!chrome.headline?.boardScroll?.shell?.noHorizontalScroll) {
    throw new Error("shell-chrome: board horizontal scroll at 1280 not proven clear");
  }
  if (chrome.headline?.headerHeight !== 46) {
    throw new Error(
      `shell-chrome: expected header height 46, got ${chrome.headline?.headerHeight}`,
    );
  }
  if (!chrome.comboboxAria || chrome.comboboxAria.role !== "combobox") {
    throw new Error("shell-chrome: combobox ARIA role missing");
  }
  if (!chrome.a11y?.keyboardWalk?.leftBody) {
    throw new Error("shell-chrome: keyboard walk did not leave body");
  }

  // Axe in all three chrome states (resting, find popup, settings open).
  const byState = chrome.a11yByState ?? {};
  for (const state of ["resting", "findPopup", "settingsOpen"]) {
    const block = byState[state];
    if (!block?.axe) throw new Error(`shell-chrome: missing a11yByState.${state}`);
    const v = block.axe.violations ?? [];
    if (v.length > 0) {
      throw new Error(
        `shell-chrome: axe violations in ${state}: ${v.map((x) => x.id).join(", ")}`,
      );
    }
  }

  // #374 — every contrast probe must be found; missing class renames fail closed
  // (same pattern as #370 fleet chip / screen-title). Do not skip found:false.
  const contrast = chrome.contrast ?? {};
  for (const [cid, m] of Object.entries(contrast)) {
    if (!m?.found) {
      throw new Error(
        `shell-chrome: contrast probe missing ${cid}: ${JSON.stringify(m)}`,
      );
    }
    if (m.wcagAA === false) {
      throw new Error(`shell-chrome: contrast fail ${cid} ratio=${m.ratio}`);
    }
  }
  if (!chrome.stateEncoding?.allHaveLabels) {
    throw new Error("shell-chrome: legend missing text labels (hue-only state)");
  }

  // Footer doctrine note legible at all three widths — protects the
  // state-vs-quality vocabulary, not its deletion.
  const footer = chrome.footerNoteScroll;
  if (!Array.isArray(footer) || footer.length < 3) {
    throw new Error("shell-chrome: missing footerNoteScroll proofs");
  }
  for (const row of footer) {
    if (!row.ok) {
      throw new Error(
        `shell-chrome: footer note clipped at ${row.name}: ` +
          `scrollWidth=${row.scrollWidth} clientWidth=${row.clientWidth}`,
      );
    }
    const text = row.text ?? "";
    const fullDoctrine =
      text.includes("what a task IS") && text.includes("how good work WAS");
    const compactDoctrine = text.includes("state=IS") && text.includes("quality=WAS");
    if (!fullDoctrine && !compactDoctrine) {
      throw new Error(
        `shell-chrome: footer note missing state-vs-quality doctrine at ${row.name}: "${text}"`,
      );
    }
  }

  // 1280 density: no silent ellipsis amputation on measured chrome bits.
  if (!chrome.density1280?.allOk) {
    throw new Error(
      `shell-chrome: 1280 density clipping: ${JSON.stringify(chrome.density1280)}`,
    );
  }

  // Skip-to-main must land focus on #main-content.
  if (chrome.skipMain?.focusedId !== "main-content") {
    throw new Error(
      `shell-chrome: skip-main focus expected main-content, got ${chrome.skipMain?.focusedId}`,
    );
  }

  // #364 — focused skip links show complete labels
  const skipLabels = chrome.skipLinkLabels ?? [];
  if (skipLabels.length < 1) {
    throw new Error("shell-chrome: missing skipLinkLabels proof");
  }
  for (const row of skipLabels) {
    if (!row.fullLabel) {
      throw new Error(
        `shell-chrome: skip link label clipped: ${JSON.stringify(row)}`,
      );
    }
  }

  // Settings modal: focus moves in, restores to trigger, aria-modal=true.
  if (chrome.settingsFocus?.ariaModal !== "true") {
    throw new Error("shell-chrome: settings must be modal (aria-modal=true)");
  }
  if (!chrome.settingsFocus?.focusMovedIn) {
    throw new Error("shell-chrome: settings did not move focus into panel");
  }
  if (!chrome.settingsFocus?.focusRestored) {
    throw new Error("shell-chrome: settings did not restore focus to trigger");
  }
  if (
    typeof chrome.settingsFocus?.tabStopsBehind === "number" &&
    chrome.settingsFocus.tabStopsBehind > 0
  ) {
    throw new Error(
      `shell-chrome: tab stops reachable behind open dialog: ${chrome.settingsFocus.tabStopsBehind}`,
    );
  }

  // Live region: no bootstrap offline flash; restore announced after recover.
  const live = chrome.liveRegionTranscript;
  if (!live) throw new Error("shell-chrome: missing liveRegionTranscript");
  if (live.announcedOfflineOnHealthyBoot || live.offlineWhileLive) {
    throw new Error("shell-chrome: live region announced offline on healthy boot");
  }
  if (!live.announcedOfflineAfterLive) {
    throw new Error("shell-chrome: live region never announced offline after forced drop");
  }
  if (!live.announcedRestore) {
    throw new Error("shell-chrome: live region never announced connection restored");
  }
}

function describeFocus() {
  return {
    tag: document.activeElement?.tagName?.toLowerCase() ?? "null",
    id: document.activeElement?.id || null,
    testId: document.activeElement?.getAttribute?.("data-testid") ?? null,
    role: document.activeElement?.getAttribute?.("role") ?? null,
    text: (document.activeElement?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
  };
}

/**
 * @param {import('playwright-core').ElementHandle | import('playwright-core').Locator | null} _el
 * @param {import('playwright-core').Page} page
 * @param {string} selector
 */
async function scrollMetrics(page, selector) {
  return page.evaluate((sel) => {
    // Prefer the visible match (footer has full + compact doctrine notes).
    const all = [...document.querySelectorAll(sel)];
    const el =
      all.find((e) => {
        const cs = getComputedStyle(e);
        return cs.display !== "none" && cs.visibility !== "hidden";
      }) ?? all[0];
    if (!el) return { found: false, selector: sel };
    return {
      found: true,
      selector: sel,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      ok: el.scrollWidth <= el.clientWidth + 1,
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    };
  }, selector);
}

export async function runShellChromeDemo() {
  const session = await openVerifySession();
  try {
    const { taskId } = await session.daemon.stageScript("report-success");
    await session.daemon.waitTask(taskId);

    const { shotsDir } = ledgerDirs(TICKET);

    // ── Live region transcript during boot ───────────────────────────
    await session.page.setViewportSize({ width: 1460, height: 900 });
    await session.page.goto(session.url, { waitUntil: "domcontentloaded" });
    /** @type {Array<{t:number,text:string,phase:string|null}>} */
    const liveSamples = [];
    const bootStart = Date.now();
    for (let i = 0; i < 12; i += 1) {
      await session.page.waitForTimeout(80);
      const sample = await session.page.evaluate(() => {
        const live = document.querySelector('[data-testid="live-region"]');
        const phase = document.querySelector('[data-testid="live-status"]')?.getAttribute("data-phase");
        return {
          text: (live?.textContent ?? "").replace(/\u200b/g, "").trim(),
          phase: phase ?? null,
        };
      });
      liveSamples.push({ t: Date.now() - bootStart, ...sample });
    }
    await session.page.waitForSelector('[data-testid="shell"]');
    await session.page.evaluate(() => document.fonts.ready);
    // Wait until stream is live/empty (healthy boot).
    await session.page.waitForFunction(
      () => {
        const p = document.querySelector('[data-testid="live-status"]')?.getAttribute("data-phase");
        return p === "live" || p === "empty";
      },
      { timeout: 15_000 },
    ).catch(() => null);

    const announcedOfflineOnHealthyBoot = liveSamples.some(
      (s) =>
        /daemon offline/i.test(s.text) &&
        (s.phase === "live" || s.phase === "empty" || s.phase === "connecting" || s.phase === "loading"),
    );
    // Stricter: if we ever announced offline while phase was already live.
    const offlineWhileLive = liveSamples.some(
      (s) => /daemon offline/i.test(s.text) && (s.phase === "live" || s.phase === "empty"),
    );

    // ── Geometry at three widths ─────────────────────────────────────
    const viewports = await measureAtViewports(session.page, {
      url: session.url,
      shotDir: shotsDir,
      shotPrefix: DEMO,
      targets: DEFAULT_SELECTORS,
    });

    await session.page.setViewportSize({ width: 1280, height: 900 });
    await session.page.goto(session.url, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="shell"]');
    await session.page.evaluate(() => document.fonts.ready);
    await session.page.waitForFunction(
      () => {
        const p = document.querySelector('[data-testid="live-status"]')?.getAttribute("data-phase");
        return p === "live" || p === "empty";
      },
      { timeout: 15_000 },
    ).catch(() => null);

    const boardScroll = await session.page.evaluate(() => {
      const shell = document.querySelector('[data-testid="shell"]');
      const body = document.querySelector('[data-testid="shell-body"]');
      return {
        shell: shell
          ? {
              scrollWidth: shell.scrollWidth,
              clientWidth: shell.clientWidth,
              noHorizontalScroll: shell.scrollWidth <= shell.clientWidth + 1,
            }
          : null,
        body: body
          ? {
              scrollWidth: body.scrollWidth,
              clientWidth: body.clientWidth,
              noHorizontalScroll: body.scrollWidth <= body.clientWidth + 1,
            }
          : null,
      };
    });

    // 1280 density sweep — elements that must not silently clip.
    const densitySelectors = [
      ".pc-shell__tab-label",
      ".pc-shell__status-value",
      ".pc-shell__status-meta--compact",
      ".pc-shell__live-status-value",
      ".pc-shell__attention-count",
      ".pc-shell__clock",
      ".pc-shell__footer-note",
      ".pc-shell__footer-meta",
    ];
    /** @type {Record<string, object>} */
    const densityParts = {};
    let densityAllOk = true;
    for (const sel of densitySelectors) {
      const m = await scrollMetrics(session.page, sel);
      densityParts[sel] = m;
      if (m.found && !m.ok) densityAllOk = false;
    }
    // Tab-sub and full status-meta should be display:none at 1280 — not clipped.
    const hiddenAt1280 = await session.page.evaluate(() => {
      const sub = document.querySelector(".pc-shell__tab-sub");
      const full = document.querySelector(".pc-shell__status-meta--full");
      const csSub = sub ? getComputedStyle(sub) : null;
      const csFull = full ? getComputedStyle(full) : null;
      return {
        tabSubDisplay: csSub?.display ?? null,
        statusMetaFullDisplay: csFull?.display ?? null,
        tabSubHidden: csSub?.display === "none",
        statusMetaFullHidden: csFull?.display === "none",
      };
    });
    if (!hiddenAt1280.tabSubHidden || !hiddenAt1280.statusMetaFullHidden) {
      densityAllOk = false;
    }

    const headline = {
      headerHeight: viewports[0]?.elements?.header?.box?.height ?? null,
      nav: viewports[0]?.elements?.nav?.box ?? null,
      find: viewports[0]?.elements?.find?.box ?? null,
      findInput: viewports[0]?.elements?.["find-input"]?.box ?? null,
      railLeft: viewports[0]?.elements?.["rail-left"]?.box?.width ?? null,
      railRight: viewports[0]?.elements?.["rail-right"]?.box?.width ?? null,
      boardScroll,
    };

    const contrast = await measureChromeContrast(session.page);

    const stateEncoding = await session.page.evaluate(() => {
      const items = [...document.querySelectorAll(".pc-shell__legend-item")].map((el) => {
        const dot = el.querySelector(".pc-shell__legend-dot");
        const label = el.querySelector(".pc-shell__legend-label");
        const cs = dot ? getComputedStyle(dot) : null;
        return {
          state: el.getAttribute("data-state"),
          label: label?.textContent?.trim() ?? null,
          dotBorderRadius: cs?.borderRadius ?? null,
          hasLabel: Boolean(label?.textContent?.trim()),
        };
      });
      return { legendItems: items, allHaveLabels: items.every((i) => i.hasLabel) };
    });

    // Stream value must not re-include "stream".
    const streamCopy = await session.page.evaluate(() => {
      const label = document.querySelector(".pc-shell__live-status-label")?.textContent?.trim();
      const value = document.querySelector(".pc-shell__live-status-value")?.textContent?.trim();
      return { label, value, concatenated: `${label ?? ""}${value ?? ""}` };
    });

    // ── Footer note at 3 widths ──────────────────────────────────────
    /** @type {Array<object>} */
    const footerNoteScroll = [];
    for (const w of [1280, 1460, 1920]) {
      await session.page.setViewportSize({ width: w, height: 900 });
      await session.page.waitForTimeout(50);
      const m = await scrollMetrics(session.page, ".pc-shell__footer-note");
      footerNoteScroll.push({ name: String(w), ...m });
    }

    // ── Axe: resting ─────────────────────────────────────────────────
    await session.page.setViewportSize({ width: 1460, height: 900 });
    await session.page.goto(session.url, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="shell"]');
    await session.page.evaluate(() => document.fonts.ready);
    const a11yResting = await collectA11y(session.page);

    // ── Axe: find popup open (no-match honesty state) ────────────────
    await session.page.locator('[data-testid="find-input"]').click();
    await session.page.locator('[data-testid="find-input"]').fill("zzz-axe-no-match-999");
    await session.page.waitForSelector('[data-testid="find-popup"]', { timeout: 3000 }).catch(() => null);
    await session.page.waitForTimeout(350);
    const axeFind = await runAxe(session.page, { include: '[data-testid="shell"]' });
    const ariaFind = await ariaSnapshot(session.page);
    // Clear find
    await session.page.locator('[data-testid="find-input"]').fill("");
    await session.page.keyboard.press("Escape");

    // ── Axe + focus: settings open ───────────────────────────────────
    const settingsBtn = session.page.locator('[data-testid="settings-open"]');
    await settingsBtn.focus();
    await settingsBtn.click();
    await session.page.waitForSelector('[data-testid="settings-surface"]');
    await session.page.waitForTimeout(50);
    const focusInSettings = await session.page.evaluate(describeFocus);
    const settingsAriaModal = await session.page.evaluate(() => {
      const panel = document.querySelector('[data-testid="settings-panel"]');
      return panel?.getAttribute("aria-modal") ?? null;
    });
    // Tab stops behind the open dialog must be zero (inert siblings / trap).
    const tabStopsBehind = await session.page.evaluate(() => {
      const panel = document.querySelector('[data-testid="settings-panel"]');
      const shell = document.querySelector('[data-testid="shell"]');
      if (!panel || !shell) return -1;
      const sel =
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
      const all = [...shell.querySelectorAll(sel)];
      return all.filter((el) => {
        if (panel.contains(el)) return false;
        if (el.closest('[data-testid="settings-surface"]')) return false;
        // inert ancestors are not tabbable
        let n = el;
        while (n) {
          if (n.hasAttribute && n.hasAttribute("inert")) return false;
          n = n.parentElement;
        }
        return true;
      }).length;
    });
    const axeSettings = await runAxe(session.page, { include: '[data-testid="shell"]' });
    // Accelerators must not navigate while open.
    await session.page.keyboard.press("3");
    const screenAfterAccel = await session.page.locator('[data-testid="shell"]').getAttribute("data-screen");
    await session.page.keyboard.press("Escape");
    await session.page.waitForTimeout(50);
    const focusAfterClose = await session.page.evaluate(describeFocus);

    // ── Skip-to-main ─────────────────────────────────────────────────
    await session.page.locator("body").focus();
    const skipMain = session.page.locator('[data-testid="skip-main"]');
    // Make skip link visible/focusable via Tab or direct focus+Enter.
    await skipMain.focus();
    // #364 — focused skip links must show complete labels (no clip).
    const skipLinkLabels = await session.page.evaluate(() => {
      const links = [...document.querySelectorAll(".pc-skip__link")];
      return links.map((el) => {
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        el.focus();
        const full =
          el.scrollWidth <= el.clientWidth + 1 &&
          el.clientWidth >= 40 &&
          text.length > 0;
        return {
          text,
          clientWidth: Math.round(el.clientWidth),
          scrollWidth: Math.round(el.scrollWidth),
          fullLabel: full,
        };
      });
    });
    await skipMain.focus();
    await session.page.keyboard.press("Enter");
    await session.page.waitForTimeout(30);
    const afterSkip = await session.page.evaluate(describeFocus);
    await session.page.keyboard.press("Tab");
    const afterSkipTab = await session.page.evaluate(describeFocus);

    // Center outline suppressed
    const centerOutline = await session.page.evaluate(() => {
      const main = document.getElementById("main-content");
      if (!main) return null;
      main.focus();
      const cs = getComputedStyle(main);
      return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
    });

    // ── Live region: force offline via route intercept (same mount) then restore
    // so we can prove bidirectional announce without remounting React.
    /** @type {Array<{t:number,text:string,phase:string|null}>} */
    const recoverSamples = [];
    const recoverStart = Date.now();
    await session.page.route("**/health", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced offline (verify)" }),
      });
    });
    await session.page.route("**/events/**", async (route) => {
      await route.abort("failed");
    });
    // Also break bootstrap if stream retries.
    await session.page.route("**/tasks", async (route) => {
      if (route.request().method() === "GET") {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    for (let i = 0; i < 40; i += 1) {
      await session.page.waitForTimeout(200);
      const sample = await session.page.evaluate(() => {
        const live = document.querySelector('[data-testid="live-region"]');
        const phase = document
          .querySelector('[data-testid="live-status"]')
          ?.getAttribute("data-phase");
        return {
          text: (live?.textContent ?? "").replace(/\u200b/g, "").trim(),
          phase: phase ?? null,
        };
      });
      recoverSamples.push({ t: Date.now() - recoverStart, ...sample });
      if (/daemon offline|reconnecting/i.test(sample.text)) break;
    }

    await session.page.unroute("**/health");
    await session.page.unroute("**/events/**");
    await session.page.unroute("**/tasks");

    for (let i = 0; i < 40; i += 1) {
      await session.page.waitForTimeout(200);
      const sample = await session.page.evaluate(() => {
        const live = document.querySelector('[data-testid="live-region"]');
        const phase = document
          .querySelector('[data-testid="live-status"]')
          ?.getAttribute("data-phase");
        return {
          text: (live?.textContent ?? "").replace(/\u200b/g, "").trim(),
          phase: phase ?? null,
        };
      });
      recoverSamples.push({ t: Date.now() - recoverStart, ...sample });
      if (/connection restored/i.test(sample.text)) break;
    }

    const announcedOfflineAfterLive = recoverSamples.some((s) =>
      /daemon offline|reconnecting/i.test(s.text),
    );
    const announcedRestore = recoverSamples.some((s) => /connection restored/i.test(s.text));

    const comboboxAria = await session.page.evaluate(() => {
      const input = document.querySelector('[data-testid="find-input"]');
      if (!input) return null;
      return {
        role: input.getAttribute("role"),
        ariaExpanded: input.getAttribute("aria-expanded"),
        ariaAutocomplete: input.getAttribute("aria-autocomplete"),
        ariaControls: input.getAttribute("aria-controls"),
        ariaHaspopup: input.getAttribute("aria-haspopup"),
      };
    });

    const proof = {
      kind: "shell-chrome",
      description:
        "Shell chrome merge proofs: geometry, axe×3 states, skip-main, settings popover, " +
        "footer note, 1280 density, live-region boot+kill+recover.",
      daemon: { taskId, port: session.daemon.port },
      headline,
      contrast,
      stateEncoding,
      streamCopy,
      comboboxAria,
      viewports,
      a11y: a11yResting,
      a11yByState: {
        resting: { axe: a11yResting.axe, aria: a11yResting.aria },
        findPopup: { axe: axeFind, aria: ariaFind },
        settingsOpen: { axe: axeSettings },
      },
      footerNoteScroll,
      density1280: {
        allOk: densityAllOk && hiddenAt1280.tabSubHidden && hiddenAt1280.statusMetaFullHidden,
        hidden: hiddenAt1280,
        parts: densityParts,
      },
      skipMain: {
        focusedId: afterSkip.id,
        focusedTestId: afterSkip.testId,
        afterTab: afterSkipTab,
      },
      skipLinkLabels,
      settingsFocus: {
        ariaModal: settingsAriaModal,
        tabStopsBehind,
        focusMovedIn:
          focusInSettings.testId === "settings-close" ||
          focusInSettings.testId === "settings-follow-logs" ||
          focusInSettings.testId === "settings-panel" ||
          focusInSettings.tag === "button" ||
          focusInSettings.tag === "input",
        focusIn: focusInSettings,
        focusRestored: focusAfterClose.testId === "settings-open",
        focusAfterClose,
        screenAfterDigit3: screenAfterAccel,
        digit3DidNotNavigate: screenAfterAccel !== "task",
      },
      centerOutline,
      liveRegionTranscript: {
        bootSamples: liveSamples,
        recoverSamples,
        announcedOfflineOnHealthyBoot: announcedOfflineOnHealthyBoot || offlineWhileLive,
        offlineWhileLive,
        announcedOfflineAfterLive,
        announcedRestore,
      },
    };

    const entryPath = writeDemoProof(TICKET, DEMO, proof);
    printRectSummary(DEMO, viewports);
    console.log(`ledger entry: ${entryPath}`);
    console.log(
      "headline:",
      JSON.stringify(
        {
          headerHeight: headline.headerHeight,
          railLeft: headline.railLeft,
          railRight: headline.railRight,
          noHScroll: boardScroll?.shell?.noHorizontalScroll,
          axeRest: a11yResting.axe?.violations?.length,
          axeFind: axeFind.violations?.length,
          axeSettings: axeSettings.violations?.length,
          footerOk: footerNoteScroll.every((r) => r.ok),
          footerTexts: footerNoteScroll.map((r) => ({ name: r.name, text: r.text })),
          densityOk: densityAllOk,
          skipFocus: afterSkip.id,
          settingsAriaModal,
          liveBootOffline: announcedOfflineOnHealthyBoot || offlineWhileLive,
          streamValue: streamCopy.value,
        },
        null,
        2,
      ),
    );

    // Self-gate so `verify:shell` fails on proof regressions without needing
    // the full verify:check suite (neuter evidence for #374).
    const ledger = readLedger(TICKET);
    if (!ledger) throw new Error("shell-chrome: ledger missing after write");
    shellChromeGates({}, ledger);

    return proof;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runShellChromeDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
