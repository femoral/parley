import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type UIEvent,
} from "react";
import { Emblem, Mark } from "../primitives/index.js";
import {
  notifyHandRolledPopoverOpen,
  subscribeHandRolledPopoverOpen,
} from "./handRolledPopover.js";
import { MARK_RING } from "../tokens/chrome-glyphs.js";
import { HARNESS_COLORS, MODEL_VENDORS, type EmblemMark } from "../tokens/factions.js";
import { ATTENTION_DISPLAY_ORDER, STATE_META } from "../tokens/state-meta.js";
import { KEYBOARD_SHORTCUTS } from "./keyboardShortcuts.js";

/** Distance from the true bottom still treated as "scrolled to end". */
const CHART_KEY_END_PX = 8;

function isNearScrollEnd(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= CHART_KEY_END_PX;
}

/**
 * Layer 2 — the production chart key (design-manifest §4 / recognition-over-
 * recall). Collapsed-by-default legend of every task state and registered
 * identity so production users never have to memorise fog = stalled, which
 * mark is a model maker, or which coat is a harness. The DEV kit band stays as living documentation of the
 * chrome kit; this is the operator-facing subset. Memoized like
 * `SettingsBar` — the cockpit shell re-renders every second for its clock,
 * and this content never changes.
 */
export const ChartKey = memo(function ChartKey() {
  const [open, setOpen] = useState(false);
  /** True while overflow content remains below the fold (fade / "more" cue). */
  const [moreBelow, setMoreBelow] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const measureMoreBelow = useCallback(() => {
    const el = popRef.current;
    if (!el) {
      setMoreBelow(false);
      return;
    }
    const overflows = el.scrollHeight > el.clientHeight + 1;
    setMoreBelow(overflows && !isNearScrollEnd(el));
  }, []);

  const onPopScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      const overflows = el.scrollHeight > el.clientHeight + 1;
      setMoreBelow(overflows && !isNearScrollEnd(el));
    },
    [],
  );

  // Single-open invariant with session Find (and any future hand-rolled peer).
  useEffect(() => {
    return subscribeHandRolledPopoverOpen("chart-key", () => setOpen(false));
  }, []);

  // Announce open so peers close; close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    notifyHandRolledPopoverOpen("chart-key");
    const onPointer = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        // Focus may sit inside the unmounting popover — restore it to the
        // trigger so Escape never strands keyboard users on <body>.
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Measure overflow after open (and on resize) so the fade appears when the
  // Harness coats section is clipped at short viewport heights.
  useLayoutEffect(() => {
    if (!open) {
      setMoreBelow(false);
      return;
    }
    measureMoreBelow();
    const el = popRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureMoreBelow());
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, measureMoreBelow]);

  return (
    <div className="pc-chart-key" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`pc-settings__toggle${open ? " pc-settings__toggle--on" : ""}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">
          <Mark mark={MARK_RING} size={11} />
        </span>{" "}
        Chart key
      </button>
      {open && (
        <div
          id={panelId}
          className="pc-chart-key__pop"
          role="region"
          aria-label="Chart key"
          ref={popRef}
          onScroll={onPopScroll}
        >
          <section className="pc-chart-key__section" aria-label="Task states">
            <h3 className="pc-chart-key__heading">States</h3>
            <ul className="pc-chart-key__list">
              {ATTENTION_DISPLAY_ORDER.map((key) => {
                const meta = STATE_META[key];
                const dotStyle = { "--dot-color": meta.colorVar } as CSSProperties;
                return (
                  <li className="pc-chart-key__row" key={key}>
                    <span className="pc-state-dot pc-chart-key__dot" style={dotStyle} aria-hidden="true">
                      <Mark mark={meta.mark} size={10} />
                    </span>
                    <span className="pc-chart-key__copy">
                      <span className="pc-chart-key__label" style={{ color: meta.colorVar }}>
                        {meta.label}
                      </span>
                      <span className="pc-chart-key__hint">{meta.hint}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
          <section className="pc-chart-key__section" aria-label="Model makers">
            <h3 className="pc-chart-key__heading">Model marks</h3>
            <ul className="pc-chart-key__list">
              {Object.values(MODEL_VENDORS).map((vendor) => (
                <li className="pc-chart-key__row" key={vendor.label}>
                  <Emblem coat="var(--brass-frame)" mark={vendor.emblem} size={20} label={vendor.label} />
                  <span className="pc-chart-key__label pc-chart-key__label--faction">
                    {vendor.label}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="pc-chart-key__section" aria-label="Task harnesses">
            <h3 className="pc-chart-key__heading">Harness coats</h3>
            <ul className="pc-chart-key__list">
              {Object.values(HARNESS_COLORS).map((harness) => (
                <li className="pc-chart-key__row" key={harness.label}>
                  <Emblem coat={harness.coat} mark={COAT_SWATCH} size={20} label={`${harness.label} harness`} />
                  <span className="pc-chart-key__label pc-chart-key__label--faction">
                    {harness.label}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          {/* Recognition over recall — power-user accelerators (useCockpitKeys). */}
          <section className="pc-chart-key__section" aria-label="Keyboard shortcuts">
            <h3 className="pc-chart-key__heading">Keys</h3>
            <ul className="pc-chart-key__list">
              {KEYBOARD_SHORTCUTS.map((row) => (
                <li className="pc-chart-key__row pc-chart-key__row--key" key={row.key}>
                  <kbd className="pc-chart-key__kbd">{row.key}</kbd>
                  <span className="pc-chart-key__hint">{row.hint}</span>
                </li>
              ))}
            </ul>
          </section>
          {/* Sticky bottom fade + "more below" cue — new classes only (hud.css end). */}
          <div
            className={`pc-chart-key__scroll-cue${moreBelow ? "" : " pc-chart-key__scroll-cue--hidden"}`}
            aria-hidden="true"
          >
            <span className="pc-chart-key__scroll-cue-label">More below</span>
          </div>
        </div>
      )}
    </div>
  );
});

const COAT_SWATCH: EmblemMark = { kind: "glyph", char: "◆" };
