/**
 * Register-styled Field (text) and Select — replacements for native OS chrome.
 * Density floor: control height ≥24px (DESIGN.md 24–30px rows).
 */
import type {
  ChangeEvent,
  ReactNode,
  SelectHTMLAttributes,
  InputHTMLAttributes,
} from "react";

export interface FieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "onChange"> {
  label?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  controlClassName?: string;
  testId?: string;
}

export function Field({
  label,
  value,
  onChange,
  className = "",
  controlClassName = "",
  testId,
  id,
  type = "text",
  ...rest
}: FieldProps) {
  const control = (
    <input
      id={id}
      type={type}
      className={`pc-field__control ${controlClassName}`.trim()}
      value={value}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      data-testid={testId}
      autoComplete={rest.autoComplete ?? "off"}
      spellCheck={rest.spellCheck ?? false}
      {...rest}
    />
  );

  if (label == null) {
    return <span className={`pc-field ${className}`.trim()}>{control}</span>;
  }

  return (
    <label className={`pc-field ${className}`.trim()}>
      <span className="pc-field__label">{label}</span>
      {control}
    </label>
  );
}

export interface SelectProps
  extends Omit<
    SelectHTMLAttributes<HTMLSelectElement>,
    "className" | "onChange" | "value"
  > {
  label?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
  controlClassName?: string;
  testId?: string;
  /** Row layout (label beside control) vs stacked. */
  layout?: "stack" | "inline";
}

export function Select({
  label,
  value,
  onChange,
  children,
  className = "",
  controlClassName = "",
  testId,
  id,
  layout = "stack",
  "aria-label": ariaLabel,
  ...rest
}: SelectProps) {
  const control = (
    <span className="pc-select__wrap">
      <select
        id={id}
        className={`pc-select__control ${controlClassName}`.trim()}
        value={value}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
        data-testid={testId}
        aria-label={ariaLabel}
        {...rest}
      >
        {children}
      </select>
    </span>
  );

  if (label == null) {
    return (
      <span
        className={`pc-select ${layout === "inline" ? "pc-select--inline" : ""} ${className}`.trim()}
      >
        {control}
      </span>
    );
  }

  return (
    <label
      className={`pc-select ${layout === "inline" ? "pc-select--inline" : ""} ${className}`.trim()}
    >
      <span className="pc-select__label">{label}</span>
      {control}
    </label>
  );
}
