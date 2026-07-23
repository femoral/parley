import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

function clipboardAvailable(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
}

export interface CopyScaffold {
  /** True for ~1.5s after a successful copy / select fallback. */
  copied: boolean;
  /** False when neither clipboard nor a scaffold element can serve the copy. */
  canCopy: boolean;
  /** Attach to the off-screen scaffold text used for select-on-click fallback. */
  scaffoldRef: RefObject<HTMLSpanElement | null>;
  /** Copy `text` via clipboard.writeText, or select the scaffold on failure. */
  copy: () => Promise<void>;
}

/**
 * Shared clipboard-copy scaffold used by Roster empty-starter, InboxCard,
 * BriefTab fix, and Inspector task-id copy. Same behavior everywhere:
 * clipboard.writeText → select-on-click fallback → hide the control if both fail;
 * "copied ✓" reverts after 1.5s.
 */
export function useCopyScaffold(text: string): CopyScaffold {
  const [copied, setCopied] = useState(false);
  const [canCopy, setCanCopy] = useState(true);
  const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scaffoldRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    setCanCopy(clipboardAvailable());
    return () => {
      if (revertTimer.current) clearTimeout(revertTimer.current);
    };
  }, []);

  const markCopied = useCallback(() => {
    setCopied(true);
    if (revertTimer.current) clearTimeout(revertTimer.current);
    revertTimer.current = setTimeout(() => setCopied(false), 1500);
  }, []);

  const copy = useCallback(async () => {
    if (clipboardAvailable()) {
      try {
        await navigator.clipboard.writeText(text);
        markCopied();
        return;
      } catch {
        // Fall through to select-on-click fallback.
      }
    }
    const el = scaffoldRef.current;
    if (el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      markCopied();
    } else {
      setCanCopy(false);
    }
  }, [text, markCopied]);

  return { copied, canCopy, scaffoldRef, copy };
}
