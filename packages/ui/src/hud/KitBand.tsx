import { memo, type CSSProperties } from "react";
import { Button, Divider, Emblem, Mark, Plate, PlateHeader } from "../primitives/index.js";
import { MARK_BANNER, MARK_MALLET } from "../tokens/chrome-glyphs.js";
import { FACTIONS } from "../tokens/factions.js";
import { ATTENTION_DISPLAY_ORDER, STATE_META } from "../tokens/state-meta.js";
import "./KitBand.css";

/**
 * Layer 2 — the HUD kit band (design-manifest §3's bottom strip / §4.21-23,
 * component-system spec contract 5). A style-guide strip — factions, the
 * state legend, and a chrome (button) sample — living documentation of the
 * token system rather than live data, so it takes no props at all. Ships
 * behind the settings bar's "Kit band" toggle, off by default (#70).
 * Memoized like `Inspector`/`RosterPanel`/`InboxPanel` — the cockpit shell
 * re-renders every second for its clock, and this content never changes.
 */
export const KitBand = memo(function KitBand() {
  return (
    <Plate padded={false} className="pc-kit">
      <div className="pc-kit__col pc-kit__col--factions">
        <PlateHeader icon={<Mark mark={MARK_BANNER} size={14} />} iconDark title="FACTIONS" />
        <div className="pc-kit__list">
          {Object.values(FACTIONS).map((faction) => (
            <div className="pc-kit__faction" key={faction.label}>
              <Emblem coat={faction.coat} mark={faction.emblem} size={22} label={faction.label} />
              <div className="pc-kit__faction-copy">
                <span className="pc-kit__faction-label">{faction.label}</span>
                <span className="pc-kit__faction-tagline">{faction.tagline}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Divider vertical />

      <div className="pc-kit__col pc-kit__col--legend">
        <PlateHeader icon="◐" iconDark title="STATE LEGEND" />
        <div className="pc-kit__list">
          {ATTENTION_DISPLAY_ORDER.map((key) => {
            const meta = STATE_META[key];
            const dotStyle = { "--dot-color": meta.colorVar } as CSSProperties;
            return (
              <div className="pc-kit__legend-row" key={key}>
                <span className="pc-state-dot pc-kit__legend-dot" style={dotStyle} aria-hidden="true">
                  <Mark mark={meta.mark} size={10} />
                </span>
                <span className="pc-kit__legend-copy">
                  <span className="pc-kit__legend-label" style={{ color: meta.colorVar }}>
                    {meta.label}
                  </span>
                  <span className="pc-kit__legend-hint">{meta.hint}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <Divider vertical />

      <div className="pc-kit__col pc-kit__col--chrome">
        <PlateHeader icon={<Mark mark={MARK_MALLET} size={14} />} iconDark title="CHROME KIT" />
        <div className="pc-kit__buttons">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="tertiary">Tertiary</Button>
          <Button variant="success">Success</Button>
        </div>
        <div className="pc-kit__buttons" aria-label="Button states">
          <Button variant="primary" disabled>
            Disabled
          </Button>
          <Button variant="primary" loading>
            Loading
          </Button>
          <Button variant="secondary" disabled>
            Disabled
          </Button>
          <Button variant="success" loading>
            Loading
          </Button>
        </div>
      </div>
    </Plate>
  );
});
