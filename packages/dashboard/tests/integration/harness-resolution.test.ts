/**
 * Guard on the harness's own precondition (#379).
 *
 * Run from the wrong cwd, the fake-vendor bin does not resolve and the daemon
 * silently skips the `fake` vendor — the run then fails with "no capable
 * executor for vendor fake", which points at build/vendor config rather than
 * at the real cause. These tests pin the honest first error.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FAKE_VENDOR_BIN, resolveFakeVendorBin } from "./harness.js";

const REL = "packages/cli/tests/fake-vendor.mjs";

describe("fake-vendor bin resolution (#379)", () => {
  it("returns the bin when it exists under the given base dir", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "parley-fvb-ok-"));
    try {
      const bin = path.join(base, REL);
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, "// stand-in\n");

      expect(resolveFakeVendorBin(base)).toBe(bin);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("throws naming the searched path when the bin is missing", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "parley-fvb-miss-"));
    try {
      const searched = path.join(base, REL);

      expect(() => resolveFakeVendorBin(base)).toThrow(searched);
      expect(() => resolveFakeVendorBin(base)).toThrow(/run from the repo root/i);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("does not prescribe --project, which is not the discriminator", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "parley-fvb-flag-"));
    try {
      expect(() => resolveFakeVendorBin(base)).not.toThrow(/--project/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("resolved the real bin for this run", () => {
    expect(fs.existsSync(FAKE_VENDOR_BIN)).toBe(true);
  });
});
