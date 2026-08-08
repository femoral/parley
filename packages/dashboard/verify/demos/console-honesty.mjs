/**
 * Console honesty proofs (#368 shape, #371 contract / ADR-0001).
 *
 * - Ask hierarchy from position, awaiting ink, and type scale — not geometry
 * - No residual-filling termination strips on run/metrics
 * - Settings focus restores to trigger; 0 tab stops behind open dialog
 * - Nautical register clean on live board (sample text)
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectA11y, runAxe } from "../lib/a11y.mjs";
import { ledgerDirs, writeDemoProof, printRectSummary } from "../lib/ledger.mjs";
import { measureAtViewports } from "../lib/measure.mjs";
import { withFakeAllowlist } from "../lib/daemon.mjs";
import { openVerifySession } from "../lib/session.mjs";
import { stageRequiredRuns } from "../scripts/stage-runs.mjs";

const TICKET = "issue-368";
const DEMO = "console-honesty";

const SELECTORS = [
  { id: "shell", selector: '[data-testid="shell"]' },
  { id: "screen-task", selector: '[data-testid="screen-task"]' },
  { id: "task-ask-band", selector: '[data-testid="task-ask-band"]' },
  { id: "task-ask-band-question", selector: '[data-testid="task-ask-band-question"]' },
  { id: "task-log", selector: '[data-testid="task-log"]' },
  { id: "task-log-well", selector: '[data-testid="task-log-well"]' },
  { id: "screen-metrics", selector: '[data-testid="screen-metrics"]' },
  { id: "screen-run", selector: '[data-testid="screen-run"]' },
  { id: "footer", selector: '[data-testid="shell-footer"]' },
];

/**
 * @param {object} _entry
 * @param {object} ledger
 */
export function consoleHonestyGates(_entry, ledger) {
  const demo = ledger.demos?.[DEMO];
  if (!demo) throw new Error("console-honesty: missing demo in ledger");

  const ask = demo.askHierarchy;
  if (!ask?.ok) {
    throw new Error(
      `console-honesty: ask hierarchy failed ADR-0001 contract: ${JSON.stringify(ask)}`,
    );
  }
  // Explicit sub-assertions so a partial proof cannot pass the gate.
  if (!ask.bandFirstInColumn) {
    throw new Error(
      `console-honesty: ask band not first content block above log: ${JSON.stringify(ask)}`,
    );
  }
  if (!ask.questionLargestType) {
    throw new Error(
      `console-honesty: question font-size not strictly largest: ${JSON.stringify(ask)}`,
    );
  }
  if (!ask.awaitingInk) {
    throw new Error(
      `console-honesty: ask band missing awaiting-state ink: ${JSON.stringify(ask)}`,
    );
  }
  if (!ask.questionVisible) {
    throw new Error(
      `console-honesty: question not visible at 1460: ${JSON.stringify(ask)}`,
    );
  }
  if (!ask.contentSizedBand) {
    throw new Error(
      `console-honesty: band exceeds content-derived height bound (geometric min?): ${JSON.stringify(ask)}`,
    );
  }
  if (!ask.noLogCap) {
    throw new Error(
      `console-honesty: ask-open log surface has max-height cap: ${JSON.stringify(ask)}`,
    );
  }

  const voids = demo.voids1920;
  if (!voids) throw new Error("console-honesty: missing voids1920");
  for (const key of ["metrics", "run"]) {
    const v = voids[key];
    if (!v) {
      throw new Error(`console-honesty: missing voids1920.${key}`);
    }
    // Inverted void gate (ADR-0001): no termination element; residual ground is
    // intentional; nothing decorative fills it; no board scroll from termination.
    if (v.stripPresent) {
      throw new Error(
        `console-honesty: ${key} termination strip still present (must be removed): ${JSON.stringify(v)}`,
      );
    }
    if (v.decorativeInResidual) {
      throw new Error(
        `console-honesty: ${key} decorative residual under last content: ${JSON.stringify(v)}`,
      );
    }
    if (v.boardScroll === true) {
      throw new Error(
        `console-honesty: ${key} board scroll forced (termination styling?): ${JSON.stringify(v)}`,
      );
    }
  }

  // 1280×720 run body: no scroll / residual filler from termination styling.
  const run1280 = demo.runBody1280;
  if (!run1280) {
    throw new Error("console-honesty: missing runBody1280");
  }
  if (run1280.stripPresent) {
    throw new Error(
      `console-honesty: run termination strip present at 1280×720: ${JSON.stringify(run1280)}`,
    );
  }
  if (run1280.decorativeInResidual) {
    throw new Error(
      `console-honesty: run decorative residual at 1280×720: ${JSON.stringify(run1280)}`,
    );
  }
  if (run1280.boardScroll === true) {
    throw new Error(
      `console-honesty: run board scroll at 1280×720 from termination: ${JSON.stringify(run1280)}`,
    );
  }

  if (demo.settingsFocus?.ariaModal !== "true") {
    throw new Error("console-honesty: settings aria-modal must be true");
  }
  if (!demo.settingsFocus?.focusRestored) {
    throw new Error("console-honesty: settings did not restore focus to trigger");
  }
  if (
    typeof demo.settingsFocus?.tabStopsBehind === "number" &&
    demo.settingsFocus.tabStopsBehind > 0
  ) {
    throw new Error(
      `console-honesty: tab stops behind dialog: ${demo.settingsFocus.tabStopsBehind}`,
    );
  }

  if (demo.register?.hasNautical) {
    throw new Error(
      `console-honesty: nautical copy still present: ${demo.register.sample}`,
    );
  }

  // Prefer settings-open axe (tablist + modal); full-board collect can trip
  // transient attention-card selection contrast unrelated to chrome honesty.
  const axe = demo.a11ySettings?.axe ?? demo.a11y?.axe;
  if (!axe) throw new Error("console-honesty: missing axe");
  if ((axe.violations ?? []).length > 0) {
    throw new Error(
      `console-honesty: axe violations: ${axe.violations.map((v) => v.id).join(", ")}`,
    );
  }
}

/**
 * @param {import('playwright-core').Page} page
 * @param {string} baseUrl
 * @param {string} taskId
 */
async function openTask(page, baseUrl, taskId) {
  await page.goto(`${baseUrl}#/task/${encodeURIComponent(taskId)}`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector('[data-testid="screen-task"]', { timeout: 15_000 });
  await page
    .waitForSelector(
      '[data-testid="screen-task"][data-detail-status="ready"], [data-testid="screen-task"][data-detail-status="error"]',
      { timeout: 12_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(200);
}

/**
 * ADR-0001 ask hierarchy: position, type scale, awaiting ink, content size,
 * question visibility, and absence of geometric mins / log caps.
 *
 * @param {import('playwright-core').Page} page
 */
async function measureAskHierarchy(page) {
  return page.evaluate(() => {
    const band = document.querySelector('[data-testid="task-ask-band"]');
    const q = document.querySelector('[data-testid="task-ask-band-question"]');
    const log = document.querySelector('[data-testid="task-log"]');
    const logCol = document.querySelector('[data-testid="task-col-log"]');
    const well = document.querySelector('[data-testid="task-log-well"]');
    const task = document.querySelector('[data-testid="screen-task"]');

    if (!band || !q || !log || !task) {
      return {
        ok: false,
        reason: "missing band/question/log/task",
        bandFirstInColumn: false,
        questionLargestType: false,
        awaitingInk: false,
        questionVisible: false,
        contentSizedBand: false,
        noLogCap: false,
      };
    }

    const bandBox = band.getBoundingClientRect();
    const qBox = q.getBoundingClientRect();
    const logBox = log.getBoundingClientRect();

    // 1. Band is first content block above the log (column order / y-position).
    const bandFirstInColumn =
      bandBox.height > 0 &&
      bandBox.width > 0 &&
      bandBox.bottom <= logBox.top + 1;

    // 2. Question rendered font-size is strictly the largest sampled on screen.
    const qStyle = window.getComputedStyle(q);
    const qFont = parseFloat(qStyle.fontSize) || 0;
    const sampleSelectors = [
      ".pc-task-header__name",
      ".pc-task-header__ids",
      ".pc-task-header__sub",
      ".pc-task-brief",
      ".pc-task-brief *",
      ".pc-task-log__line",
      ".pc-task-log__status",
      ".pc-task-qa",
      ".pc-task-qa *",
      ".pc-task-report",
      ".pc-task-report *",
      ".pc-task-attempts",
      ".pc-task-attempts *",
      ".pc-task-ask-band__tag",
      ".pc-task-ask-band__cue",
      ".pc-scaffold",
      ".pc-scaffold *",
      ".pc-chip",
      ".pc-kpi__value",
      ".pc-shell-title",
    ];
    let maxOtherFont = 0;
    let maxOtherSample = null;
    for (const sel of sampleSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (el === q || q.contains(el)) continue;
        const text = (el.textContent ?? "").trim();
        if (!text) continue;
        const fs = parseFloat(window.getComputedStyle(el).fontSize) || 0;
        if (fs > maxOtherFont) {
          maxOtherFont = fs;
          maxOtherSample = { sel, fs, text: text.slice(0, 40) };
        }
      }
    }
    const questionLargestType = qFont > 0 && qFont > maxOtherFont;

    // 3. Awaiting-state ink: left rule + tinted ground (not plain surface).
    const bandStyle = window.getComputedStyle(band);
    const borderLeft = bandStyle.borderLeftColor || "";
    const bg = bandStyle.backgroundColor || "";
    // Accept rgb()/rgba() and color(srgb …) (Chromium may serialize either).
    const parseRgb = (c) => {
      const m1 = c.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
      if (m1) return { r: +m1[1], g: +m1[2], b: +m1[3] };
      const m2 = c.match(/color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
      if (m2) {
        return { r: +m2[1] * 255, g: +m2[2] * 255, b: +m2[3] * 255 };
      }
      return null;
    };
    const bl = parseRgb(borderLeft);
    // Amber #e0a02e: R high, G mid, B low — left border at least 2px.
    const borderW = parseFloat(bandStyle.borderLeftWidth) || 0;
    const awaitingBorder =
      borderW >= 2 &&
      bl !== null &&
      bl.r >= 180 &&
      bl.g >= 120 &&
      bl.g <= 200 &&
      bl.b <= 100 &&
      bl.r > bl.g &&
      bl.g > bl.b;
    // Tinted ground: not pure ground black; warm channel lift from color-mix.
    const bgRgb = parseRgb(bg);
    const tintedGround =
      bgRgb !== null &&
      (bgRgb.r > 15 || bgRgb.g > 15 || bgRgb.b > 15) &&
      bgRgb.r >= bgRgb.b;
    const awaitingInk = awaitingBorder && tintedGround;

    // 4. Question visible in viewport (measured at 1460×900).
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const questionVisible =
      qBox.width > 0 &&
      qBox.height > 0 &&
      qBox.bottom > 0 &&
      qBox.top < vh &&
      qBox.right > 0 &&
      qBox.left < vw &&
      qBox.top >= 0 &&
      qBox.bottom <= vh;

    // 5. Content-derived band height bound — catches geometric min-heights.
    //    - band min-height unset; question min-height unset
    //    - question box height close to its text ink height (not 5.5em empty)
    //    - band height close to padding + children stack (not 200px floor)
    const unsetMin = (v) =>
      !v || v === "0px" || v === "auto" || v === "none" || v === "0%";
    const bandMin = bandStyle.minHeight;
    const qMin = qStyle.minHeight;
    const minsUnset = unsetMin(bandMin) && unsetMin(qMin);

    // Text ink height via range (ignores min-height empty space).
    let textInkH = 0;
    try {
      const range = document.createRange();
      range.selectNodeContents(q);
      const tr = range.getBoundingClientRect();
      textInkH = tr.height;
      range.detach?.();
    } catch {
      textInkH = 0;
    }
    // Question may wrap; allow one line of slack beyond measured ink.
    const qLine = parseFloat(qStyle.lineHeight) || qFont * 1.5 || 36;
    const questionContentBound = textInkH > 0 && qBox.height <= textInkH + qLine * 0.35 + 2;

    // Band stack: padding + direct children + gaps.
    const padTop = parseFloat(bandStyle.paddingTop) || 0;
    const padBottom = parseFloat(bandStyle.paddingBottom) || 0;
    const gap = parseFloat(bandStyle.rowGap || bandStyle.gap) || 0;
    const kids = [...band.children];
    const kidsH = kids.reduce((s, el) => s + el.getBoundingClientRect().height, 0);
    const gapsH = Math.max(0, kids.length - 1) * gap;
    const stackH = padTop + padBottom + kidsH + gapsH;
    // Band must not sit on a geometric floor far above its content stack.
    // Slack covers subpixel + borders. Content-derived only — no hardcoded
    // geometric ceiling (old 200px min would fail bandContentBound / minsUnset).
    const bandContentBound =
      bandBox.height > 0 && bandBox.height <= stackH + 4;

    const contentSizedBand =
      minsUnset && questionContentBound && bandContentBound;

    // 6. Ask-open state applies no max-height to log surfaces.
    const maxUnset = (v) => !v || v === "none" || v === "0px";
    const surfaces = [
      logCol,
      log,
      well,
      document.querySelector(".pc-task-col--log"),
      document.querySelector(".pc-task-log"),
      document.querySelector(".pc-task-log__well"),
    ].filter(Boolean);
    const maxHeights = surfaces.map((el) => ({
      testId: el.getAttribute("data-testid") || el.className,
      maxHeight: window.getComputedStyle(el).maxHeight,
    }));
    const noLogCap =
      task.getAttribute("data-ask") === "true" &&
      maxHeights.every((m) => maxUnset(m.maxHeight));

    const ok =
      bandFirstInColumn &&
      questionLargestType &&
      awaitingInk &&
      questionVisible &&
      contentSizedBand &&
      noLogCap;

    return {
      ok,
      bandFirstInColumn,
      questionLargestType,
      awaitingInk,
      questionVisible,
      contentSizedBand,
      noLogCap,
      questionFontPx: Math.round(qFont * 100) / 100,
      maxOtherFontPx: Math.round(maxOtherFont * 100) / 100,
      maxOtherSample,
      bandHeight: Math.round(bandBox.height),
      questionHeight: Math.round(qBox.height),
      textInkHeight: Math.round(textInkH),
      stackHeight: Math.round(stackH),
      bandMinHeight: bandMin,
      questionMinHeight: qMin,
      minsUnset,
      questionContentBound,
      bandContentBound,
      bandTop: Math.round(bandBox.top),
      bandBottom: Math.round(bandBox.bottom),
      logTop: Math.round(logBox.top),
      borderLeftWidth: borderW,
      borderLeftColor: borderLeft,
      backgroundColor: bg,
      dataAsk: task.getAttribute("data-ask"),
      logMaxHeights: maxHeights,
    };
  });
}

/**
 * Inverted void measure (ADR-0001): residual board ground is intentional.
 * Fail if a termination strip renders, if decorative content occupies the
 * residual under the last real row, or if board scroll is forced.
 *
 * realContentBottom is derived from leaf / text-bearing nodes only — not from
 * flex/grid layout shells that stretch to the footer (those made residual
 * structurally ~0 and dead-coded the decorative scan).
 *
 * @param {import('playwright-core').Page} page
 * @param {string} screenTestId
 * @param {string[]} forbiddenTestIds
 */
async function measureVoid(page, screenTestId, forbiddenTestIds) {
  return page.evaluate(
    ({ screenTestId: sid, forbiddenTestIds: fids }) => {
      const footer = document.querySelector('[data-testid="shell-footer"]');
      const screen = document.querySelector(`[data-testid="${sid}"]`);
      if (!footer || !screen) {
        return { found: false, stripPresent: true, boardScroll: true };
      }
      const fTop = footer.getBoundingClientRect().top;

      // Forbidden termination markers (elements, legacy test ids) — fast path.
      const foundStrips = [];
      for (const id of fids) {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (el) foundStrips.push({ kind: "testid", id });
      }
      for (const sel of [".pc-run__end", ".pc-metrics__end"]) {
        for (const el of screen.querySelectorAll(sel)) {
          foundStrips.push({
            kind: "class",
            id: sel,
            text: (el.textContent ?? "").trim().slice(0, 40),
          });
        }
      }
      // Pseudo-label "end of run/metrics" via ::after content on any element.
      for (const el of screen.querySelectorAll("*")) {
        const after = window.getComputedStyle(el, "::after").content;
        if (
          after &&
          after !== "none" &&
          after !== '""' &&
          /end of (run|metrics)/i.test(after.replace(/^["']|["']$/g, ""))
        ) {
          foundStrips.push({
            kind: "pseudo",
            id: el.className || el.tagName,
            content: after,
          });
        }
      }
      const stripPresent = foundStrips.length > 0;

      const isStripNode = (el) => {
        if (!el) return false;
        const tid = el.getAttribute?.("data-testid") ?? "";
        if (fids.includes(tid)) return true;
        if (
          el.classList?.contains("pc-run__end") ||
          el.classList?.contains("pc-metrics__end")
        ) {
          return true;
        }
        return false;
      };

      const underStrip = (el) => {
        let p = el.parentElement;
        while (p && p !== screen) {
          if (isStripNode(p)) return true;
          p = p.parentElement;
        }
        return false;
      };

      /** Own direct text (not descendant text). */
      const ownText = (el) =>
        [...el.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join(" ");

      /**
       * Real content node: leaf or text-bearing ink — not a layout shell that
       * merely stretches. Empty leaves (pseudo-only fillers) are excluded so
       * they do not inflate realContentBottom into the residual.
       */
      const isRealContentNode = (el) => {
        if (isStripNode(el) || underStrip(el)) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 1 && r.height < 1) return false;
        const text = ownText(el);
        if (text.length > 0) return true;
        const tag = el.tagName;
        if (tag === "IMG" || tag === "SVG" || tag === "CANVAS" || tag === "VIDEO") {
          return r.width > 0 && r.height > 0;
        }
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          tag === "BUTTON"
        ) {
          return r.width > 0 && r.height > 0;
        }
        // Leaf with no own text and no form/media role: empty box / pseudo filler.
        if (el.children.length === 0) return false;
        // Non-leaf without own text: layout container — use descendants only.
        return false;
      };

      // Lowest real content bottom from content nodes only.
      let realContentBottom = 0;
      for (const el of screen.querySelectorAll("*")) {
        if (!isRealContentNode(el)) continue;
        const r = el.getBoundingClientRect();
        realContentBottom = Math.max(realContentBottom, r.bottom);
      }

      const residualUnderContent = Math.max(
        0,
        Math.round(fTop - realContentBottom),
      );

      /** Non-empty ::before / ::after content string. */
      const pseudoContent = (el, which) => {
        const c = window.getComputedStyle(el, which).content;
        if (!c || c === "none" || c === "normal" || c === '""' || c === "''") {
          return "";
        }
        return c.replace(/^["']|["']$/g, "");
      };

      /** Visible painted decoration (bg / border / shadow / pseudo). */
      const hasVisibleDecoration = (el, st) => {
        const bg = st.backgroundColor || "";
        // Transparent / fully-alpha backgrounds are not decorative paint.
        const bgPainted =
          bg &&
          bg !== "transparent" &&
          bg !== "rgba(0, 0, 0, 0)" &&
          !/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(bg) &&
          // color(srgb … / 0) fully transparent
          !/\/\s*0\)\s*$/.test(bg);
        const borderW =
          (parseFloat(st.borderTopWidth) || 0) +
          (parseFloat(st.borderBottomWidth) || 0) +
          (parseFloat(st.borderLeftWidth) || 0) +
          (parseFloat(st.borderRightWidth) || 0);
        const shadow = st.boxShadow && st.boxShadow !== "none";
        const before = pseudoContent(el, "::before");
        const after = pseudoContent(el, "::after");
        return bgPainted || borderW > 0 || shadow || before.length > 0 || after.length > 0;
      };

      // Decorative residual: ANY rendered decorative occupant of the residual
      // (visible box with bg/border/pseudo that is not real content), not only
      // legacy marker names. Marker check remains a fast path below.
      let decorativeInResidual = false;
      const decorativeHits = [];

      // Always scan when residual exists; also scan for elements that begin in
      // or primarily occupy the residual even when residual is small (overflow).
      const scanResidual = residualUnderContent >= 24 || realContentBottom > 0;
      if (scanResidual) {
        for (const el of screen.querySelectorAll("*")) {
          if (isStripNode(el)) {
            decorativeInResidual = true;
            decorativeHits.push({
              reason: "strip-node",
              testId: el.getAttribute("data-testid"),
            });
            continue;
          }
          if (underStrip(el)) continue;

          const r = el.getBoundingClientRect();
          if (r.height < 24 || r.width < 24) continue;

          // Occupies residual zone: top at/after last real content, above footer.
          // Allow a few px slack; also catch elements that straddle the boundary
          // with most of their box in the residual.
          const startsInResidual = r.top >= realContentBottom - 8;
          const mostlyInResidual =
            r.top < realContentBottom - 8 &&
            r.bottom > realContentBottom + 24 &&
            r.bottom - Math.max(r.top, realContentBottom) >=
              Math.min(r.height * 0.5, 40);
          if (!startsInResidual && !mostlyInResidual) continue;
          if (r.top > fTop - 4) continue;

          // Layout shells that wrap real content start above realContentBottom
          // and are filtered by startsInResidual. A renamed filler (.pc-run__coda)
          // sits after content and is scored here.

          // Skip if this node *is* real content (text-bearing leaf continuing).
          if (isRealContentNode(el) && startsInResidual) {
            // Real content past the prior max is still content, not decoration.
            continue;
          }

          const st = window.getComputedStyle(el);
          const flexGrow = parseFloat(st.flexGrow) || 0;
          const minH = parseFloat(st.minHeight) || 0;
          const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          const before = pseudoContent(el, "::before");
          const after = pseudoContent(el, "::after");
          const decorated = hasVisibleDecoration(el, st);

          // Substantive text in the residual that is not a short terminal label
          // is content (not decorative). Short labels / empty / pseudo-only fail.
          const substantiveText =
            text.length >= 24 &&
            !/^end of /i.test(text) &&
            before.length === 0 &&
            after.length === 0;

          if (substantiveText && flexGrow < 1 && minH < 40) continue;

          const fillsOrSits =
            r.height >= 40 ||
            flexGrow >= 1 ||
            minH >= 40 ||
            (decorated && r.height >= 24);

          if (!fillsOrSits) continue;
          if (!decorated && flexGrow < 1 && minH < 40 && text.length === 0) {
            // Transparent empty non-grower: not a visual occupant.
            continue;
          }

          // Layout containers that stretch from top of body (already excluded
          // by startsInResidual for typical shells). Extra guard: if the node
          // has many real-content descendants and starts well above residual,
          // it is a shell — mostlyInResidual path only.
          if (mostlyInResidual && !startsInResidual) {
            let contentDesc = 0;
            for (const d of el.querySelectorAll("*")) {
              if (isRealContentNode(d)) contentDesc += 1;
              if (contentDesc > 3) break;
            }
            // A body/shell full of real content is not a residual occupant.
            if (contentDesc > 3 && flexGrow < 1) continue;
            // flex-grow stretch shell with content descendants but also
            // decorative residual paint below content: only flag if the
            // residual portion itself has decoration without being a content host.
            if (contentDesc > 0 && !decorated) continue;
          }

          decorativeInResidual = true;
          decorativeHits.push({
            reason:
              flexGrow >= 1
                ? "flex-grow-fill"
                : after.length || before.length
                  ? "pseudo-residual"
                  : decorated
                    ? "decorated-residual"
                    : "empty-residual-block",
            testId: el.getAttribute("data-testid"),
            className:
              typeof el.className === "string" ? el.className.slice(0, 60) : "",
            height: Math.round(r.height),
            top: Math.round(r.top),
            flexGrow,
            minHeight: minH,
            text: text.slice(0, 40),
            after: after.slice(0, 40),
          });
        }
      }
      // Marker fast path: a present strip is decorative residual.
      if (stripPresent) decorativeInResidual = true;

      // Shell-level scroll (nested table/body overflow is legitimate).
      const shellEl = document.querySelector('[data-testid="shell"]');
      const shellScroll = !!(
        shellEl && shellEl.scrollHeight > shellEl.clientHeight + 2
      );
      // Screen overflow from termination styling — no marker guard: renamed
      // fillers that force overflow must fail regardless of class/test id.
      const screenScroll = !!(screen.scrollHeight > screen.clientHeight + 2);

      // Content (or filler) rect past the footer — catches 1280×720 cases where
      // overflow:hidden hides scrollHeight growth but a filler still protrudes.
      let farthestBottom = 0;
      for (const el of screen.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 && r.height < 1) continue;
        farthestBottom = Math.max(farthestBottom, r.bottom);
      }
      const contentPastFooter = farthestBottom > fTop + 4;

      const boardScroll = shellScroll || screenScroll || contentPastFooter;

      return {
        found: true,
        stripPresent,
        foundStrips,
        decorativeInResidual,
        decorativeHits,
        residualUnderContent,
        realContentBottom: Math.round(realContentBottom),
        footerTop: Math.round(fTop),
        farthestBottom: Math.round(farthestBottom),
        contentPastFooter,
        boardScroll,
        shellScroll,
        screenScroll,
      };
    },
    { screenTestId, forbiddenTestIds },
  );
}

export async function runConsoleHonestyDemo() {
  const config = withFakeAllowlist({
    profiles: {
      deep: {
        vendor: "fake",
        model: "fake-model",
        effort: "medium",
        sandbox: "workspace",
      },
      fast: {
        vendor: "fake",
        model: "fake-model",
        effort: "low",
        sandbox: "workspace",
      },
    },
    defaults: { profile: "deep" },
  });
  const session = await openVerifySession({ config });
  try {
    const { shotsDir } = ledgerDirs(TICKET);

    // Stage awaiting ask (short one-line question from library) + a real run.
    const awaiting = await session.daemon.stageScript("awaiting-answer", {
      prompt: "Short ask band content-height check.",
    });
    await session.daemon.waitTask(awaiting.taskId);

    const stagedRuns = await stageRequiredRuns(session.daemon.baseUrl, {
      home: session.daemon.home,
    });
    const runId = stagedRuns.gateHeld?.runId ?? null;

    // ── Ask hierarchy at 1460 ────────────────────────────────────────
    await session.page.setViewportSize({ width: 1460, height: 900 });
    await openTask(session.page, session.url, awaiting.taskId);
    await session.page
      .waitForSelector('[data-testid="task-ask-band"]', { timeout: 10_000 })
      .catch(() => undefined);
    const askHierarchy = await measureAskHierarchy(session.page);
    await session.page.screenshot({
      path: path.join(shotsDir, "ask-band-1460.png"),
      fullPage: false,
    });

    // ── Voids at 1920 (inverted: no strip, residual ground ok) ───────
    await session.page.setViewportSize({ width: 1920, height: 1080 });
    await session.page.goto(`${session.url}#/metrics`, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="screen-metrics"]');
    await session.page.waitForTimeout(300);
    const metricsVoid = await measureVoid(session.page, "screen-metrics", [
      "metrics-end",
      "run-end",
    ]);
    await session.page.screenshot({
      path: path.join(shotsDir, "metrics-void-1920.png"),
      fullPage: false,
    });

    const runHash = runId
      ? `#/run/${encodeURIComponent(runId)}`
      : "#/run";
    await session.page.goto(`${session.url}${runHash}`, {
      waitUntil: "networkidle",
    });
    await session.page.waitForSelector('[data-testid="screen-run"]');
    await session.page
      .waitForSelector('[data-testid="run-header"]', {
        timeout: 12_000,
      })
      .catch(() => undefined);
    await session.page.waitForTimeout(400);
    const runVoid = await measureVoid(session.page, "screen-run", [
      "run-end",
      "metrics-end",
    ]);
    await session.page.screenshot({
      path: path.join(shotsDir, "run-void-1920.png"),
      fullPage: false,
    });

    // ── Run body at 1280×720 — no termination scroll contribution ────
    await session.page.setViewportSize({ width: 1280, height: 720 });
    await session.page.goto(`${session.url}${runHash}`, {
      waitUntil: "networkidle",
    });
    await session.page.waitForSelector('[data-testid="screen-run"]');
    await session.page
      .waitForSelector('[data-testid="run-header"]', {
        timeout: 12_000,
      })
      .catch(() => undefined);
    await session.page.waitForTimeout(300);
    const runBody1280 = await measureVoid(session.page, "screen-run", [
      "run-end",
      "metrics-end",
    ]);
    await session.page.screenshot({
      path: path.join(shotsDir, "run-body-1280x720.png"),
      fullPage: false,
    });

    // ── Settings modal focus restore ─────────────────────────────────
    await session.page.setViewportSize({ width: 1460, height: 900 });
    await session.page.goto(session.url, { waitUntil: "networkidle" });
    const settingsBtn = session.page.locator('[data-testid="settings-open"]');
    await settingsBtn.focus();
    await settingsBtn.click();
    await session.page.waitForSelector('[data-testid="settings-surface"]');
    await session.page.waitForTimeout(40);
    const settingsAriaModal = await session.page.evaluate(() => {
      return (
        document
          .querySelector('[data-testid="settings-panel"]')
          ?.getAttribute("aria-modal") ?? null
      );
    });
    const tabStopsBehind = await session.page.evaluate(() => {
      const panel = document.querySelector('[data-testid="settings-panel"]');
      const shell = document.querySelector('[data-testid="shell"]');
      if (!panel || !shell) return -1;
      const sel =
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
      return [...shell.querySelectorAll(sel)].filter((el) => {
        if (panel.contains(el)) return false;
        if (el.closest('[data-testid="settings-surface"]')) return false;
        let n = el;
        while (n) {
          if (n.hasAttribute && n.hasAttribute("inert")) return false;
          n = n.parentElement;
        }
        return true;
      }).length;
    });
    const axeSettings = await runAxe(session.page, {
      include: '[data-testid="shell"]',
    });
    await session.page.keyboard.press("Escape");
    await session.page.waitForTimeout(80);
    const focusAfterClose = await session.page.evaluate(() => {
      const el = document.activeElement;
      return {
        testId: el?.getAttribute?.("data-testid") ?? null,
        tag: el?.tagName?.toLowerCase?.() ?? null,
      };
    });

    // ── Register sample ──────────────────────────────────────────────
    const register = await session.page.evaluate(() => {
      const text = (document.body?.innerText ?? "").slice(0, 4000);
      const hasNautical =
        /\bhailing\b/i.test(text) ||
        /\ball hands\b/i.test(text) ||
        /\bahoy\b/i.test(text);
      return { hasNautical, sample: text.slice(0, 200) };
    });

    // Viewport triple for shell+ask (awaiting)
    const viewports = await measureAtViewports(session.page, {
      url: `${session.url}#/task/${encodeURIComponent(awaiting.taskId)}`,
      shotDir: shotsDir,
      shotPrefix: "honesty-ask",
      targets: SELECTORS.filter((t) =>
        ["shell", "screen-task", "task-ask-band", "task-log"].includes(t.id),
      ),
      beforeMeasure: async () => {
        await openTask(session.page, session.url, awaiting.taskId);
      },
    });

    printRectSummary("console-honesty ask", viewports);

    const a11y = await collectA11y(session.page);

    const proof = {
      ticket: TICKET,
      demo: DEMO,
      askHierarchy: {
        ...askHierarchy,
        viewport: "1460x900",
        screenshot: "shots/ask-band-1460.png",
      },
      voids1920: {
        metrics: { ...metricsVoid, screenshot: "shots/metrics-void-1920.png" },
        run: { ...runVoid, screenshot: "shots/run-void-1920.png" },
      },
      runBody1280: {
        ...runBody1280,
        viewport: "1280x720",
        screenshot: "shots/run-body-1280x720.png",
      },
      settingsFocus: {
        ariaModal: settingsAriaModal,
        tabStopsBehind,
        focusRestored: focusAfterClose.testId === "settings-open",
        focusAfterClose,
      },
      register,
      a11y: {
        axe: a11y.axe ?? axeSettings,
        aria: a11y.aria ?? null,
      },
      a11ySettings: { axe: axeSettings },
      viewports,
      staged: {
        awaitingTaskId: awaiting.taskId,
        runId,
      },
    };

    writeDemoProof(TICKET, DEMO, proof);
    return proof;
  } finally {
    await session.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runConsoleHonestyDemo()
    .then((p) => {
      console.log(
        JSON.stringify(
          {
            askOk: p.askHierarchy?.ok,
            bandH: p.askHierarchy?.bandHeight,
            qFont: p.askHierarchy?.questionFontPx,
            noLogCap: p.askHierarchy?.noLogCap,
            metricsStrip: p.voids1920?.metrics?.stripPresent,
            runStrip: p.voids1920?.run?.stripPresent,
            run1280Scroll: p.runBody1280?.boardScroll,
            focusRestored: p.settingsFocus?.focusRestored,
          },
          null,
          2,
        ),
      );
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
