import { Mark, Plate } from "../primitives/index.js";
import { MARK_ANCHOR, MARK_SPARK } from "../tokens/chrome-glyphs.js";

/** The spark–anchor–spark flank beside the engraved title. */
function Flank() {
  return (
    <span className="pc-cartouche__flank" aria-hidden="true">
      <Mark mark={MARK_SPARK} size={11} />
      <Mark mark={MARK_ANCHOR} size={15} />
      <Mark mark={MARK_SPARK} size={11} />
    </span>
  );
}

/** Layer 2 — the title cartouche: PARLEY COVE engraved in brass, flanked by
 * spark–anchor–spark marks, with corner flourishes (design-manifest §4.3). */
export function Cartouche() {
  return (
    <Plate variant="cartouche" ornaments padded={false}>
      <div className="pc-cartouche">
        <div className="pc-cartouche__title-row">
          <Flank />
          <h1 className="pc-cartouche__title">PARLEY COVE</h1>
          <Flank />
        </div>
        <span className="pc-cartouche__subtitle">DELEGATED FLEET COCKPIT</span>
      </div>
    </Plate>
  );
}
