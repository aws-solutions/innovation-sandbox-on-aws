// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import TextareaField from "@amzn/innovation-sandbox-frontend/components/FormFields/TextareaField";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const TestSchema = z.object({
  testField: z.string().max(100, "Must be at most 100 characters"),
});

type TestFormValues = z.infer<typeof TestSchema>;

function TestComponent({ defaultValue = "" }: { defaultValue?: string }) {
  const { control } = useForm<TestFormValues>({
    resolver: zodResolver(TestSchema),
    mode: "onChange",
    defaultValues: {
      testField: defaultValue,
    },
  });

  return (
    <TextareaField
      controllerProps={{ control, name: "testField" }}
      formFieldProps={{
        label: "Test Textarea",
        description: "Test description",
      }}
      textareaProps={{
        placeholder: "Enter description",
        rows: 4,
      }}
    />
  );
}

describe("TextareaField", () => {
  test("renders with label and description", () => {
    renderWithQueryClient(<TestComponent />);

    expect(screen.getByText("Test Textarea")).toBeInTheDocument();
    expect(screen.getByText("Test description")).toBeInTheDocument();
  });

  test("renders with placeholder", () => {
    renderWithQueryClient(<TestComponent />);

    const textarea = screen.getByPlaceholderText("Enter description");
    expect(textarea).toBeInTheDocument();
  });

  test("displays default value", () => {
    renderWithQueryClient(<TestComponent defaultValue="Initial description" />);

    const textarea = screen.getByDisplayValue("Initial description");
    expect(textarea).toBeInTheDocument();
  });

  test("updates value on user input", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    const textarea = screen.getByPlaceholderText("Enter description");
    await user.type(textarea, "New description");

    expect(textarea).toHaveValue("New description");
  });

  test("displays validation error for invalid input", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    const textarea = screen.getByPlaceholderText("Enter description");
    const longText = "a".repeat(101);
    await user.type(textarea, longText);
    await user.tab(); // Trigger blur

    await waitFor(() => {
      expect(
        screen.getByText("Must be at most 100 characters"),
      ).toBeInTheDocument();
    });
  });

  test("handles multiline text", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    const textarea = screen.getByPlaceholderText("Enter description");
    await user.type(textarea, "Line 1{Enter}Line 2{Enter}Line 3");

    expect(textarea).toHaveValue("Line 1\nLine 2\nLine 3");
  });

  test("renders with specified rows", () => {
    renderWithQueryClient(<TestComponent />);

    const textarea = screen.getByPlaceholderText("Enter description");
    expect(textarea).toHaveAttribute("rows", "4");
  });

  test("passes through additional Textarea props", () => {
    function TestWithProps() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { testField: "" },
      });

      return (
        <TextareaField
          controllerProps={{ control, name: "testField" }}
          formFieldProps={{ label: "Test Textarea" }}
          textareaProps={{
            disabled: true,
            rows: 6,
          }}
        />
      );
    }

    renderWithQueryClient(<TestWithProps />);

    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeDisabled();
    expect(textarea).toHaveAttribute("rows", "6");
  });

  test("handles empty optional field", () => {
    const OptionalSchema = z.object({
      testField: z.string().optional(),
    });

    function TestOptional() {
      const { control } = useForm<z.infer<typeof OptionalSchema>>({
        resolver: zodResolver(OptionalSchema),
        defaultValues: { testField: undefined },
      });

      return (
        <TextareaField
          controllerProps={{ control, name: "testField" }}
          formFieldProps={{ label: "Optional Field" }}
          textareaProps={{
            placeholder: "Optional",
          }}
        />
      );
    }

    renderWithQueryClient(<TestOptional />);

    const textarea = screen.getByPlaceholderText("Optional");
    expect(textarea).toHaveValue("");
  });

  test("calls custom onChange handler alongside RHF handler", async () => {
    let customOnChangeCalled = false;

    function TestCustomHandler() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { testField: "" },
      });

      return (
        <TextareaField
          controllerProps={{ control, name: "testField" }}
          formFieldProps={{ label: "Test Textarea" }}
          textareaProps={{
            placeholder: "Enter text",
            onChange: () => {
              customOnChangeCalled = true;
            },
          }}
        />
      );
    }

    const user = userEvent.setup();
    renderWithQueryClient(<TestCustomHandler />);

    const textarea = screen.getByPlaceholderText("Enter text");
    await user.type(textarea, "test");

    expect(customOnChangeCalled).toBe(true);
  });

  test("calls custom onBlur handler alongside RHF handler", async () => {
    let customOnBlurCalled = false;

    function TestCustomHandler() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { testField: "" },
      });

      return (
        <TextareaField
          controllerProps={{ control, name: "testField" }}
          formFieldProps={{ label: "Test Textarea" }}
          textareaProps={{
            placeholder: "Enter text",
            onBlur: () => {
              customOnBlurCalled = true;
            },
          }}
        />
      );
    }

    const user = userEvent.setup();
    renderWithQueryClient(<TestCustomHandler />);

    const textarea = screen.getByPlaceholderText("Enter text");
    await user.click(textarea);
    await user.tab();

    expect(customOnBlurCalled).toBe(true);
  });
});
