// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import RadioGroupField from "@amzn/innovation-sandbox-frontend/components/FormFields/RadioGroupField";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const TestSchema = z.object({
  color: z.enum(["red", "green", "blue"]),
});

type TestFormValues = z.infer<typeof TestSchema>;

const radioItems = [
  { value: "red", label: "Red" },
  { value: "green", label: "Green" },
  { value: "blue", label: "Blue" },
];

function TestComponent({ defaultValue = "red" }: { defaultValue?: string }) {
  const { control } = useForm<TestFormValues>({
    resolver: zodResolver(TestSchema),
    mode: "onChange",
    defaultValues: {
      color: defaultValue as TestFormValues["color"],
    },
  });

  return (
    <RadioGroupField
      controllerProps={{ control, name: "color" }}
      formFieldProps={{
        label: "Favorite Color",
        description: "Choose your favorite color",
      }}
      radioGroupProps={{
        items: radioItems,
      }}
    />
  );
}

describe("RadioGroupField", () => {
  test("renders with label and description", () => {
    renderWithQueryClient(<TestComponent />);

    expect(screen.getByText("Favorite Color")).toBeInTheDocument();
    expect(screen.getByText("Choose your favorite color")).toBeInTheDocument();
  });

  test("changes value on selection", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent defaultValue="red" />);

    const redRadio = screen.getByRole("radio", { name: "Red" });
    expect(redRadio).toBeChecked();

    const blueRadio = screen.getByRole("radio", { name: "Blue" });
    await user.click(blueRadio);

    await waitFor(() => {
      expect(blueRadio).toBeChecked();
      expect(redRadio).not.toBeChecked();
    });
  });

  test("displays validation error on submit", async () => {
    const StrictSchema = z.object({
      color: z
        .string()
        .refine((val) => val === "green", { message: "Must select green" }),
    });

    function TestValidation() {
      const { control, handleSubmit } = useForm({
        resolver: zodResolver(StrictSchema),
        defaultValues: { color: "red" },
      });

      return (
        <form onSubmit={handleSubmit(() => {})}>
          <RadioGroupField
            controllerProps={{ control, name: "color" }}
            formFieldProps={{ label: "Favorite Color" }}
            radioGroupProps={{ items: radioItems }}
          />
          <button type="submit">Submit</button>
        </form>
      );
    }

    const user = userEvent.setup();
    renderWithQueryClient(<TestValidation />);

    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(screen.getByText("Must select green")).toBeInTheDocument();
    });
  });

  test("calls custom onChange handler alongside RHF handler", async () => {
    let customOnChangeCalled = false;

    function TestCustomHandler() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { color: "red" },
      });

      return (
        <RadioGroupField
          controllerProps={{ control, name: "color" }}
          formFieldProps={{ label: "Favorite Color" }}
          radioGroupProps={{
            items: radioItems,
            onChange: () => {
              customOnChangeCalled = true;
            },
          }}
        />
      );
    }

    const user = userEvent.setup();
    renderWithQueryClient(<TestCustomHandler />);

    await user.click(screen.getByRole("radio", { name: "Blue" }));

    await waitFor(() => {
      expect(customOnChangeCalled).toBe(true);
    });
  });
});
