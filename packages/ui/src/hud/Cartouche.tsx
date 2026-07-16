import { Plate } from "../primitives/index.js";

/** Layer 2 — the title cartouche: PARLEY COVE engraved in brass, flanked by
 * `✦ ⚓ ✦`, with corner flourishes (design-manifest §4.3). */
export function Cartouche({ ornaments = true }: { ornaments?: boolean }) {
  return (
    <Plate variant="cartouche" ornaments={ornaments} padded={false}>
      <div className="pc-cartouche">
        <div className="pc-cartouche__title-row">
          <span className="pc-cartouche__flank" aria-hidden="true">
            ✦ ⚓ ✦
          </span>
          <h1 className="pc-cartouche__title">PARLEY COVE</h1>
          <span className="pc-cartouche__flank" aria-hidden="true">
            ✦ ⚓ ✦
          </span>
        </div>
        <span className="pc-cartouche__subtitle">DELEGATED FLEET COCKPIT</span>
      </div>
    </Plate>
  );
}
