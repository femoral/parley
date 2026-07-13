import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "success";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

/** Layer 1 — the chrome-kit buttons (design-manifest §4.18). Gold 3D primary,
 * bronze secondary, ghost tertiary, green success (the report's review CTA). */
export function Button({ variant = "primary", className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={["pc-btn", `pc-btn--${variant}`, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}
