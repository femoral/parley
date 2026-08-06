/**
 * Roving tabindex for dense tables (ARIA grid pattern).
 * One tab stop per table; ArrowUp/Down move focus between rows.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

export function useRovingTabindex(rowCount: number, resetKey?: string) {
  const [activeIndex, setActiveIndex] = useState(0);
  const rowRefs = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    setActiveIndex(0);
    rowRefs.current = rowRefs.current.slice(0, rowCount);
  }, [rowCount, resetKey]);

  const setRowRef = useCallback((index: number, el: HTMLElement | null) => {
    rowRefs.current[index] = el;
  }, []);

  const focusIndex = useCallback((index: number) => {
    if (rowCount <= 0) return;
    const next = Math.max(0, Math.min(rowCount - 1, index));
    setActiveIndex(next);
    // Defer focus until after React commits tabIndex.
    requestAnimationFrame(() => {
      rowRefs.current[next]?.focus();
    });
  }, [rowCount]);

  const onRowKeyDown = useCallback(
    (index: number, onActivate: () => void) =>
      (e: KeyboardEvent) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          focusIndex(index + 1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          focusIndex(index - 1);
          return;
        }
        if (e.key === "Home") {
          e.preventDefault();
          focusIndex(0);
          return;
        }
        if (e.key === "End") {
          e.preventDefault();
          focusIndex(rowCount - 1);
          return;
        }
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      },
    [focusIndex, rowCount],
  );

  const tabIndexFor = useCallback(
    (index: number) => (index === activeIndex ? 0 : -1),
    [activeIndex],
  );

  return { setRowRef, onRowKeyDown, tabIndexFor, activeIndex, focusIndex };
}
