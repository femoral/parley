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

function formatPurgedDate(iso: string | null): string | null {
  if (iso == null || iso === "") return null;
  // Prefer YYYY-MM-DD (daemon note style) without inventing a locale clock.
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

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
      {/* Scrollports rule: clipped region needs tabIndex + named region role. */}
      <div
        className="pc-dlv__well pc-dlv__well--report"
        role="region"
        tabIndex={0}
        aria-label={`Inline value for ${item.address}`}
      >
        <pre className="pc-dlv__json">{item.json}</pre>
      </div>
    </article>
  );
}

function ReferenceDeliverable({
  item,
}: {
  item: Extract<InspectorDeliverable, { treatment: "reference" }>;
}) {
  const missing = item.exists === false;
  return (
    <article
      className={`pc-dlv pc-dlv--reference${missing ? " pc-dlv--missing" : ""}`}
      data-treatment="reference"
      data-kind={item.kind}
      data-exists={item.exists == null ? "unknown" : item.exists ? "true" : "false"}
      data-dlv-id={item.id}
    >
      <header className="pc-dlv__head">
        <span className="pc-dlv__kind">{item.kind}</span>
        <span className="pc-dlv__address" title={item.address}>
          {item.address}
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
        {missing && (
          <p className="pc-dlv__missing-note" role="note">
            {item.note ??
              "Worktree removed; file deliverables do not outlive their workspace."}
          </p>
        )}
      </div>
    </article>
  );
}

function PurgedDeliverable({
  item,
}: {
  item: Extract<InspectorDeliverable, { treatment: "purged" }>;
}) {
  const date = formatPurgedDate(item.purgedAt);
  return (
    <article
      className="pc-dlv pc-dlv--purged"
      data-treatment="purged"
      data-kind={item.kind}
      data-dlv-id={item.id}
    >
      <header className="pc-dlv__head">
        {/* Kind first — purged is a state of the kind, not a fourth kind. */}
        <span className="pc-dlv__kind">{item.kind}</span>
        <span className="pc-dlv__state">purged</span>
        <span className="pc-dlv__address" title={item.address}>
          {item.address}
        </span>
      </header>
      <div className="pc-dlv__well pc-dlv__well--purged">
        <p className="pc-dlv__purged-lead">
          Retention cleared this value
          {date ? ` on ${date}` : ""}. The address is all that survives.
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

  const anyPurged = deliverables.items.some((i) => i.treatment === "purged");

  return (
    <section className="pc-dlv-stack" aria-label="Deliverables">
      <h3 className="pc-dlv-stack__title">Deliverables</h3>
      {/* One live region for the stack, not one per purged card (F6). */}
      {anyPurged && (
        <p className="pc-visually-hidden" role="status">
          Some deliverables on this run have been purged by retention.
        </p>
      )}
      <div className="pc-dlv-stack__list">
        {deliverables.items.map((item) => (
          <DeliverableCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
