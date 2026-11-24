// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  UnsavedChangesProvider,
  useTrackUnsavedChanges,
} from "@amzn/innovation-sandbox-frontend/domains/settings/components/UnsavedChangesGuard";

/** Minimal stand-in for a SectionForm: one input reporting isDirty. */
function DirtyForm() {
  const { register, formState, reset, getValues } = useForm<{ name: string }>({
    defaultValues: { name: "original" },
  });
  useTrackUnsavedChanges("test-section", formState.isDirty);
  return (
    <form>
      <label>
        Name
        <input {...register("name")} />
      </label>
      <button type="button" onClick={() => reset(getValues())}>
        Fake save
      </button>
    </form>
  );
}

function OtherPage() {
  return <h1>Other page</h1>;
}

/**
 * The guard needs a data router (useBlocker). Renders a settings-like page and
 * a second route to navigate to.
 */
function renderWithDataRouter() {
  const router = createMemoryRouter(
    [
      {
        path: "/settings",
        element: (
          <UnsavedChangesProvider>
            <DirtyForm />
            <a href="/other" onClick={(e) => e.preventDefault()}>
              placeholder
            </a>
          </UnsavedChangesProvider>
        ),
      },
      { path: "/other", element: <OtherPage /> },
    ],
    { initialEntries: ["/settings"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("UnsavedChangesProvider", () => {
  it("allows navigation when the form is pristine", async () => {
    const router = renderWithDataRouter();

    await router.navigate("/other");

    expect(await screen.findByText("Other page")).toBeInTheDocument();
    expect(screen.queryByText("Leave page?")).not.toBeInTheDocument();
  });

  it("blocks navigation with a confirmation modal while the form is dirty", async () => {
    const user = userEvent.setup();
    const router = renderWithDataRouter();

    await user.type(screen.getByLabelText("Name"), "-edited");
    await router.navigate("/other");

    // Navigation is intercepted: still on settings, modal shown.
    expect(await screen.findByText("Leave page?")).toBeInTheDocument();
    expect(screen.queryByText("Other page")).not.toBeInTheDocument();
  });

  it("Stay keeps the user on the page with edits intact", async () => {
    const user = userEvent.setup();
    const router = renderWithDataRouter();

    await user.type(screen.getByLabelText("Name"), "-edited");
    await router.navigate("/other");
    await screen.findByText("Leave page?");

    await user.click(screen.getByRole("button", { name: "Stay" }));

    await waitFor(() =>
      expect(screen.queryByText("Leave page?")).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Name")).toHaveValue("original-edited");
  });

  it("Leave proceeds with the navigation, discarding edits", async () => {
    const user = userEvent.setup();
    const router = renderWithDataRouter();

    await user.type(screen.getByLabelText("Name"), "-edited");
    await router.navigate("/other");
    await screen.findByText("Leave page?");

    await user.click(screen.getByRole("button", { name: "Leave" }));

    expect(await screen.findByText("Other page")).toBeInTheDocument();
  });

  it("disarms after the form resets (save success path)", async () => {
    const user = userEvent.setup();
    const router = renderWithDataRouter();

    await user.type(screen.getByLabelText("Name"), "-edited");
    // Simulates SectionForm's post-save methods.reset(values): the form
    // re-baselines on the saved values and is no longer dirty.
    await user.click(screen.getByRole("button", { name: "Fake save" }));

    await router.navigate("/other");

    expect(await screen.findByText("Other page")).toBeInTheDocument();
    expect(screen.queryByText("Leave page?")).not.toBeInTheDocument();
  });

  it("arms the native beforeunload prompt only while dirty", async () => {
    const user = userEvent.setup();
    renderWithDataRouter();
    const dispatchBeforeUnload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      // BeforeUnloadEvent has an independent returnValue field; the generic
      // Event implementation instead exposes the cancellation state here.
      Object.defineProperty(event, "returnValue", {
        value: "",
        writable: true,
      });
      window.dispatchEvent(event);
      return event;
    };

    // Pristine: neither modern nor legacy prompts are armed.
    let event = dispatchBeforeUnload();
    expect(event.defaultPrevented).toBe(false);
    expect(event.returnValue).toBe("");

    await user.type(screen.getByLabelText("Name"), "-edited");
    event = dispatchBeforeUnload();
    expect(event.defaultPrevented).toBe(true);
    expect(event.returnValue).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Fake save" }));
    event = dispatchBeforeUnload();
    expect(event.defaultPrevented).toBe(false);
    expect(event.returnValue).toBe("");
  });
});
