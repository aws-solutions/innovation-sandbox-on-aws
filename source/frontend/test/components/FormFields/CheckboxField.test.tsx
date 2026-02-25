// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import CheckboxField from "@amzn/innovation-sandbox-frontend/components/FormFields/CheckboxField";

const TestSchema = z.object({
  isEnabled: z.boolean(),
});

type TestFormValues = z.infer<typeof TestSchema>;

describe("CheckboxField", () => {
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
      <CheckboxField
        controllerProps={{ control, name: "isEnabled" }}
        formFieldProps={{
          label: "Enable Feature",
          description: "Toggle to enable or disable",
        }}
        checkboxProps={{
          children: isEnabled ? "Enabled" : "Disabled",
        }}
      />
    );
  }

  it("renders with label and description", () => {
    render(<TestComponent />);

    expect(screen.getByText("Enable Feature")).toBeInTheDocument();
    expect(screen.getByText("Toggle to enable or disable")).toBeInTheDocument();
  });

  it("renders unchecked by default", () => {
    render(<TestComponent />);

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("renders checked when defaultValue is true", () => {
    render(<TestComponent defaultValue={true} />);

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
  });

  it("toggles value when clicked", async () => {
    const user = userEvent.setup();
    render(<TestComponent />);

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(screen.getByText("Enabled")).toBeInTheDocument();

    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("supports disabled state", () => {
    function TestWithProps() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { isEnabled: false },
      });

      return (
        <CheckboxField
          controllerProps={{ control, name: "isEnabled" }}
          formFieldProps={{ label: "Enable Feature" }}
          checkboxProps={{
            children: "Disabled Checkbox",
            disabled: true,
          }}
        />
      );
    }

    render(<TestWithProps />);

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeDisabled();
  });

  it("displays validation errors", async () => {
    const CustomSchema = z.object({
      isEnabled: z.boolean().refine((val) => val === true, {
        message: "Must be enabled",
      }),
    });

    function TestValidation() {
      const { control, trigger } = useForm<z.infer<typeof CustomSchema>>({
        resolver: zodResolver(CustomSchema),
        mode: "onChange",
        defaultValues: { isEnabled: false },
      });

      return (
        <>
          <CheckboxField
            controllerProps={{ control, name: "isEnabled" }}
            formFieldProps={{ label: "Enable Feature" }}
            checkboxProps={{
              children: "Accept terms",
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

    // Look for the error message in the form field error container
    expect(await screen.findByText("Must be enabled")).toBeInTheDocument();
  });

  it("calls custom onChange handler", async () => {
    let customOnChangeCalled = false;

    function TestCustomHandler() {
      const { control } = useForm<TestFormValues>({
        defaultValues: { isEnabled: false },
      });

      return (
        <CheckboxField
          controllerProps={{ control, name: "isEnabled" }}
          formFieldProps={{ label: "Enable Feature" }}
          checkboxProps={{
            children: "Test",
            onChange: () => {
              customOnChangeCalled = true;
            },
          }}
        />
      );
    }

    const user = userEvent.setup();
    render(<TestCustomHandler />);

    const checkbox = screen.getByRole("checkbox");
    await user.click(checkbox);

    expect(customOnChangeCalled).toBe(true);
  });
});
