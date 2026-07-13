/** Layer 1 — the gold divider rule (design-manifest §2.10 / §4.20). */
export function Divider({ className }: { className?: string }) {
  return <hr className={["pc-divider", className].filter(Boolean).join(" ")} aria-hidden="true" />;
}
