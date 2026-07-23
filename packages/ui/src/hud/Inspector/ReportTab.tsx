import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ReportPanel } from "../ReportPanel.js";
import type { ReportView } from "../types.js";

export interface ReportTabProps {
  report: ReportView | null;
}

/** Distance from the true bottom still treated as "scrolled to end". */
const INSPECTOR_END_PX = 8;

function isNearScrollEnd(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= INSPECTOR_END_PX;
}

/**
 * Layer 2 — the Report tab: thin wrapper over the standalone {@link ReportPanel}
 * (design-manifest §4.17 "Report"), plus a chart-key-style scroll cue on the
 * inspector body so "FILES CHANGED" never sits clipped at the fold with no
 * hint that more content lives below.
 */
export function ReportTab({ report }: ReportTabProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [bodyEl, setBodyEl] = useState<HTMLElement | null>(null);
  const [moreBelow, setMoreBelow] = useState(false);

  const measureMoreBelow = useCallback(() => {
    const body = wrapRef.current?.closest(".pc-inspector__body") as HTMLElement | null;
    if (!body) {
      setMoreBelow(false);
      return;
    }
    const overflows = body.scrollHeight > body.clientHeight + 1;
    setMoreBelow(overflows && !isNearScrollEnd(body));
  }, []);

  useLayoutEffect(() => {
    const body = wrapRef.current?.closest(".pc-inspector__body") as HTMLElement | null;
    setBodyEl(body);
    if (!body) {
      setMoreBelow(false);
      return;
    }
    measureMoreBelow();
    const onScroll = (): void => measureMoreBelow();
    body.addEventListener("scroll", onScroll, { passive: true });
    if (typeof ResizeObserver === "undefined") {
      return () => body.removeEventListener("scroll", onScroll);
    }
    const ro = new ResizeObserver(() => measureMoreBelow());
    ro.observe(body);
    // Report content size changes (files list) without body resize — watch wrap.
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      body.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [measureMoreBelow, report]);

  return (
    <>
      <div ref={wrapRef} className="pc-report-tab">
        <ReportPanel report={report} />
      </div>
      {bodyEl &&
        createPortal(
          <div
            className={`pc-inspector__scroll-cue${moreBelow ? "" : " pc-inspector__scroll-cue--hidden"}`}
            aria-hidden="true"
          >
            <span className="pc-inspector__scroll-cue-label">More below</span>
          </div>,
          bodyEl,
        )}
    </>
  );
}
