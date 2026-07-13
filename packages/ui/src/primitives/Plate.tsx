import type { ReactNode } from "react";
import { Flourish } from "./Flourish.js";

/** The base container's chrome variants (design-manifest §4.1). */
export type PlateVariant = "standard" | "premium" | "cartouche" | "ember" | "report";

export interface PlateProps {
  variant?: PlateVariant;
  /** Draw the four corner flourishes (only meaningful on premium/cartouche). */
  ornaments?: boolean;
  /** Extra class on the plate wrapper. */
  className?: string;
  /** Wrap children in the default padded body; set false for custom layout. */
  padded?: boolean;
  children?: ReactNode;
}

const VARIANT_CLASS: Record<PlateVariant, string> = {
  standard: "",
  premium: "pc-plate--premium",
  cartouche: "pc-plate--cartouche",
  ember: "pc-plate--ember",
  report: "pc-plate--report",
};

/**
 * Layer 1 — the panel plate: the signature double-inset brass chrome
 * (design-manifest §2.10 / §4.1). Dumb and styled; it knows nothing of tasks.
 */
export function Plate({
  variant = "standard",
  ornaments = false,
  className,
  padded = true,
  children,
}: PlateProps) {
  const showFlourishes = ornaments && (variant === "premium" || variant === "cartouche");
  return (
    <div className={["pc-plate", VARIANT_CLASS[variant], className].filter(Boolean).join(" ")}>
      {showFlourishes && (
        <>
          <Flourish corner="tl" />
          <Flourish corner="tr" />
          <Flourish corner="bl" />
          <Flourish corner="br" />
        </>
      )}
      {padded ? <div className="pc-plate__body">{children}</div> : children}
    </div>
  );
}
