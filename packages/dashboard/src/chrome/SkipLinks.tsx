/** Skip links — first focusables for keyboard walk. */
export function SkipLinks() {
  return (
    <div className="pc-skip" data-testid="skip-links">
      <a className="pc-skip__link" href="#shell-nav">
        Skip to navigation
      </a>
      <a className="pc-skip__link" href="#find-input-target">
        Skip to find
      </a>
      <a className="pc-skip__link" href="#main-content">
        Skip to main content
      </a>
    </div>
  );
}
