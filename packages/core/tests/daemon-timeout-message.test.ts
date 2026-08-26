/**
 * #389 — a timed-out daemon request is not an unreachable daemon. Conflating
 * the two sent debugging in the wrong direction: the message said the daemon
 * could not be reached while the process was alive and answering /health in
 * milliseconds, so the obvious next step (is it dead? restart it) was useless.
 * These pin that the two failures read differently.
 */
import { describe, expect, it } from "vitest";
import { unreachableAdvertisedDaemon, type Discovery } from "../src/client.js";

const discovery: Discovery = {
  port: 35055,
  pid: 6224,
  started_at: "2026-08-25T19:20:56.711Z",
};

/** What `fetch` throws when an `AbortSignal.timeout` fires. */
function timeoutError(): Error {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/** What `fetch` throws when nothing is listening. */
function connectError(): Error {
  return new TypeError("fetch failed");
}

describe("unreachableAdvertisedDaemon (#389)", () => {
  it("reports a timeout as slow, not unreachable", () => {
    const msg = unreachableAdvertisedDaemon(discovery, timeoutError());
    expect(msg).toMatch(/did not respond in time/);
    // The specific wrong turn this caused: hunting a dead daemon.
    expect(msg).not.toMatch(/could not reach/);
  });

  it("points at the actual cause rather than leaving it to guesswork", () => {
    const msg = unreachableAdvertisedDaemon(discovery, timeoutError());
    expect(msg).toMatch(/running but too slow/);
    expect(msg).toMatch(/parley gc/);
  });

  it("still reports a genuine connection failure as unreachable", () => {
    const msg = unreachableAdvertisedDaemon(discovery, connectError());
    expect(msg).toMatch(/could not reach the advertised parley daemon/);
    expect(msg).not.toMatch(/did not respond in time/);
  });

  it("identifies the daemon either way, so the right process is inspected", () => {
    for (const err of [timeoutError(), connectError()]) {
      const msg = unreachableAdvertisedDaemon(discovery, err);
      expect(msg).toMatch(/http:\/\/127\.0\.0\.1:35055/);
      expect(msg).toMatch(/pid 6224/);
      expect(msg).toMatch(/2026-08-25T19:20:56\.711Z/);
      expect(msg).toMatch(/The operation was aborted due to timeout|fetch failed/);
    }
  });

  it("does not mistake an unrelated abort for a timeout", () => {
    // A caller-cancelled request (AbortController.abort()) is an AbortError,
    // not a TimeoutError, and must not claim the daemon is merely slow.
    const aborted = new DOMException("This operation was aborted", "AbortError");
    const msg = unreachableAdvertisedDaemon(discovery, aborted);
    expect(msg).toMatch(/could not reach the advertised parley daemon/);
    expect(msg).not.toMatch(/did not respond in time/);
  });
});
