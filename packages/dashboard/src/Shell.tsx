/**
 * Shell frame — chrome header, left/center/right content regions, footer.
 * Screens (Fleet / Run / Task / Metrics) land in later tickets; this only
 * proves the board geometry and brand mark render under the daemon.
 */
export function Shell() {
  return (
    <div className="pc-shell" data-testid="shell">
      <header className="pc-shell__header">
        <div className="pc-shell__brand">
          <img
            className="pc-shell__mark"
            src="/assets/parleylogo.png"
            alt="Parley"
            width={22}
            height={22}
          />
          <div className="pc-shell__brand-text">
            <span className="pc-shell__brand-name">parley</span>
            <span className="pc-shell__brand-sub">console</span>
          </div>
        </div>

        <div className="pc-shell__divider" aria-hidden="true" />

        <div className="pc-shell__header-meta">
          <div className="pc-shell__status" title="Connecting…">
            <span className="pc-shell__live-dot" aria-hidden="true" />
            <span className="pc-shell__status-label">daemon</span>
            <span className="pc-shell__status-value">—</span>
            <span className="pc-shell__status-meta">scaffold</span>
          </div>
          <div className="pc-shell__divider" aria-hidden="true" />
          <span className="pc-shell__clock" aria-label="clock">
            —
          </span>
        </div>
      </header>

      <div className="pc-shell__body">
        <aside className="pc-shell__rail pc-shell__rail--left" aria-label="Left rail" />
        <main className="pc-shell__center">
          <div className="pc-shell__placeholder">
            <span className="pc-shell__placeholder-label">center screen</span>
            <h1 className="pc-shell__placeholder-title">Parley Console</h1>
            <p className="pc-shell__placeholder-note">
              Shell frame scaffold. Fleet, Run, Task, and Metrics screens land
              in later tickets.
            </p>
          </div>
        </main>
        <aside className="pc-shell__rail pc-shell__rail--right" aria-label="Right rail" />
      </div>

      <footer className="pc-shell__footer">
        <span className="pc-shell__footer-label">legend</span>
        <span className="pc-shell__footer-meta">@useparley/dashboard</span>
      </footer>
    </div>
  );
}
