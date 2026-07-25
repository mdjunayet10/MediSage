import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import AccountMenu from "./AccountMenu.jsx";

function Location() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

afterEach(() => cleanup());

it("shows restrained guest controls, keeps Google absent, and closes guest information", () => {
  render(<MemoryRouter initialEntries={["/app"]}><AccountMenu user={{ uid: "guest-a", isAnonymous: true }} isGuest /><Location /></MemoryRouter>);
  expect(screen.getByText("Guest")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Guest/i }));
  expect(screen.getByRole("menuitem", { name: "Sign in" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Create account" })).toBeTruthy();
  expect(screen.queryByText("Continue with Google")).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "About guest sessions" }));
  expect(screen.getByRole("dialog", { name: "About guest sessions" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByTestId("location").textContent).toBe("/app");
  fireEvent.click(screen.getByRole("button", { name: /Guest/i }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Sign in" }));
  expect(screen.getByTestId("location").textContent).toBe("/login");
});

it("shows registered profile data only in the menu and invokes sign out", () => {
  const onSignOut = vi.fn();
  render(<MemoryRouter><AccountMenu user={{ uid: "user-a", displayName: "Amina", email: "amina@example.com" }} isGuest={false} onSignOut={onSignOut} /></MemoryRouter>);
  expect(screen.queryByText("amina@example.com")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Amina/i }));
  expect(screen.getByText("amina@example.com")).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
  expect(onSignOut).toHaveBeenCalledOnce();
});
