/** @vitest-environment happy-dom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  COCKPIT_DOCUMENT_TITLE,
  formatCockpitDocumentTitle,
  useCockpitDocumentTitle,
} from "../src/app/hooks/useCockpit.js";

afterEach(() => {
  document.title = "";
});

describe("formatCockpitDocumentTitle", () => {
  it("uses the base title at zero awaiting tasks", () => {
    expect(formatCockpitDocumentTitle(0)).toBe(COCKPIT_DOCUMENT_TITLE);
    expect(COCKPIT_DOCUMENT_TITLE).toBe("Parley Cove — parley cockpit");
  });

  it("prefixes the inbox count when tasks need the user", () => {
    expect(formatCockpitDocumentTitle(1)).toBe("(1) Parley Cove — parley cockpit");
    expect(formatCockpitDocumentTitle(3)).toBe("(3) Parley Cove — parley cockpit");
  });
});

describe("useCockpitDocumentTitle", () => {
  it("reflects the awaiting count in document.title and restores at zero", () => {
    const { rerender, unmount } = renderHook(
      ({ n }: { n: number }) => useCockpitDocumentTitle(n),
      { initialProps: { n: 0 } },
    );
    expect(document.title).toBe(COCKPIT_DOCUMENT_TITLE);

    act(() => {
      rerender({ n: 2 });
    });
    expect(document.title).toBe("(2) Parley Cove — parley cockpit");

    act(() => {
      rerender({ n: 0 });
    });
    expect(document.title).toBe(COCKPIT_DOCUMENT_TITLE);

    act(() => {
      rerender({ n: 1 });
    });
    expect(document.title).toBe("(1) Parley Cove — parley cockpit");

    // Cleanup restores the base title (e.g. leaving the cockpit route).
    unmount();
    expect(document.title).toBe(COCKPIT_DOCUMENT_TITLE);
  });
});
