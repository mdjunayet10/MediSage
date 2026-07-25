import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SelectMenu from "./SelectMenu.jsx";

const options = [
  { value: "balanced", label: "Balanced", description: "Moderate detail" },
  { value: "concise", label: "Concise", description: "Short answer" },
  {
    value: "study-notes",
    label: "Study notes",
    description: "Revision format",
  },
];
afterEach(cleanup);

describe("SelectMenu accessibility", () => {
  it("closes on Escape and returns focus to the trigger", async () => {
    render(
      <SelectMenu
        value="balanced"
        options={options}
        onChange={vi.fn()}
        ariaLabel="Response style"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Response style" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("supports Arrow keys and Enter selection", () => {
    const onChange = vi.fn();
    render(
      <SelectMenu
        value="balanced"
        options={options}
        onChange={onChange}
        ariaLabel="Response style"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Response style" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("concise");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("reports aria-expanded and selected option semantics", () => {
    render(
      <SelectMenu
        value="balanced"
        options={options}
        onChange={vi.fn()}
        ariaLabel="Response style"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Response style" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen
        .getByRole("option", { name: /Balanced/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
});
