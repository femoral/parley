/**
 * Writable git-metadata grant follows the adapter declaration, not a vendor
 * id (#385). The helper is the engine/runner seam; it never sees a vendor name.
 */
import { describe, expect, it } from "vitest";
import { gitMetadataFields } from "../src/adapter.js";

const PRIVATE = "/repo/.git/worktrees/t1";
const COMMON = "/repo/.git";

const resolve = {
  gitDir: () => PRIVATE,
  gitCommonDir: () => COMMON,
};

describe("gitMetadataFields (#385)", () => {
  it("attaches both gitdirs when the adapter declares the need and the task has a worktree", () => {
    // A non-codex adapter that declares the need still gets the grant.
    expect(gitMetadataFields({ writableGitMetadata: true }, "/wt", resolve)).toEqual({
      gitDir: PRIVATE,
      gitCommonDir: COMMON,
    });
  });

  it("attaches nothing when the adapter does not declare the need, even with a worktree", () => {
    // A codex-shaped worktree still gets no grant if the declaration is false.
    expect(gitMetadataFields({ writableGitMetadata: false }, "/wt", resolve)).toEqual({});
  });

  it("attaches nothing for a --cwd task (no parley worktree), even when declared", () => {
    expect(gitMetadataFields({ writableGitMetadata: true }, null, resolve)).toEqual({});
  });

  it("omits a field when that resolver degrades rather than throwing", () => {
    expect(
      gitMetadataFields({ writableGitMetadata: true }, "/wt", {
        gitDir: () => PRIVATE,
        gitCommonDir: () => undefined,
      }),
    ).toEqual({ gitDir: PRIVATE });
    expect(
      gitMetadataFields({ writableGitMetadata: true }, "/wt", {
        gitDir: () => undefined,
        gitCommonDir: () => COMMON,
      }),
    ).toEqual({ gitCommonDir: COMMON });
  });

  it("never consults resolvers when the declaration is false or there is no worktree", () => {
    const boom = (): string => {
      throw new Error("resolver must not run");
    };
    expect(
      gitMetadataFields({ writableGitMetadata: false }, "/wt", {
        gitDir: boom,
        gitCommonDir: boom,
      }),
    ).toEqual({});
    expect(
      gitMetadataFields({ writableGitMetadata: true }, null, {
        gitDir: boom,
        gitCommonDir: boom,
      }),
    ).toEqual({});
  });
});
