/**
 * Shell-like $VAR expansion for profile launch templates (#195 / ADR-0015).
 */
import { describe, expect, it } from "vitest";
import { expandLaunchTemplate, expandShellVars } from "../src/template-expand.js";

describe("expandShellVars", () => {
  it("expands $VAR and ${VAR} from env", () => {
    const env = { FOO: "bar", PROMPT: "hello world" };
    expect(expandShellVars("x-$FOO-y", env)).toBe("x-bar-y");
    expect(expandShellVars("p=${PROMPT}", env)).toBe("p=hello world");
  });

  it("expands unset vars to empty string", () => {
    expect(expandShellVars("a=$MISSING/b", {})).toBe("a=/b");
    expect(expandShellVars("${NOPE}", { X: "1" })).toBe("");
  });

  it("expands multiple tokens in one element", () => {
    expect(expandShellVars("$A-$B-$A", { A: "1", B: "2" })).toBe("1-2-1");
  });

  it("leaves non-identifier $ sequences alone", () => {
    expect(expandShellVars("$1 not-var $", {})).toBe("$1 not-var $");
  });
});

describe("expandLaunchTemplate", () => {
  it("maps each argv element", () => {
    const env = { PROMPT: "do it", BIN: "/usr/bin/tool" };
    expect(expandLaunchTemplate(["$BIN", "-p", "$PROMPT", "--flag"], env)).toEqual([
      "/usr/bin/tool",
      "-p",
      "do it",
      "--flag",
    ]);
  });
});
