import type { RunnerLeaseSpec } from "@useparley/daemon/engine.js";

/** Thin HTTP client for the daemon's `/runner/*` surface. */
export class RunnerClient {
  constructor(
    private readonly daemonUrl: string,
    private readonly token: string,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      ...extra,
    };
  }

  /**
   * Long-poll for a task. Returns the lease spec, or null on 204 (nothing
   * within the poll window).
   */
  async lease(runnerName: string): Promise<RunnerLeaseSpec | null> {
    const res = await fetch(`${this.daemonUrl}/runner/lease`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ runner: runnerName }),
    });
    if (res.status === 204) return null;
    if (res.status === 401) {
      throw new Error("runner auth failed (401): check name/token against daemon runners.*");
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`lease failed (${res.status}): ${body}`);
    }
    return (await res.json()) as RunnerLeaseSpec;
  }

  async heartbeat(taskId: string): Promise<void> {
    const res = await fetch(`${this.daemonUrl}/runner/tasks/${encodeURIComponent(taskId)}/heartbeat`, {
      method: "POST",
      headers: this.headers(),
      body: "{}",
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`heartbeat failed (${res.status}): ${body}`);
    }
  }

  async events(taskId: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const res = await fetch(`${this.daemonUrl}/runner/tasks/${encodeURIComponent(taskId)}/events`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ lines }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`events failed (${res.status}): ${body}`);
    }
  }

  async branch(taskId: string, branch: string): Promise<void> {
    const res = await fetch(`${this.daemonUrl}/runner/tasks/${encodeURIComponent(taskId)}/branch`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ branch }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`branch failed (${res.status}): ${body}`);
    }
  }

  async fail(taskId: string, error: string): Promise<void> {
    const res = await fetch(`${this.daemonUrl}/runner/tasks/${encodeURIComponent(taskId)}/fail`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ error }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`fail failed (${res.status}): ${body}`);
    }
  }
}
