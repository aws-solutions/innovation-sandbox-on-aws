// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import CardsField from "@amzn/innovation-sandbox-frontend/components/FormFields/CardsField";

interface TestItem {
  id: string;
  name: string;
  description: string;
}

const testItems: TestItem[] = [
  { id: "1", name: "Item 1", description: "First item" },
  { id: "2", name: "Item 2", description: "Second item" },
  { id: "3", name: "Item 3", description: "Third item" },
];

describe("CardsField", () => {
  describe("Single Selection Mode", () => {
    const SingleSelectionSchema = z.object({
      selectedItem: z.string().min(1, "Please select an item"),
    });

    type SingleSelectionFormValues = z.infer<typeof SingleSelectionSchema>;

    function TestSingleSelection() {
      const { control } = useForm<SingleSelectionFormValues>({
        resolver: zodResolver(SingleSelectionSchema),
        mode: "onChange",
        defaultValues: {
          selectedItem: "",
        },
      });

      return (
        <CardsField<TestItem, SingleSelectionFormValues, "selectedItem">
          controllerProps={{ control, name: "selectedItem" }}
          formFieldProps={{
            label: "Select an item",
            description: "Choose one item from the list",
          }}
          cardsProps={{
            items: testItems,
            selectionType: "single",
            cardDefinition: {
              header: (item) => item.name,
              sections: [
                {
                  content: (item) => item.description,
                },
              ],
            },
          }}
          valueExtractor={(item) => item.id}
          itemMatcher={(item, value) => item.id === value}
        />
      );
    }

    it("renders with label and description", () => {
      render(<TestSingleSelection />);

      expect(screen.getByText("Select an item")).toBeInTheDocument();
      expect(
        screen.getByText("Choose one item from the list"),
      ).toBeInTheDocument();
    });

    it("renders all items", () => {
      render(<TestSingleSelection />);

      expect(screen.getByText("Item 1")).toBeInTheDocument();
      expect(screen.getByText("Item 2")).toBeInTheDocument();
      expect(screen.getByText("Item 3")).toBeInTheDocument();
    });

    it("selects item when clicked", async () => {
      let selectedValue: string | undefined;

      function TestWithCapture() {
        const { control, watch } = useForm<SingleSelectionFormValues>({
          resolver: zodResolver(SingleSelectionSchema),
          mode: "onChange",
          defaultValues: { selectedItem: "" },
        });

        selectedValue = watch("selectedItem");

        return (
          <CardsField<TestItem, SingleSelectionFormValues, "selectedItem">
            controllerProps={{ control, name: "selectedItem" }}
            formFieldProps={{ label: "Select an item" }}
            cardsProps={{
              items: testItems,
              selectionType: "single",
              cardDefinition: {
                header: (item) => item.name,
              },
            }}
            valueExtractor={(item) => item.id}
            itemMatcher={(item, value) => item.id === value}
          />
        );
      }

      const user = userEvent.setup();
      render(<TestWithCapture />);

      // Click the radio button for the first item
      const radioButtons = screen.getAllByRole("radio");
      await user.click(radioButtons[0]);

      // Check that the form value is updated
      await waitFor(() => {
        expect(selectedValue).toBe("1");
      });
    });

    it("displays validation error when no item selected", async () => {
      function TestValidation() {
        const { control, trigger } = useForm<SingleSelectionFormValues>({
          resolver: zodResolver(SingleSelectionSchema),
          mode: "onChange",
          defaultValues: { selectedItem: "" },
        });

        return (
          <>
            <CardsField<TestItem, SingleSelectionFormValues, "selectedItem">
              controllerProps={{ control, name: "selectedItem" }}
              formFieldProps={{ label: "Select an item" }}
              cardsProps={{
                items: testItems,
                selectionType: "single",
                cardDefinition: {
                  header: (item) => item.name,
                },
              }}
              valueExtractor={(item) => item.id}
              itemMatcher={(item, value) => item.id === value}
            />
            <button onClick={() => trigger()}>Validate</button>
          </>
        );
      }

      const user = userEvent.setup();
      render(<TestValidation />);

      const validateButton = screen.getByRole("button", { name: "Validate" });
      await user.click(validateButton);

      expect(
        await screen.findByText("Please select an item"),
      ).toBeInTheDocument();
    });
  });

  describe("Multi Selection Mode", () => {
    const MultiSelectionSchema = z.object({
      selectedItems: z.array(z.any()).min(1, "Please select at least one item"),
    });

    type MultiSelectionFormValues = z.infer<typeof MultiSelectionSchema>;

    function TestMultiSelection() {
      const { control } = useForm<MultiSelectionFormValues>({
        resolver: zodResolver(MultiSelectionSchema),
        mode: "onChange",
        defaultValues: {
          selectedItems: [],
        },
      });

      return (
        <CardsField<TestItem, MultiSelectionFormValues, "selectedItems">
          controllerProps={{ control, name: "selectedItems" }}
          formFieldProps={{
            label: "Select items",
            description: "Choose multiple items from the list",
          }}
          cardsProps={{
            items: testItems,
            selectionType: "multi",
            cardDefinition: {
              header: (item) => item.name,
              sections: [
                {
                  content: (item) => item.description,
                },
              ],
            },
          }}
        />
      );
    }

    it("renders with label and description", () => {
      render(<TestMultiSelection />);

      expect(screen.getByText("Select items")).toBeInTheDocument();
      expect(
        screen.getByText("Choose multiple items from the list"),
      ).toBeInTheDocument();
    });

    it("allows selecting multiple items", async () => {
      let selectedItems: TestItem[] = [];

      function TestWithCapture() {
        const { control, watch } = useForm<MultiSelectionFormValues>({
          resolver: zodResolver(MultiSelectionSchema),
          mode: "onChange",
          defaultValues: { selectedItems: [] },
        });

        selectedItems = watch("selectedItems");

        return (
          <CardsField<TestItem, MultiSelectionFormValues, "selectedItems">
            controllerProps={{ control, name: "selectedItems" }}
            formFieldProps={{ label: "Select items" }}
            cardsProps={{
              items: testItems,
              selectionType: "multi",
              cardDefinition: {
                header: (item) => item.name,
              },
            }}
          />
        );
      }

      const user = userEvent.setup();
      render(<TestWithCapture />);

      // Click checkboxes for first two items
      const checkboxes = screen.getAllByRole("checkbox");
      await user.click(checkboxes[0]);
      await user.click(checkboxes[1]);

      // Check that both items are in the selected array
      await waitFor(() => {
        expect(selectedItems).toHaveLength(2);
        expect(selectedItems.map((item) => item.id)).toContain("1");
        expect(selectedItems.map((item) => item.id)).toContain("2");
      });
    });

    it("displays validation error when no items selected", async () => {
      function TestValidation() {
        const { control, trigger } = useForm<MultiSelectionFormValues>({
          resolver: zodResolver(MultiSelectionSchema),
          mode: "onChange",
          defaultValues: { selectedItems: [] },
        });

        return (
          <>
            <CardsField<TestItem, MultiSelectionFormValues, "selectedItems">
              controllerProps={{ control, name: "selectedItems" }}
              formFieldProps={{ label: "Select items" }}
              cardsProps={{
                items: testItems,
                selectionType: "multi",
                cardDefinition: {
                  header: (item) => item.name,
                },
              }}
            />
            <button onClick={() => trigger()}>Validate</button>
          </>
        );
      }

      const user = userEvent.setup();
      render(<TestValidation />);

      const validateButton = screen.getByRole("button", { name: "Validate" });
      await user.click(validateButton);

      expect(
        await screen.findByText("Please select at least one item"),
      ).toBeInTheDocument();
    });
  });

  describe("Value Extraction", () => {
    it("extracts specific value from selected item", async () => {
      const SingleSelectionSchema = z.object({
        selectedId: z.string(),
      });

      let extractedValue: string | undefined;

      function TestValueExtraction() {
        const { control, watch } = useForm<
          z.infer<typeof SingleSelectionSchema>
        >({
          defaultValues: { selectedId: "" },
        });

        extractedValue = watch("selectedId");

        return (
          <CardsField<TestItem, any, "selectedId">
            controllerProps={{ control, name: "selectedId" }}
            formFieldProps={{ label: "Select an item" }}
            cardsProps={{
              items: testItems,
              selectionType: "single",
              cardDefinition: {
                header: (item) => item.name,
              },
            }}
            valueExtractor={(item) => item.id}
            itemMatcher={(item, value) => item.id === value}
          />
        );
      }

      const user = userEvent.setup();
      render(<TestValueExtraction />);

      // Click the radio button for the first item
      const radioButtons = screen.getAllByRole("radio");
      await user.click(radioButtons[0]);

      // Wait for the value to be updated
      await waitFor(() => {
        expect(extractedValue).toBe("1");
      });
    });
  });

  describe("Custom Event Handlers", () => {
    it("calls custom onSelectionChange handler", async () => {
      let customHandlerCalled = false;
      let selectedValue: string | undefined;

      function TestCustomHandler() {
        const { control, watch } = useForm({
          defaultValues: { selectedItem: "" },
        });

        selectedValue = watch("selectedItem");

        return (
          <CardsField<TestItem, any, "selectedItem">
            controllerProps={{ control, name: "selectedItem" }}
            formFieldProps={{ label: "Select an item" }}
            cardsProps={{
              items: testItems,
              selectionType: "single",
              cardDefinition: {
                header: (item) => item.name,
              },
              onSelectionChange: () => {
                customHandlerCalled = true;
              },
            }}
            valueExtractor={(item) => item.id}
            itemMatcher={(item, value) => item.id === value}
          />
        );
      }

      const user = userEvent.setup();
      render(<TestCustomHandler />);

      // Find the radio button within the card
      const radioButtons = screen.getAllByRole("radio");
      await user.click(radioButtons[0]);

      // Wait for the handler to be called and value to update
      await waitFor(() => {
        expect(customHandlerCalled).toBe(true);
        expect(selectedValue).toBe("1");
      });
    });
  });
});
