// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const TestSchema = z.object({
  isEnabled: z.boolean(),
});

type TestFormValues = z.infer<typeof TestSchema>;

function TestComponent({ defaultValue = false }: { defaultValue?: boolean }) {
  const { control, watch } = useForm<TestFormValues>({
    resolver: zodResolver(TestSchema),
    mode: "onChange",
    defaultValues: {
      isEnabled: defaultValue,
    },
  });

  const isEnabled = watch("isEnabled");

  return (
    <ToggleField
      controllerProps={{ control, name: "isEnabled" }}
      formFieldProps={{
        label: "Enable Feature",
        description: "Toggle to enable or disable",
      }}
      toggleProps={{
        children: isEnabled ? "Enabled" : "Disabled",
      }}
    />
  );
}

describe("ToggleField", () => {
  test("renders with label and description", () => {
    renderWithQueryClient(<TestComponent />);

    expect(screen.getByText("Enable Feature")).toBeInTheDocument();
    expect(screen.getByText("Toggle to enable or disable")).toBeInTheDocument();
  });

  test("displays unchecked state by default", () => {
    renderWithQueryClient(<TestComponent defaultValue={false} />);

    const toggle = screen.getByRole("checkbox");
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  test("displays checked state when default is true", () => {
    renderWithQueryClient(<TestComponent defaultValue={true} />);

    const toggle = screen.getByRole("checkbox");
    expect(toggle).toBeChecked();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
  });

  test("toggles value on click", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent defaultValue={false} />);

    const toggle = screen.getByRole("checkbox");
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).toBeChecked();
      expect(screen.getByText("Enabled")).toBeInTheDocument();
    });
  });

  test("toggles back to unchecked", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent defaultValue={true} />);

    const toggle = screen.getByRole("checkbox");
    expect(toggle).toBeChecked();

    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).not.toBeChecked();
      expect(screen.getByText("Disabled")).toBeInTheDocument();
    });
  });

  test("renders with static children text", () => {
    function TestStatic() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { isEnabled: false },
      });

      return (
        <ToggleField
          controllerProps={{ control, name: "isEnabled" }}
          formFieldProps={{ label: "Enable Feature" }}
          toggleProps={{
            children: "Static Label",
          }}
        />
      );
    }

    renderWithQueryClient(<TestStatic />);

    expect(screen.getByText("Static Label")).toBeInTheDocument();
  });

  test("renders with constraint text", () => {
    function TestWithConstraint() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { isEnabled: false },
      });

      return (
        <ToggleField
          controllerProps={{ control, name: "isEnabled" }}
          formFieldProps={{
            label: "Enable Feature",
            constraintText: "This setting affects all users",
          }}
          toggleProps={{
            children: "Toggle me",
          }}
        />
      );
    }

    renderWithQueryClient(<TestWithConstraint />);

    expect(
      screen.getByText("This setting affects all users"),
    ).toBeInTheDocument();
  });

  test("passes through additional Toggle props", () => {
    function TestWithProps() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { isEnabled: false },
      });

      return (
        <ToggleField
          controllerProps={{ control, name: "isEnabled" }}
          formFieldProps={{ label: "Enable Feature" }}
          toggleProps={{
            disabled: true,
            children: "Disabled Toggle",
          }}
        />
      );
    }

    renderWithQueryClient(<TestWithProps />);

    const toggle = screen.getByRole("checkbox");
    expect(toggle).toBeDisabled();
  });

  test("handles validation with custom schema", async () => {
    const CustomSchema = z.object({
      isEnabled: z.boolean().refine((val) => val === true, {
        message: "Must be enabled",
      }),
    });

    function TestValidation() {
      const { control } = useForm<z.infer<typeof CustomSchema>>({
        resolver: zodResolver(CustomSchema),
        mode: "onChange",
        defaultValues: { isEnabled: false },
      });

      return (
        <ToggleField
          controllerProps={{ control, name: "isEnabled" }}
          formFieldProps={{ label: "Enable Feature" }}
          toggleProps={{
            children: "Must be enabled",
          }}
        />
      );
    }

    renderWithQueryClient(<TestValidation />);

    await waitFor(() => {
      expect(screen.getByText("Must be enabled")).toBeInTheDocument();
    });
  });

  test("works without children", () => {
    function TestNoChildren() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { isEnabled: false },
      });

      return (
        <ToggleField
          controllerProps={{ control, name: "isEnabled" }}
          formFieldProps={{ label: "Enable Feature" }}
        />
      );
    }

    renderWithQueryClient(<TestNoChildren />);

    const toggle = screen.getByRole("checkbox");
    expect(toggle).toBeInTheDocument();
  });

  test("handles keyboard interaction", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent defaultValue={false} />);

    const toggle = screen.getByRole("checkbox");

    // Focus and press space
    toggle.focus();
    await user.keyboard(" ");

    await waitFor(() => {
      expect(toggle).toBeChecked();
    });

    // Press space again
    await user.keyboard(" ");

    await waitFor(() => {
      expect(toggle).not.toBeChecked();
    });
  });

  test("calls custom onChange handler alongside RHF handler", async () => {
    let customOnChangeCalled = false;

    function TestCustomHandler() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { isEnabled: false },
      });

      return (
        <ToggleField
          controllerProps={{ control, name: "isEnabled" }}
          formFieldProps={{ label: "Enable Feature" }}
          toggleProps={{
            children: "Toggle",
            onChange: () => {
              customOnChangeCalled = true;
            },
          }}
        />
      );
    }

    const user = userEvent.setup();
    renderWithQueryClient(<TestCustomHandler />);

    const toggle = screen.getByRole("checkbox");
    await user.click(toggle);

    await waitFor(() => {
      expect(customOnChangeCalled).toBe(true);
    });
  });
});
