/**
 * Inspector deliverable treatments (#255 / ADR-0021 / F6).
 *
 * Three kinds, three treatments:
 * - `inline` — browsable JSON in a report-tinted well
 * - `file` / `dir` — path + size + explicit "reference only"; no preview/open/download
 * - `purged` — first-class decay empty state (not an error or loading failure)
 *
 * Gates are never actionable here. Bytes are never requested — Cove only
 * renders the projection the hooks layer already resolved.
 */
import type {
  InspectorDeliverable,
  InspectorDeliverables,
} from "../types.js";

function InlineDeliverable({ item }: { item: Extract<InspectorDeliverable, { treatment: "inline" }> }) {
  return (
    <article className="pc-dlv pc-dlv--inline" data-treatment="inline" data-dlv-id={item.id}>
      <header className="pc-dlv__head">
        <span className="pc-dlv__kind">inline</span>
        <span className="pc-dlv__address" title={item.address}>
          {item.address}
        </span>
        {item.typeLabel && (
          <span className="pc-dlv__type" title={item.typeLabel}>
            {item.typeLabel}
          </span>
        )}
      </header>
      <pre className="pc-dlv__well pc-dlv__well--report" tabIndex={0} aria-label={`Inline value for ${item.address}`}>
        {item.json}
      </pre>
    </article>
  );
}

function ReferenceDeliverable({
  item,
}: {
  item: Extract<InspectorDeliverable, { treatment: "reference" }>;
}) {
  return (
    <article
      className="pc-dlv pc-dlv--reference"
      data-treatment="reference"
      data-kind={item.kind}
      data-dlv-id={item.id}
    >
      <header className="pc-dlv__head">
        <span className="pc-dlv__kind">
          {item.kind} · {item.address}
        </span>
      </header>
      <div className="pc-dlv__well">
        {item.path ? (
          <p className="pc-dlv__path" title={item.path}>
            {item.path}
            {item.sizeLabel ? (
              <span className="pc-dlv__size"> · {item.sizeLabel}</span>
            ) : null}
          </p>
        ) : (
          <p className="pc-dlv__path">
            {item.sizeLabel ? (
              <span className="pc-dlv__size">{item.sizeLabel}</span>
            ) : (
              <span className="pc-dlv__size">size unknown</span>
            )}
          </p>
        )}
        <p className="pc-dlv__ref-note">
          reference only — parley never copied these bytes
        </p>
      </div>
    </article>
  );
}

function PurgedDeliverable({
  item,
}: {
  item: Extract<InspectorDeliverable, { treatment: "purged" }>;
}) {
  return (
    <article
      className="pc-dlv pc-dlv--purged"
      data-treatment="purged"
      data-kind={item.kind}
      data-dlv-id={item.id}
    >
      <header className="pc-dlv__head">
        <span className="pc-dlv__kind pc-dlv__kind--purged">purged</span>
        <span className="pc-dlv__address" title={item.address}>
          {item.address}
        </span>
      </header>
      <div className="pc-dlv__well pc-dlv__well--purged" role="status">
        <p className="pc-dlv__purged-lead">
          Decayed past the retention clock. The row is gone; the address is all
          that survives.
        </p>
        {item.note && <p className="pc-dlv__purged-note">{item.note}</p>}
      </div>
    </article>
  );
}

function DeliverableCard({ item }: { item: InspectorDeliverable }) {
  switch (item.treatment) {
    case "inline":
      return <InlineDeliverable item={item} />;
    case "reference":
      return <ReferenceDeliverable item={item} />;
    case "purged":
      return <PurgedDeliverable item={item} />;
  }
}

/**
 * Deliverable stack under the run node table. Omits itself when deliverables
 * were never fetched — an empty section would falsely read as "none".
 */
export function DeliverableView({
  deliverables,
}: {
  deliverables: InspectorDeliverables;
}) {
  if (deliverables.status === "not_fetched") return null;

  if (deliverables.status === "none") {
    return (
      <section className="pc-dlv-stack" aria-label="Deliverables">
        <h3 className="pc-dlv-stack__title">Deliverables</h3>
        <p className="pc-dlv-stack__empty">No deliverables on this run.</p>
      </section>
    );
  }

  return (
    <section className="pc-dlv-stack" aria-label="Deliverables">
      <h3 className="pc-dlv-stack__title">Deliverables</h3>
      <div className="pc-dlv-stack__list">
        {deliverables.items.map((item) => (
          <DeliverableCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
