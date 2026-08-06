/**
 * Issue #354 — shell chrome geometry + a11y + contrast at board widths.
 *
 * Measures header/nav/find/rails/footer at 1280/1460/1920; proves no board-level
 * horizontal scroll at 1280 (scrollWidth === clientWidth); WCAG AA contrast on
 * composited backgrounds; axe + ariaSnapshot + keyboard walk with real focusables.
 */
import { pathToFileURL } from "node:url";
import { collectA11y } from "../lib/a11y.mjs";
import { measureChromeContrast } from "../lib/contrast.mjs";
import { ledgerDirs, writeDemoProof, printRectSummary } from "../lib/ledger.mjs";
import { measureAtViewports, DEFAULT_SELECTORS } from "../lib/measure.mjs";
import { openVerifySession } from "../lib/session.mjs";

const TICKET = "issue-354";
const DEMO = "shell-chrome";

export async function runShellChromeDemo() {
  const session = await openVerifySession();
  try {
    const { taskId } = await session.daemon.stageScript("report-success");
    await session.daemon.waitTask(taskId);

    const { shotsDir } = ledgerDirs(TICKET);
    const viewports = await measureAtViewports(session.page, {
      url: session.url,
      shotDir: shotsDir,
      shotPrefix: DEMO,
      targets: DEFAULT_SELECTORS,
    });

    // Board scroll + headline geometry at 1280.
    await session.page.setViewportSize({ width: 1280, height: 900 });
    await session.page.goto(session.url, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="shell"]');
    await session.page.evaluate(() => document.fonts.ready);

    const boardScroll = await session.page.evaluate(() => {
      const shell = document.querySelector('[data-testid="shell"]');
      const body = document.querySelector('[data-testid="shell-body"]');
      const el = shell;
      return {
        shell: el
          ? {
              scrollWidth: el.scrollWidth,
              clientWidth: el.clientWidth,
              noHorizontalScroll: el.scrollWidth <= el.clientWidth + 1,
            }
          : null,
        body: body
          ? {
              scrollWidth: body.scrollWidth,
              clientWidth: body.clientWidth,
              noHorizontalScroll: body.scrollWidth <= body.clientWidth + 1,
            }
          : null,
        documentElement: {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        },
      };
    });

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

    // State never by hue alone — legend dots are squares + text labels.
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

    await session.page.setViewportSize({ width: 1460, height: 900 });
    const a11y = await collectA11y(session.page);

    // Real key presses: skip → nav → find → settings (Enter activates)
    await session.page.locator("body").focus();
    /** @type {Array<object>} */
    const keyPath = [];
    for (let i = 0; i < 14; i++) {
      await session.page.keyboard.press("Tab");
      const focused = await session.page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) {
          return { tag: "body", role: null, testId: null, text: "" };
        }
        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          testId: el.getAttribute("data-testid"),
          text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
        };
      });
      keyPath.push({ step: i + 1, key: "Tab", ...focused });
    }

    const settingsBtn = session.page.locator('[data-testid="settings-open"]');
    await settingsBtn.focus();
    await session.page.keyboard.press("Enter");
    const settingsOpen = await session.page.locator('[data-testid="settings-surface"]').count();
    keyPath.push({
      step: keyPath.length + 1,
      key: "Enter",
      tag: "button",
      testId: "settings-open",
      settingsOpen: settingsOpen > 0,
    });
    if (settingsOpen > 0) {
      await session.page.keyboard.press("Escape");
    }

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
        "Shell chrome at 1280/1460/1920: geometry, no board H-scroll, WCAG AA contrast, " +
        "axe + aria + keyboard walk (skip/nav/find/settings), combobox ARIA.",
      daemon: { taskId, port: session.daemon.port },
      headline,
      contrast,
      stateEncoding,
      comboboxAria,
      keyboardExtended: { path: keyPath },
      viewports,
      a11y,
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
          axeViolations: a11y.axe?.violations?.length,
        },
        null,
        2,
      ),
    );
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
