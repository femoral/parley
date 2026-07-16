import { memo, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Emblem, Mark } from "../primitives/index.js";
import { FACTIONS } from "../tokens/factions.js";
import { ATTENTION_DISPLAY_ORDER, STATE_META } from "../tokens/state-meta.js";

/**
 * Layer 2 — the production chart key (design-manifest §4 / recognition-over-
 * recall). Collapsed-by-default legend of every task state and registered
 * faction so production users never have to memorise fog = stalled or which
 * coat is which vendor. Reuses the layer-0 `STATE_META` /
 * `ATTENTION_DISPLAY_ORDER` and `FACTIONS` registries — never re-declares
 * states or vendors. The DEV kit band stays as living documentation of the
 * chrome kit; this is the operator-facing subset. Memoized like
 * `SettingsBar` — the cockpit shell re-renders every second for its clock,
 * and this content never changes.
 */
export const ChartKey = memo(function ChartKey() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="pc-chart-key" ref={rootRef}>
      <button
        type="button"
        className={`pc-settings__toggle${open ? " pc-settings__toggle--on" : ""}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">◉</span> Chart key
      </button>
      {open && (
        <div
          id={panelId}
          className="pc-chart-key__pop"
          role="region"
          aria-label="Chart key"
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
          <section className="pc-chart-key__section" aria-label="Factions">
            <h3 className="pc-chart-key__heading">Factions</h3>
            <ul className="pc-chart-key__list">
              {Object.values(FACTIONS).map((faction) => (
                <li className="pc-chart-key__row" key={faction.label}>
                  <Emblem coat={faction.coat} mark={faction.emblem} size={20} label={faction.label} />
                  <span className="pc-chart-key__label pc-chart-key__label--faction">
                    {faction.label}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
});
