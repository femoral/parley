/**
 * Copy-scaffold control — the console's only "verb".
 * DESIGN.md: bordered mono button; click copies; label confirms.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface CopyScaffoldProps {
  text: string;
  /** Accessible / button mark when idle. */
  label?: string;
  className?: string;
  /** Compact single-line button (default) vs block mono line. */
  variant?: "button" | "block";
  testId?: string;
}

export function CopyScaffold({
  text,
  label = "copy",
  className = "",
  variant = "button",
  testId,
}: CopyScaffoldProps) {
  const [copied, setCopied] = useState(false);
  const [canCopy, setCanCopy] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const textRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (textRef.current) {
        const range = document.createRange();
        range.selectNodeContents(textRef.current);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.execCommand("copy");
        sel?.removeAllRanges();
      } else {
        setCanCopy(false);
        return;
      }
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      if (textRef.current) {
        const range = document.createRange();
        range.selectNodeContents(textRef.current);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setCanCopy(false);
    }
  }, [text]);

  if (variant === "block") {
    return (
      <div
        className={`pc-scaffold pc-scaffold--block ${className}`.trim()}
        data-testid={testId}
      >
        <code ref={textRef} className="pc-scaffold__text" title={text}>
          {text}
        </code>
        {canCopy ? (
          <button
            type="button"
            className="pc-scaffold__btn"
            onClick={() => void copy()}
            aria-label={copied ? "Copied command" : `Copy: ${text}`}
          >
            {copied ? "copied" : label}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`pc-scaffold ${className}`.trim()} data-testid={testId}>
      <span ref={textRef} className="pc-scaffold__hidden" aria-hidden="true">
        {text}
      </span>
      <button
        type="button"
        className="pc-scaffold__btn"
        onClick={() => void copy()}
        aria-label={copied ? "Copied command" : `Copy: ${text}`}
        title={text}
        disabled={!canCopy}
      >
        <span className="pc-scaffold__cmd">{text}</span>
        <span className="pc-scaffold__mark" aria-hidden="true">
          {copied ? "copied" : label}
        </span>
      </button>
    </div>
  );
}
