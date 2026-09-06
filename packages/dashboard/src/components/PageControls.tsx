import type { useFleetPage } from "../data/useFleetPage.js";

type PageState = Pick<ReturnType<typeof useFleetPage>, "total" | "number" | "loading" | "error" | "hasPrevious" | "hasNext" | "previous" | "next" | "newest" | "refresh">;
export function PageControls({ label, page }: { label: string; page: PageState }) {
  return <nav className="pc-page-controls" aria-label={`${label} pagination`}>
    <span role="status">{page.error ? `Could not load ${label}: ${page.error}` : page.loading && page.total === null ? `Loading ${label}…` : `Page ${page.number} · ${page.total ?? "—"} ${label}`}</span>
    <div>
      <button type="button" onClick={page.newest} disabled={page.loading}>{label.startsWith("attention") ? "First" : "Newest"}</button>
      <button type="button" onClick={page.previous} disabled={!page.hasPrevious || page.loading}>Previous</button>
      <button type="button" onClick={page.next} disabled={!page.hasNext || page.loading}>Next</button>
      {page.error ? <button type="button" onClick={() => void page.refresh()}>Retry</button> : null}
    </div>
  </nav>;
}
