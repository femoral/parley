/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Shell } from "../src/Shell.js";

afterEach(() => {
  cleanup();
});

describe("Shell frame", () => {
  it("renders the chrome board with brand mark and center placeholder", () => {
    render(<Shell />);
    expect(screen.getByTestId("shell")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Parley" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Parley Console" })).toBeTruthy();
    expect(screen.getByText("@useparley/dashboard")).toBeTruthy();
  });
});
