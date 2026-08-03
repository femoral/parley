import { describe, expect, it } from "vitest";
import { normalizeRepoKey, stripFetchUrlCredentials } from "../src/repo-key.js";

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

  it("drops credentials from the key", () => {
    expect(
      normalizeRepoKey("https://user:token@github.com/femoral/parley.git"),
    ).toBe("github.com/femoral/parley");
  });

  it("strips well-known default ports but keeps non-default ports", () => {
    expect(normalizeRepoKey("ssh://git@github.com:22/femoral/parley.git")).toBe(
      "github.com/femoral/parley",
    );
    expect(normalizeRepoKey("https://github.com:443/femoral/parley.git")).toBe(
      "github.com/femoral/parley",
    );
    expect(normalizeRepoKey("http://example.com:80/org/repo.git")).toBe(
      "example.com/org/repo",
    );
    expect(normalizeRepoKey("git://example.com:9418/org/repo.git")).toBe(
      "example.com/org/repo",
    );
    // Non-default port is part of identity (different server).
    expect(normalizeRepoKey("https://github.com:8443/femoral/parley.git")).toBe(
      "github.com:8443/femoral/parley",
    );
    expect(normalizeRepoKey("ssh://git@github.com:2222/femoral/parley.git")).toBe(
      "github.com:2222/femoral/parley",
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

  it("folds bracketed IPv6 scp-like with ssh:// IPv6", () => {
    const scp = normalizeRepoKey("git@[2001:db8::1]:org/repo.git");
    const ssh = normalizeRepoKey("ssh://git@[2001:db8::1]/org/repo.git");
    expect(scp).toBe("2001:db8::1/org/repo");
    expect(ssh).toBe(scp);
  });

  it("folds percent-encoded HTTPS paths with scp raw paths", () => {
    const scp = normalizeRepoKey("git@host:org/ré po.git");
    const https = normalizeRepoKey("https://host/org/r%C3%A9%20po.git");
    expect(scp).toBe(https);
    expect(scp).toBe("host/org/ré po");
  });

  it("collapses duplicate slashes in the path", () => {
    expect(normalizeRepoKey("https://host/org//repo.git")).toBe("host/org/repo");
    expect(normalizeRepoKey("git@host:org//repo.git")).toBe("host/org/repo");
  });

  it("returns null for empty, file, and bare local paths", () => {
    expect(normalizeRepoKey("")).toBeNull();
    expect(normalizeRepoKey("   ")).toBeNull();
    expect(normalizeRepoKey("file:///tmp/foo.git")).toBeNull();
    expect(normalizeRepoKey("/tmp/local/path")).toBeNull();
    expect(normalizeRepoKey("C:\\Users\\me\\repo")).toBeNull();
  });
});

describe("stripFetchUrlCredentials", () => {
  it("strips userinfo from HTTPS token-clone URLs", () => {
    expect(
      stripFetchUrlCredentials(
        "https://x-access-token:ghp_SECRETtoken@github.com/org/repo.git",
      ),
    ).toBe("https://github.com/org/repo.git");
  });

  it("strips userinfo but keeps non-default ports", () => {
    expect(
      stripFetchUrlCredentials("https://user:pass@example.com:8443/org/repo.git"),
    ).toBe("https://example.com:8443/org/repo.git");
  });

  it("leaves scp-like forms unchanged", () => {
    expect(stripFetchUrlCredentials("git@github.com:org/repo.git")).toBe(
      "git@github.com:org/repo.git",
    );
  });

  it("returns credential-free URLs unchanged", () => {
    expect(stripFetchUrlCredentials("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git",
    );
  });

  it("handles git+https with embedded credentials", () => {
    expect(
      stripFetchUrlCredentials("git+https://token:x@github.com/org/repo.git"),
    ).toBe("git+https://github.com/org/repo.git");
  });
});
