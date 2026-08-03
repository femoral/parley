import { describe, expect, it } from "vitest";
import { normalizeRepoKey } from "../src/repo-key.js";

describe("normalizeRepoKey", () => {
  it("folds SSH and HTTPS clones of the same repo to one key", () => {
    const ssh = normalizeRepoKey("git@github.com:femoral/parley.git");
    const https = normalizeRepoKey("https://github.com/femoral/parley.git");
    expect(ssh).toBe("github.com/femoral/parley");
    expect(https).toBe(ssh);
  });

  it("case-folds host and path", () => {
    expect(normalizeRepoKey("git@GitHub.com:Femoral/Parley.git")).toBe(
      "github.com/femoral/parley",
    );
    expect(normalizeRepoKey("https://GitHub.COM/Femoral/Parley")).toBe(
      "github.com/femoral/parley",
    );
  });

  it("strips a trailing .git only", () => {
    expect(normalizeRepoKey("https://github.com/org/repo.git")).toBe(
      "github.com/org/repo",
    );
    expect(normalizeRepoKey("https://github.com/org/repo")).toBe(
      "github.com/org/repo",
    );
    // Nested path with .git mid-segment is uncommon; only a trailing suffix is stripped.
    expect(normalizeRepoKey("https://github.com/org/repo.git/extra")).toBe(
      "github.com/org/repo.git/extra",
    );
  });

  it("accepts ssh:// and git+ssh:// forms", () => {
    expect(normalizeRepoKey("ssh://git@github.com/femoral/parley.git")).toBe(
      "github.com/femoral/parley",
    );
    expect(normalizeRepoKey("git+ssh://git@github.com/femoral/parley.git")).toBe(
      "github.com/femoral/parley",
    );
    expect(normalizeRepoKey("git+https://github.com/femoral/parley.git")).toBe(
      "github.com/femoral/parley",
    );
  });

  it("drops credentials and ports from the key", () => {
    expect(
      normalizeRepoKey("https://user:token@github.com/femoral/parley.git"),
    ).toBe("github.com/femoral/parley");
    expect(normalizeRepoKey("ssh://git@github.com:22/femoral/parley.git")).toBe(
      "github.com/femoral/parley",
    );
  });

  it("handles nested group paths", () => {
    expect(normalizeRepoKey("git@gitlab.com:group/sub/repo.git")).toBe(
      "gitlab.com/group/sub/repo",
    );
    expect(normalizeRepoKey("https://gitlab.com/group/sub/repo.git")).toBe(
      "gitlab.com/group/sub/repo",
    );
  });

  it("returns null for empty, file, and bare local paths", () => {
    expect(normalizeRepoKey("")).toBeNull();
    expect(normalizeRepoKey("   ")).toBeNull();
    expect(normalizeRepoKey("file:///tmp/foo.git")).toBeNull();
    expect(normalizeRepoKey("/tmp/local/path")).toBeNull();
    expect(normalizeRepoKey("C:\\Users\\me\\repo")).toBeNull();
  });
});
