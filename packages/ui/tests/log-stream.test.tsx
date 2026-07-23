/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LogStream, logStreamStatus } from "../src/hud/LogStream.js";
import type { LogLine } from "../src/hud/types.js";

afterEach(cleanup);

function logLines(...texts: string[]): LogLine[] {
  return texts.map((text, i) => ({ key: i, kind: "stdout" as const, text }));
}

/**
 * happy-dom does not perform real layout, so overflow geometry must be mocked
 * for stick-to-bottom assertions. Returns a handle that can grow content and
 * read/write scrollTop through the same accessors the component uses.
 */
function mockOverflow(
  el: HTMLElement,
  opts: { scrollHeight: number; clientHeight: number; scrollTop?: number },
): {
  scrollTop: number;
  setScrollHeight: (h: number) => void;
} {
  let scrollHeight = opts.scrollHeight;
  let scrollTop = opts.scrollTop ?? 0;
  const clientHeight = opts.clientHeight;

  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });

  return {
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = value;
    },
    setScrollHeight(h: number) {
      scrollHeight = h;
    },
  };
}

function bodyOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".pc-logstream__body");
  if (!(el instanceof HTMLElement)) throw new Error("expected .pc-logstream__body");
  return el;
}

describe("LogStream stick-to-bottom follow behaviour", () => {
  it("pins to the tail when new lines arrive while the view is at the bottom", () => {
    const { container, rerender } = render(<LogStream lines={logLines("one", "two")} live />);
    const body = bodyOf(container);
    const metrics = mockOverflow(body, { scrollHeight: 400, clientHeight: 100, scrollTop: 300 });
    // Near-bottom: remaining distance 0 — establish stick state via scroll.
    fireEvent.scroll(body);

    metrics.setScrollHeight(600);
    rerender(<LogStream lines={logLines("one", "two", "three", "four")} live />);

    expect(metrics.scrollTop).toBe(600);
  });

  it("does not yank the view down when the user has scrolled up to read history", () => {
    const { container, rerender } = render(<LogStream lines={logLines("one", "two", "three")} live />);
    const body = bodyOf(container);
    const metrics = mockOverflow(body, { scrollHeight: 500, clientHeight: 100, scrollTop: 0 });
    fireEvent.scroll(body);

    metrics.setScrollHeight(700);
    rerender(<LogStream lines={logLines("one", "two", "three", "four", "five")} live />);

    expect(metrics.scrollTop).toBe(0);
  });

  it("re-pins after the user scrolls back to the bottom", () => {
    const { container, rerender } = render(<LogStream lines={logLines("a", "b", "c")} live />);
    const body = bodyOf(container);
    const metrics = mockOverflow(body, { scrollHeight: 500, clientHeight: 100, scrollTop: 50 });
    fireEvent.scroll(body);

    // Return to the tail (within the stick threshold).
    metrics.scrollTop = 400;
    fireEvent.scroll(body);

    metrics.setScrollHeight(800);
    rerender(<LogStream lines={logLines("a", "b", "c", "d", "e")} live />);

    expect(metrics.scrollTop).toBe(800);
  });

  it("opens scrolled to the tail on first non-empty paint, even when not live", () => {
    // Mount empty first so overflow geometry can be mocked before the lines
    // effect runs — happy-dom has no real layout on the initial paint.
    const { container, rerender } = render(<LogStream lines={[]} live={false} />);
    const body = bodyOf(container);
    const metrics = mockOverflow(body, { scrollHeight: 900, clientHeight: 160, scrollTop: 0 });

    rerender(<LogStream lines={logLines("done", "eof")} live={false} />);

    expect(metrics.scrollTop).toBe(900);
    // Tail at eof is Ended, not a temporary Paused.
    expect(container.textContent).toContain("Ended");
    expect(container.textContent).not.toContain("Paused");
  });

  it("starts at the tail again after remount (new task)", () => {
    const first = render(<LogStream lines={logLines("old-task-line")} live />);
    const firstBody = bodyOf(first.container);
    // Scroll up so stick is cleared on this instance.
    mockOverflow(firstBody, { scrollHeight: 500, clientHeight: 100, scrollTop: 0 });
    fireEvent.scroll(firstBody);
    first.unmount();

    // Fresh mount: stick defaults true again; pin when lines update after mock.
    const second = render(<LogStream lines={logLines("new-1", "new-2")} live />);
    const body = bodyOf(second.container);
    const metrics = mockOverflow(body, { scrollHeight: 450, clientHeight: 120, scrollTop: 0 });
    second.rerender(<LogStream lines={logLines("new-1", "new-2", "new-3")} live />);

    expect(metrics.scrollTop).toBe(450);
  });
});

describe("LogStream status wording (honesty over charm)", () => {
  it("maps live+following / live+scrolled / ended distinctly", () => {
    expect(logStreamStatus(true, true)).toBe("Live · Follow");
    expect(logStreamStatus(true, false)).toBe("Paused");
    expect(logStreamStatus(false, true)).toBe("Ended");
    expect(logStreamStatus(false, false)).toBe("Ended");
  });

  it("shows Live · Follow while the tail is live and pinned", () => {
    render(<LogStream lines={logLines("tick")} live />);
    expect(screen.getByText("Live · Follow")).toBeTruthy();
  });

  it("shows Ended when the tail is no longer live (eof), not Paused", () => {
    render(<LogStream lines={logLines("done")} live={false} />);
    expect(screen.getByText("Ended")).toBeTruthy();
    expect(screen.queryByText("Paused")).toBeNull();
  });

  it("shows Paused when the user scrolls up while the stream is still live", () => {
    const { container } = render(<LogStream lines={logLines("a", "b", "c")} live />);
    const body = bodyOf(container);
    mockOverflow(body, { scrollHeight: 500, clientHeight: 100, scrollTop: 0 });
    fireEvent.scroll(body);
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.queryByText("Ended")).toBeNull();
  });

  it("keeps role=log for discoverability but sets aria-live=off to avoid chatter", () => {
    const { container } = render(<LogStream lines={logLines("noise")} live />);
    const body = bodyOf(container);
    expect(body.getAttribute("role")).toBe("log");
    expect(body.getAttribute("aria-live")).toBe("off");
  });

  it("announces status changes from the head, not the log body", () => {
    render(<LogStream lines={logLines("x")} live />);
    const status = screen.getByText("Live · Follow");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
  });
});
