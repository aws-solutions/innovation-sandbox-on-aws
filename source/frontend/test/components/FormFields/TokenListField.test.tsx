// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import TokenListField from "@amzn/innovation-sandbox-frontend/components/FormFields/TokenListField";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const TestSchema = z.object({
  items: z.array(z.string()).max(2, "At most 2 items"),
});

type TestFormValues = z.infer<typeof TestSchema>;

function TestComponent({
  defaultItems = [],
  maxItems,
  maxItemLength,
  itemNoun,
  sorted,
  onItems,
  readOnly = false,
}: {
  defaultItems?: string[];
  maxItems?: number;
  maxItemLength?: number;
  itemNoun?: string;
  sorted?: boolean;
  readOnly?: boolean;
  // Spy to observe the stored (RHF) value — used to assert dismiss removes the
  // right value even when the sorted display order differs from storage order.
  onItems?: (items: string[]) => void;
}) {
  const methods = useForm<TestFormValues>({
    resolver: zodResolver(TestSchema),
    mode: "all",
    defaultValues: {
      items: defaultItems,
    },
  });

  const items = methods.watch("items");
  useEffect(() => {
    onItems?.(items);
  }, [items, onItems]);

  return (
    <FormProvider {...methods}>
      <TokenListField
        controllerProps={{ control: methods.control, name: "items" }}
        formFieldProps={{
          label: "Items",
          description: "Add some items",
        }}
        inputProps={{
          placeholder: "Add an item and press Enter",
          readOnly,
        }}
        maxItems={maxItems}
        maxItemLength={maxItemLength}
        itemNoun={itemNoun}
        sorted={sorted}
      />
    </FormProvider>
  );
}

describe("TokenListField", () => {
  test("shows read-only entry and tokens without allowing additions or removals", async () => {
    const onItems = vi.fn();
    renderWithQueryClient(
      <TestComponent defaultItems={["alpha"]} readOnly onItems={onItems} />,
    );

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    expect(input).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    const remove = screen.getByRole("button", { name: "Remove alpha" });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(remove);
    expect(screen.getByText("alpha")).toBeInTheDocument();
    await userEvent.type(input, "beta{Enter}");
    expect(input).toHaveValue("");
    expect(screen.queryByText("beta")).not.toBeInTheDocument();
    expect(onItems).toHaveBeenLastCalledWith(["alpha"]);
  });

  test("cannot add an existing draft after switching to read-only", async () => {
    const onItems = vi.fn();
    const { rerender } = render(
      <TestComponent defaultItems={["alpha"]} onItems={onItems} />,
    );
    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await userEvent.type(input, "beta");
    expect(screen.getByRole("button", { name: "Add" })).toBeEnabled();

    rerender(
      <TestComponent defaultItems={["alpha"]} readOnly onItems={onItems} />,
    );
    expect(input).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.click(input);
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByText("beta")).not.toBeInTheDocument();
    expect(onItems).toHaveBeenLastCalledWith(["alpha"]);
  });

  test("renders with label and description", () => {
    renderWithQueryClient(<TestComponent />);

    expect(screen.getByText("Items")).toBeInTheDocument();
    expect(screen.getByText("Add some items")).toBeInTheDocument();
  });

  test("renders existing values as tokens", () => {
    renderWithQueryClient(<TestComponent defaultItems={["alpha", "beta"]} />);

    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
  });

  test("adds a trimmed value on Enter", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "  gamma  {Enter}");

    await waitFor(() => {
      expect(screen.getByText("gamma")).toBeInTheDocument();
    });
    // Draft is cleared once the entry is added.
    expect(input).toHaveValue("");
  });

  test("adds a value via the Add button", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    const addButton = screen.getByRole("button", { name: "Add" });
    // Disabled while the draft is empty.
    expect(addButton).toBeDisabled();

    await user.type(
      screen.getByPlaceholderText("Add an item and press Enter"),
      "gamma",
    );
    expect(addButton).toBeEnabled();
    await user.click(addButton);

    await waitFor(() => {
      expect(screen.getByText("gamma")).toBeInTheDocument();
    });
    expect(
      screen.getByPlaceholderText("Add an item and press Enter"),
    ).toHaveValue("");
  });

  test("ignores duplicate values and keeps the draft", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent defaultItems={["alpha"]} />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "alpha{Enter}");

    // Only the original token exists; the draft text is retained.
    expect(screen.getAllByText("alpha")).toHaveLength(1);
    expect(input).toHaveValue("alpha");
  });

  test("shows an inline message when adding a duplicate and keeps the draft", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent defaultItems={["alpha"]} />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "alpha{Enter}");

    // Still only one token, draft retained (no silent discard) …
    expect(screen.getAllByText("alpha")).toHaveLength(1);
    expect(input).toHaveValue("alpha");
    // … and now a visible message explains why nothing was added.
    expect(screen.getByText(/already been added/i)).toBeInTheDocument();
  });

  test("ignores whitespace-only input", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "   {Enter}");

    expect(input).toHaveValue("   ");
  });

  test("removes a value on token dismiss", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent defaultItems={["alpha", "beta"]} />);

    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    expect(removeButtons).toHaveLength(2);

    await user.click(removeButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    });
    expect(screen.getByText("beta")).toBeInTheDocument();
  });

  test("dismiss removes the right value when sorted display order differs from storage", async () => {
    // Stored out of alphabetical order: sorted display shows [alpha, beta], but
    // storage is [beta, alpha]. Dismissing the FIRST displayed token (alpha,
    // display index 0) must remove "alpha" — which is stored at index 1. An
    // index-based dismiss would wrongly drop storage[0] ("beta"). This is the
    // exact bug the value-based dismiss prevents.
    const user = userEvent.setup();
    const onItems = vi.fn();
    renderWithQueryClient(
      <TestComponent
        defaultItems={["beta", "alpha"]}
        sorted
        onItems={onItems}
      />,
    );

    // Displayed alphabetically, so the first remove button is "Remove alpha".
    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    expect(removeButtons[0]).toHaveAttribute("aria-label", "Remove alpha");
    await user.click(removeButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    });
    // "beta" survives, and the stored value is exactly ["beta"] — the correct
    // value was removed, not storage index 0.
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(onItems).toHaveBeenLastCalledWith(["beta"]);
  });

  test("rejects an item longer than maxItemLength and keeps the draft", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent maxItemLength={5} />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "toolongvalue{Enter}");

    // The over-length entry is not added; the draft text is retained.
    expect(screen.queryByText("toolongvalue")).not.toBeInTheDocument();
    expect(input).toHaveValue("toolongvalue");
    // An inline message explains why.
    expect(screen.getByText(/5 characters or fewer/i)).toBeInTheDocument();
  });

  test("adds an item exactly at maxItemLength", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent maxItemLength={5} />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "12345{Enter}");

    await waitFor(() => {
      expect(screen.getByText("12345")).toBeInTheDocument();
    });
    expect(input).toHaveValue("");
  });

  test("blocks adding once maxItems is reached and keeps the draft", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <TestComponent defaultItems={["a", "b"]} maxItems={2} />,
    );

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "c{Enter}");

    // The third entry is rejected; only the two originals remain.
    expect(screen.queryByText("c")).not.toBeInTheDocument();
    expect(input).toHaveValue("c");
    expect(screen.getByText(/maximum of 2/i)).toBeInTheDocument();
  });

  test("surfaces the over-limit message as a warning, not a red error", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <TestComponent defaultItems={["a", "b"]} maxItems={2} />,
    );

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "c{Enter}");

    // An input-time capacity limit is advisory, not a schema validation error,
    // so it renders in Cloudscape's warning slot (amber) — matching the app's
    // convention for soft limits (e.g. TagEditorField) — never the red error
    // slot, which is reserved for schema/RHF field errors.
    const message = screen.getByText(/maximum of 2/i);
    const styledContainer = message.closest(
      '[class*="warning"], [class*="error"]',
    );
    expect(styledContainer?.className).toMatch(/warning/);
    expect(styledContainer?.className).not.toMatch(/error/);
  });

  test("allows adding up to maxItems, then blocks the next add", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent defaultItems={["a"]} maxItems={2} />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");

    // The last allowed slot is usable.
    await user.type(input, "b{Enter}");
    await waitFor(() => expect(screen.getByText("b")).toBeInTheDocument());
    expect(input).toHaveValue("");

    // The next add is blocked.
    await user.type(input, "c{Enter}");
    expect(screen.queryByText("c")).not.toBeInTheDocument();
    expect(screen.getByText(/maximum of 2/i)).toBeInTheDocument();
  });

  test("clears a stale over-limit message when a token is dismissed", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <TestComponent defaultItems={["a", "b"]} maxItems={2} />,
    );

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "c{Enter}");
    expect(screen.getByText(/maximum of 2/i)).toBeInTheDocument();

    // Removing a token frees room — the stale rejection message must clear.
    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    await user.click(removeButtons[0]);

    await waitFor(() =>
      expect(screen.queryByText(/maximum of 2/i)).not.toBeInTheDocument(),
    );
  });

  test("clears a stale over-limit message when the value is reset externally", async () => {
    const user = userEvent.setup();

    // Mirrors SectionForm's conflict-Reload path: an external reset() replaces
    // the field value without unmounting the component. A lingering over-limit
    // message must clear when the value changes from outside.
    function ResettableTest() {
      const methods = useForm<TestFormValues>({
        resolver: zodResolver(TestSchema),
        mode: "all",
        defaultValues: { items: ["a", "b"] },
      });
      return (
        <FormProvider {...methods}>
          <TokenListField
            controllerProps={{ control: methods.control, name: "items" }}
            formFieldProps={{ label: "Items" }}
            inputProps={{ placeholder: "Add an item and press Enter" }}
            maxItems={2}
          />
          <button type="button" onClick={() => methods.reset({ items: ["x"] })}>
            external reset
          </button>
        </FormProvider>
      );
    }

    renderWithQueryClient(<ResettableTest />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "c{Enter}");
    expect(screen.getByText(/maximum of 2/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /external reset/i }));

    await waitFor(() =>
      expect(screen.queryByText(/maximum of 2/i)).not.toBeInTheDocument(),
    );
  });

  test("shows a live character counter for the current entry against maxItemLength", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent maxItemLength={5} />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    // No draft yet: counter reflects an empty entry.
    expect(screen.getByText("0 / 5 characters")).toBeInTheDocument();

    await user.type(input, "abc");
    expect(screen.getByText("3 / 5 characters")).toBeInTheDocument();
  });

  test("counts the trimmed length in the live counter", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent maxItemLength={5} />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    // Leading/trailing whitespace is trimmed on add, so the counter mirrors the
    // stored length rather than the raw keystrokes.
    await user.type(input, "  ab  ");
    expect(screen.getByText("2 / 5 characters")).toBeInTheDocument();
  });

  test("turns the counter red once the draft exceeds maxItemLength", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent maxItemLength={5} />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "toolong");

    // The over-limit count is shown in Cloudscape's error color so the state is
    // visibly wrong while typing, not a calm neutral grey like a normal hint.
    const counter = screen.getByText("7 / 5 characters");
    const styled = counter.closest('[class*="error"], [class*="warning"]');
    expect(styled?.className).toMatch(/error/);
  });

  test("keeps the counter neutral while the draft is within maxItemLength", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent maxItemLength={5} />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "abc");

    const counter = screen.getByText("3 / 5 characters");
    const styled = counter.closest('[class*="error"]');
    expect(styled).toBeNull();
  });

  test("announces the draft character count to screen readers via a live region", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent maxItemLength={5} />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "abc");

    // Screen-reader phrasing tracks the draft length; the visible "N / MAX" is
    // aria-hidden and only read on focus, never live as the user types.
    expect(screen.getByText("3 of 5 characters")).toBeInTheDocument();
  });

  test("announces the over-limit draft state to screen readers", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent maxItemLength={5} />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "toolong");

    expect(
      screen.getByText("7 of 5 characters, over the limit"),
    ).toBeInTheDocument();
  });

  test("does not render a character counter when maxItemLength is unset", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "abc");
    expect(screen.queryByText(/\/ \d+ characters/)).not.toBeInTheDocument();
  });

  test("shows a live item count against maxItems", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <TestComponent maxItems={3} defaultItems={["alpha"]} />,
    );

    // Reflects the current list size out of the max.
    expect(screen.getByText("1 / 3 items")).toBeInTheDocument();

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "beta{enter}");
    expect(screen.getByText("2 / 3 items")).toBeInTheDocument();
  });

  test("does not render an item count when maxItems is unset", async () => {
    renderWithQueryClient(<TestComponent defaultItems={["alpha"]} />);
    expect(screen.queryByText(/\/ \d+ items/)).not.toBeInTheDocument();
  });

  test("announces the item count to screen readers via a live region", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <TestComponent maxItems={3} defaultItems={["alpha"]} />,
    );

    // The visible "N / MAX" is aria-hidden; a live region ("N of MAX") re-announces
    // the count as items are added, mirroring the character counter.
    expect(screen.getByText("1 of 3 items")).toBeInTheDocument();

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "beta{enter}");
    expect(screen.getByText("2 of 3 items")).toBeInTheDocument();
  });

  test("uses the itemNoun in the item count when provided", async () => {
    renderWithQueryClient(
      <TestComponent maxItems={3} defaultItems={["alpha"]} itemNoun="groups" />,
    );
    expect(screen.getByText("1 / 3 groups")).toBeInTheDocument();
  });

  test("shows the item count and the character counter together when both maxItems and maxItemLength are set", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <TestComponent maxItems={3} maxItemLength={5} defaultItems={["alpha"]} />,
    );

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "ab");

    // Both constraint parts share one slot; other tests only ever set one limit.
    expect(screen.getByText("1 / 3 items")).toBeInTheDocument();
    expect(screen.getByText("2 / 5 characters")).toBeInTheDocument();
  });

  test("displays validation error for invalid input", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent defaultItems={["alpha", "beta"]} />);

    const input = screen.getByPlaceholderText("Add an item and press Enter");
    await user.type(input, "gamma{Enter}");

    await waitFor(() => {
      expect(screen.getByText("At most 2 items")).toBeInTheDocument();
    });
  });
});
