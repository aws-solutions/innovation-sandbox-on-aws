// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SelectProps } from "@cloudscape-design/components/select";
import { zodResolver } from "@hookform/resolvers/zod";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import SelectField from "@amzn/innovation-sandbox-frontend/components/FormFields/SelectField";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import { useEffect } from "react";

type Status = "active" | "inactive" | "pending";

const TestSchema = z.object({
  status: z.enum(["active", "inactive", "pending"], {
    required_error: "Status is required",
  }),
});

type TestFormValues = z.infer<typeof TestSchema>;

const STATUS_OPTIONS: SelectProps.Option[] = [
  { label: "Active", value: "active" },
  { label: "Inactive", value: "inactive" },
  { label: "Pending", value: "pending" },
];

function valueToOption(value: Status): SelectProps.Option | null {
  return STATUS_OPTIONS.find((opt) => opt.value === value) || null;
}

function optionToValue(option: SelectProps.Option | null): Status {
  return (option?.value as Status) || "active";
}

function TestComponent({ defaultValue = "active" }: { defaultValue?: Status }) {
  const { control } = useForm<TestFormValues>({
    resolver: zodResolver(TestSchema),
    mode: "onChange",
    defaultValues: {
      status: defaultValue,
    },
  });

  return (
    <SelectField
      controllerProps={{ control, name: "status" }}
      formFieldProps={{
        label: "Status",
        description: "Select a status",
      }}
      selectProps={{
        options: STATUS_OPTIONS,
        placeholder: "Choose status",
        valueToOption,
        optionToValue,
      }}
    />
  );
}

describe("SelectField", () => {
  test("renders with label and description", () => {
    renderWithQueryClient(<TestComponent />);

    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Select a status")).toBeInTheDocument();
  });

  test("displays default selected option", () => {
    renderWithQueryClient(<TestComponent defaultValue="active" />);

    // Cloudscape Select shows the selected option's label
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  test("updates value when option is selected", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    // Click the select to open dropdown
    const selectTrigger = screen.getByRole("button");
    await user.click(selectTrigger);

    // Wait for options to appear and click one
    await waitFor(() => {
      expect(screen.getByText("Inactive")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Inactive"));

    // Verify the selection changed
    await waitFor(() => {
      expect(screen.getByText("Inactive")).toBeInTheDocument();
    });
  });

  test("displays all available options", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    const selectTrigger = screen.getByRole("button");
    await user.click(selectTrigger);

    await waitFor(() => {
      // Use getAllByText since "Active" appears in both trigger and dropdown
      const activeElements = screen.getAllByText("Active");
      expect(activeElements.length).toBeGreaterThan(0);
      expect(screen.getByText("Inactive")).toBeInTheDocument();
      expect(screen.getByText("Pending")).toBeInTheDocument();
    });
  });

  test("renders with constraint text", () => {
    function TestWithConstraint() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { status: "active" },
      });

      return (
        <SelectField
          controllerProps={{ control, name: "status" }}
          formFieldProps={{
            label: "Status",
            constraintText: "Choose the appropriate status",
          }}
          selectProps={{
            options: STATUS_OPTIONS,
            valueToOption,
            optionToValue,
          }}
        />
      );
    }

    renderWithQueryClient(<TestWithConstraint />);

    expect(
      screen.getByText("Choose the appropriate status"),
    ).toBeInTheDocument();
  });

  test("passes through additional Select props", () => {
    function TestWithProps() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { status: "active" },
      });

      return (
        <SelectField
          controllerProps={{ control, name: "status" }}
          formFieldProps={{ label: "Status" }}
          selectProps={{
            options: STATUS_OPTIONS,
            disabled: true,
            valueToOption,
            optionToValue,
          }}
        />
      );
    }

    renderWithQueryClient(<TestWithProps />);

    const selectTrigger = screen.getByRole("button");
    expect(selectTrigger).toBeDisabled();
  });

  test("handles null option value", () => {
    const NullableSchema = z.object({
      status: z.enum(["active", "inactive", "pending"]).nullable(),
    });

    function TestNullable() {
      const { control } = useForm<z.infer<typeof NullableSchema>>({
        defaultValues: { status: null },
      });

      return (
        <SelectField
          controllerProps={{ control, name: "status" }}
          formFieldProps={{ label: "Status" }}
          selectProps={{
            options: STATUS_OPTIONS,
            placeholder: "Select status",
            valueToOption: (val) => (val ? valueToOption(val) : null),
            optionToValue: (opt) => (opt ? optionToValue(opt) : null),
          }}
        />
      );
    }

    renderWithQueryClient(<TestNullable />);

    expect(screen.getByText("Select status")).toBeInTheDocument();
  });

  test("displays validation error", async () => {
    const RequiredSchema = z.object({
      status: z.string().min(1, "Status is required"),
    });

    function TestRequired() {
      const { control, trigger } = useForm<z.infer<typeof RequiredSchema>>({
        resolver: zodResolver(RequiredSchema),
        mode: "all",
        defaultValues: { status: "" },
      });

      // Trigger validation on mount
      useEffect(() => {
        trigger();
      }, [trigger]);

      return (
        <SelectField
          controllerProps={{ control, name: "status" }}
          formFieldProps={{ label: "Status" }}
          selectProps={{
            options: STATUS_OPTIONS,
            valueToOption: (val) => valueToOption(val as Status),
            optionToValue: (opt) => opt?.value || "",
          }}
        />
      );
    }

    renderWithQueryClient(<TestRequired />);

    await waitFor(() => {
      expect(screen.getByText("Status is required")).toBeInTheDocument();
    });
  });

  test("calls custom onChange handler alongside RHF handler", async () => {
    let customOnChangeCalled = false;

    function TestCustomHandler() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { status: "active" },
      });

      return (
        <SelectField
          controllerProps={{ control, name: "status" }}
          formFieldProps={{ label: "Status" }}
          selectProps={{
            options: STATUS_OPTIONS,
            valueToOption,
            optionToValue,
            onChange: () => {
              customOnChangeCalled = true;
            },
          }}
        />
      );
    }

    const user = userEvent.setup();
    renderWithQueryClient(<TestCustomHandler />);

    const selectTrigger = screen.getByRole("button");
    await user.click(selectTrigger);

    await waitFor(() => {
      expect(screen.getByText("Inactive")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Inactive"));

    await waitFor(() => {
      expect(customOnChangeCalled).toBe(true);
    });
  });
});
