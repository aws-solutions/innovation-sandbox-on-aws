// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import InputField from "@amzn/innovation-sandbox-frontend/components/FormFields/InputField";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const TestSchema = z.object({
  testField: z.string().min(3, "Must be at least 3 characters"),
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
    <InputField
      controllerProps={{ control, name: "testField" }}
      formFieldProps={{
        label: "Test Field",
        description: "Test description",
      }}
      inputProps={{
        placeholder: "Enter text",
      }}
    />
  );
}

describe("InputField", () => {
  test("renders with label and description", () => {
    renderWithQueryClient(<TestComponent />);

    expect(screen.getByText("Test Field")).toBeInTheDocument();
    expect(screen.getByText("Test description")).toBeInTheDocument();
  });

  test("renders with placeholder", () => {
    renderWithQueryClient(<TestComponent />);

    const input = screen.getByPlaceholderText("Enter text");
    expect(input).toBeInTheDocument();
  });

  test("displays default value", () => {
    renderWithQueryClient(<TestComponent defaultValue="Initial value" />);

    const input = screen.getByDisplayValue("Initial value");
    expect(input).toBeInTheDocument();
  });

  test("updates value on user input", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    const input = screen.getByPlaceholderText("Enter text");
    await user.type(input, "New value");

    expect(input).toHaveValue("New value");
  });

  test("displays validation error for invalid input", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    const input = screen.getByPlaceholderText("Enter text");
    await user.type(input, "ab");
    await user.tab(); // Trigger blur

    await waitFor(() => {
      expect(
        screen.getByText("Must be at least 3 characters"),
      ).toBeInTheDocument();
    });
  });

  test("clears validation error when input becomes valid", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    const input = screen.getByPlaceholderText("Enter text");

    // Enter invalid value
    await user.type(input, "ab");
    await user.tab();

    await waitFor(() => {
      expect(
        screen.getByText("Must be at least 3 characters"),
      ).toBeInTheDocument();
    });

    // Fix the value
    await user.type(input, "c");

    await waitFor(() => {
      expect(
        screen.queryByText("Must be at least 3 characters"),
      ).not.toBeInTheDocument();
    });
  });

  test("renders with constraint text", () => {
    function TestWithConstraint() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { testField: "" },
      });

      return (
        <InputField
          controllerProps={{ control, name: "testField" }}
          formFieldProps={{
            label: "Test Field",
            constraintText: "Maximum 50 characters",
          }}
        />
      );
    }

    renderWithQueryClient(<TestWithConstraint />);

    expect(screen.getByText("Maximum 50 characters")).toBeInTheDocument();
  });

  test("passes through additional Input props", () => {
    function TestWithProps() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { testField: "" },
      });

      return (
        <InputField
          controllerProps={{ control, name: "testField" }}
          formFieldProps={{ label: "Test Field" }}
          inputProps={{
            disabled: true,
            type: "email",
          }}
        />
      );
    }

    renderWithQueryClient(<TestWithProps />);

    const input = screen.getByRole("textbox");
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("type", "email");
  });

  test("calls custom onChange handler alongside RHF handler", async () => {
    let customOnChangeCalled = false;

    function TestCustomHandler() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { testField: "" },
      });

      return (
        <InputField
          controllerProps={{ control, name: "testField" }}
          formFieldProps={{ label: "Test Field" }}
          inputProps={{
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

    const input = screen.getByPlaceholderText("Enter text");
    await user.type(input, "test");

    expect(customOnChangeCalled).toBe(true);
  });

  test("calls custom onBlur handler alongside RHF handler", async () => {
    let customOnBlurCalled = false;

    function TestCustomHandler() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { testField: "" },
      });

      return (
        <InputField
          controllerProps={{ control, name: "testField" }}
          formFieldProps={{ label: "Test Field" }}
          inputProps={{
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

    const input = screen.getByPlaceholderText("Enter text");
    await user.click(input);
    await user.tab();

    expect(customOnBlurCalled).toBe(true);
  });

  test("handles number type input correctly", async () => {
    const NumberSchema = z.object({
      age: z.number().min(18, "Must be at least 18"),
    });

    function TestNumberInput() {
      const { control, watch } = useForm<z.infer<typeof NumberSchema>>({
        resolver: zodResolver(NumberSchema),
        mode: "onChange",
        defaultValues: { age: undefined },
      });

      const age = watch("age");

      return (
        <>
          <InputField
            controllerProps={{ control, name: "age" }}
            formFieldProps={{ label: "Age" }}
            inputProps={{
              type: "number",
              placeholder: "Enter age",
            }}
          />
          <div data-testid="age-value">{age}</div>
        </>
      );
    }

    const user = userEvent.setup();
    renderWithQueryClient(<TestNumberInput />);

    const input = screen.getByPlaceholderText("Enter age");
    await user.type(input, "25");

    // Value should be parsed as number
    await waitFor(() => {
      expect(screen.getByTestId("age-value")).toHaveTextContent("25");
    });
  });
});
