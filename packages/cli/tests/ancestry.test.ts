/**
 * #162 — client-side process-ancestry walk against a synthesized process table.
 */
import { describe, expect, it } from "vitest";
import {
  parseProcStatLine,
  walkAncestry,
  type ProcessTableEntry,
} from "../src/ancestry.js";

function table(
  rows: ProcessTableEntry[],
): Map<number, ProcessTableEntry> {
  return new Map(rows.map((r) => [r.pid, r]));
}

describe("walkAncestry (#162)", () => {
  it("walks self → parent → grandparent with machine-id on every link", () => {
    const t = table([
      { pid: 100, ppid: 50, start_time: "1000" },
      { pid: 50, ppid: 1, start_time: "500" },
      { pid: 1, ppid: 0, start_time: "1" },
    ]);
    const chain = walkAncestry(t, 100, "machine-abc");
    expect(chain).toEqual([
      { machine_id: "machine-abc", pid: 100, start_time: "1000" },
      { machine_id: "machine-abc", pid: 50, start_time: "500" },
      { machine_id: "machine-abc", pid: 1, start_time: "1" },
    ]);
  });

  it("stops on a missing parent without inventing anchors", () => {
    const t = table([{ pid: 42, ppid: 999, start_time: "7" }]);
    expect(walkAncestry(t, 42, "m")).toEqual([
      { machine_id: "m", pid: 42, start_time: "7" },
    ]);
  });

  it("breaks cycles (does not infinite-loop)", () => {
    const t = table([
      { pid: 10, ppid: 11, start_time: "a" },
      { pid: 11, ppid: 10, start_time: "b" },
    ]);
    const chain = walkAncestry(t, 10, "m");
    expect(chain.map((c) => c.pid)).toEqual([10, 11]);
  });

  it("returns empty when start pid is absent from the table", () => {
    expect(walkAncestry(table([]), 1, "m")).toEqual([]);
  });
});

describe("parseProcStatLine (#162)", () => {
  it("parses a realistic /proc/stat line with spaces in comm", () => {
    // pid=1, comm=(systemd), state=S, ppid=0, … starttime field 22
    const fields = [
      "1",
      "(systemd)",
      "S",
      "0", // ppid
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "12345", // starttime
    ];
    const line = fields.join(" ");
    expect(parseProcStatLine(line)).toEqual({
      pid: 1,
      ppid: 0,
      start_time: "12345",
    });
  });

  it("parses comm with internal spaces/parentheses", () => {
    // After state: ppid + 17 fillers + starttime (field 22).
    const afterComm = ["R", "7", ...Array.from({ length: 17 }, () => "0"), "99999"];
    const line = `42 ((my app)) ${afterComm.join(" ")}`;
    expect(parseProcStatLine(line)).toEqual({
      pid: 42,
      ppid: 7,
      start_time: "99999",
    });
  });
});
