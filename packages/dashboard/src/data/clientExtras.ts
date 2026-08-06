/**
 * Thin helpers for wire endpoints the typed {@link ParleyClient} does not yet
 * wrap (same pattern Cove's useRunners uses for `GET /runners`). Uses only
 * `client.url` + fetch so the browser bundle stays on the core SDK.
 */
import type {
  NodeDetailResponse,
  ParleyClient,
  RunnerListEntry,
  RunnersListResponse,
} from "@useparley/core";

/** `GET /runners` — registered runner fleet. */
export async function fetchRunnersList(client: ParleyClient): Promise<RunnerListEntry[]> {
  const res = await fetch(client.url("/runners"));
  if (!res.ok) {
    throw new Error(`GET /runners failed with status ${res.status}`);
  }
  const body = (await res.json()) as RunnersListResponse;
  return body.runners ?? [];
}

export interface NodeDetailQuery {
  iteration?: number;
  slot?: string;
}

/**
 * `GET /runs/:ref/nodes/:node` — per-node task rows + deliverable refs
 * (wire-verification §2B run-tasks).
 */
export async function fetchNodeDetail(
  client: ParleyClient,
  runRef: string,
  node: string,
  query: NodeDetailQuery = {},
): Promise<NodeDetailResponse> {
  const params = new URLSearchParams();
  if (query.iteration !== undefined) params.set("iteration", String(query.iteration));
  if (query.slot !== undefined && query.slot !== "") params.set("slot", query.slot);
  const qs = params.toString();
  const path =
    `/runs/${encodeURIComponent(runRef)}/nodes/${encodeURIComponent(node)}` +
    (qs === "" ? "" : `?${qs}`);
  const res = await fetch(client.url(path));
  if (!res.ok) {
    let detail = `GET ${path} failed with status ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* keep generic */
    }
    throw new Error(detail);
  }
  return (await res.json()) as NodeDetailResponse;
}
