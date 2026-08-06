/** Skip links — first focusables for keyboard walk. */
import type { MouseEvent } from "react";

export function SkipLinks() {
  const focusTarget = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    const el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    el.focus();
    // Keep hash for deep-link shareability without relying on native jump alone.
    if (id === "main-content" || id === "shell-nav" || id === "find-input-target") {
      /* focus is the contract; hash optional */
    }
  };

  return (
    <div className="pc-skip" data-testid="skip-links">
      <a className="pc-skip__link" href="#shell-nav" onClick={focusTarget("shell-nav")}>
        Skip to navigation
      </a>
      <a
        className="pc-skip__link"
        href="#find-input-target"
        onClick={(e) => {
          e.preventDefault();
          const wrap = document.getElementById("find-input-target");
          const input = wrap?.querySelector<HTMLElement>("[data-testid='find-input']");
          (input ?? wrap)?.focus();
        }}
      >
        Skip to find
      </a>
      <a
        className="pc-skip__link"
        href="#main-content"
        data-testid="skip-main"
        onClick={focusTarget("main-content")}
      >
        Skip to main content
      </a>
    </div>
  );
}
