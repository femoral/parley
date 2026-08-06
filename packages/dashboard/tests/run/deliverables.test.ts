import { describe, expect, it } from "vitest";
import type { DeliverableRef, DeliverableValue } from "@useparley/core";
import {
  projectDeliverableRow,
  projectDeliverablesPanelState,
} from "../../src/screens/run/deliverables.js";

function ref(partial: Partial<DeliverableRef> & Pick<DeliverableRef, "deliverable_id">): DeliverableRef {
  return {
    run_id: "r1",
    node: "plan",
    port: "plan",
    iteration: 1,
    slot: null,
    task_id: "t1",
    kind: "inline",
    type: "text",
    size: { bytes: 42 },
    created_at: "2026-01-01T00:00:00.000Z",
    purged_at: null,
    ...partial,
  };
}

describe("deliverable fetch-state honesty", () => {
  it("not_fetched when value is undefined", () => {
    const row = projectDeliverableRow(ref({ deliverable_id: "d1" }), undefined);
    expect(row.fetchState).toBe("not_fetched");
  });

  it("ready for inline value", () => {
    const r = ref({ deliverable_id: "d1" });
    const value: DeliverableValue = {
      ...r,
      value: { plan: "do it" },
      path: null,
      absolute_path: null,
      exists: null,
      note: null,
    };
    const row = projectDeliverableRow(r, value);
    expect(row.fetchState).toBe("ready");
    expect(row.body).toContain("do it");
  });

  it("purged when purged_at set", () => {
    const r = ref({ deliverable_id: "d2", purged_at: "2026-07-28T00:00:00.000Z", kind: "dir" });
    const row = projectDeliverableRow(r, undefined);
    expect(row.fetchState).toBe("purged");
    expect(row.meta).toMatch(/purged/);
  });

  it("missing-worktree when path exists === false", () => {
    const r = ref({ deliverable_id: "d3", kind: "file" });
    const value: DeliverableValue = {
      ...r,
      value: null,
      path: ".parley/runs/x/plan.1/out",
      absolute_path: "/tmp/x",
      exists: false,
      note: "worktree removed",
    };
    const row = projectDeliverableRow(r, value);
    expect(row.fetchState).toBe("missing-worktree");
    expect(row.meta).toMatch(/missing/);
  });

  it("error on fetch failure", () => {
    const row = projectDeliverableRow(ref({ deliverable_id: "d4" }), null, "boom");
    expect(row.fetchState).toBe("error");
    expect(row.body).toBe("boom");
  });

  it("panel none when no refs", () => {
    const p = projectDeliverablesPanelState({
      refs: [],
      rows: [],
      loading: false,
      listError: null,
    });
    expect(p.status).toBe("none");
  });

  it("id-stub refs use unknown kind, not INLINE (OPTIONAL #15)", () => {
    const stub = ref({
      deliverable_id: "d-stub",
      node: "",
      port: "",
      kind: "inline",
    });
    const row = projectDeliverableRow(stub, undefined);
    expect(row.kindDisplay).toBe("unknown");
  });

  it("panel label leads with dominant state, not ready for zero ready (REQUIRED #13)", () => {
    const purgedRef = ref({
      deliverable_id: "d-p",
      purged_at: "2026-07-28T00:00:00.000Z",
      kind: "dir",
    });
    const purgedRow = projectDeliverableRow(purgedRef, undefined);
    const p = projectDeliverablesPanelState({
      refs: [purgedRef],
      rows: [purgedRow],
      loading: false,
      listError: null,
    });
    expect(p.label.startsWith("ready")).toBe(false);
    expect(p.label).toMatch(/purged/);
  });
});
