import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "success";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /**
   * Loading state: disabled semantics + in-button spinner, no layout shift.
   * Sets `aria-busy` and `disabled` while true.
   */
  loading?: boolean;
  children?: ReactNode;
}

/** Layer 1 — the chrome-kit buttons (design-manifest §4.18). Gold 3D primary,
 * bronze secondary, ghost tertiary, green success (the report's review CTA).
 * Default / hover / focus / active / disabled / loading are all first-class. */
export function Button({
  variant = "primary",
  className,
  type,
  loading = false,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const isDisabled = Boolean(disabled) || loading;
  return (
    <button
      type={type ?? "button"}
      className={[
        "pc-btn",
        `pc-btn--${variant}`,
        loading ? "pc-btn--loading" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...rest}
    >
      <span className="pc-btn__label">{children}</span>
      {loading && <span className="pc-btn__spinner" aria-hidden="true" />}
    </button>
  );
}
