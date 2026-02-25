// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import DateTimeField from "@amzn/innovation-sandbox-frontend/components/FormFields/DateTimeField";
import { DateTime } from "luxon";

const TestSchema = z.object({
  expirationDate: z.string().datetime(),
});

type TestFormValues = z.infer<typeof TestSchema>;

describe("DateTimeField", () => {
  function TestComponent({ defaultValue }: { defaultValue?: string }) {
    const { control } = useForm<TestFormValues>({
      resolver: zodResolver(TestSchema),
      mode: "onChange",
      defaultValues: {
        expirationDate: defaultValue,
      },
    });

    return (
      <DateTimeField
        controllerProps={{ control, name: "expirationDate" }}
        formFieldProps={{
          label: "Expiration Date",
          description: "Select date and time",
        }}
      />
    );
  }

  it("renders with label and description", () => {
    render(<TestComponent />);

    expect(screen.getByText("Expiration Date")).toBeInTheDocument();
    expect(screen.getByText("Select date and time")).toBeInTheDocument();
  });

  it("renders date and time labels", () => {
    render(<TestComponent />);

    expect(screen.getByText("Date")).toBeInTheDocument();
    expect(screen.getByText("Time")).toBeInTheDocument();
  });

  it("renders with empty values by default", () => {
    render(<TestComponent />);

    const dateInput = screen.getByPlaceholderText("YYYY/MM/DD");
    const timeInput = screen.getByPlaceholderText("hh:mm");

    expect(dateInput).toHaveValue("");
    expect(timeInput).toHaveValue("");
  });

  it("renders with default date and time values", async () => {
    const defaultDate = DateTime.fromISO("2024-06-15T14:30:00.000Z");
    render(<TestComponent defaultValue={defaultDate.toString()} />);

    const dateInput = screen.getByPlaceholderText("YYYY/MM/DD");
    const timeInput = screen.getByPlaceholderText("hh:mm");

    await waitFor(() => {
      expect(dateInput).toHaveValue("2024/06/15");
      expect(timeInput).toHaveValue(defaultDate.toFormat("HH:mm"));
    });
  });

  it("updates date when date picker changes", async () => {
    const user = userEvent.setup();
    render(<TestComponent />);

    const dateInput = screen.getByPlaceholderText("YYYY/MM/DD");

    await user.clear(dateInput);
    await user.type(dateInput, "2024/12/25");

    expect(dateInput).toHaveValue("2024/12/25");
  });

  it("updates time when time input changes", async () => {
    const user = userEvent.setup();
    render(<TestComponent />);

    const timeInput = screen.getByPlaceholderText("hh:mm");

    await user.clear(timeInput);
    await user.type(timeInput, "15:45");

    expect(timeInput).toHaveValue("15:45");
  });

  it("combines date and time into single ISO string value", async () => {
    let capturedValue: string | undefined;

    function TestWithCapture() {
      const { control, watch } = useForm<TestFormValues>({
        defaultValues: { expirationDate: undefined },
      });

      capturedValue = watch("expirationDate");

      return (
        <DateTimeField
          controllerProps={{ control, name: "expirationDate" }}
          formFieldProps={{ label: "Expiration Date" }}
        />
      );
    }

    const user = userEvent.setup();
    render(<TestWithCapture />);

    const dateInput = screen.getByPlaceholderText("YYYY/MM/DD");
    const timeInput = screen.getByPlaceholderText("hh:mm");

    await user.type(dateInput, "2024/12/25");
    await user.type(timeInput, "15:45");

    // The component parses date/time as local time and converts to UTC
    // So we need to create the expected value the same way
    const expectedDateTime = DateTime.fromFormat(
      "2024-12-25 15:45",
      "yyyy-MM-dd HH:mm",
    )
      .toUTC()
      .toISO();

    // The combined value should be an ISO string
    await waitFor(() => {
      expect(capturedValue).toBe(expectedDateTime);
    });
  });

  it("displays validation errors", async () => {
    const RequiredSchema = z.object({
      expirationDate: z
        .string({ required_error: "Expiration date is required" })
        .datetime(),
    });

    function TestValidation() {
      const { control, trigger } = useForm<z.infer<typeof RequiredSchema>>({
        resolver: zodResolver(RequiredSchema),
        mode: "onChange",
        defaultValues: { expirationDate: undefined },
      });

      return (
        <>
          <DateTimeField
            controllerProps={{ control, name: "expirationDate" }}
            formFieldProps={{ label: "Expiration Date" }}
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
      await screen.findByText("Expiration date is required"),
    ).toBeInTheDocument();
  });

  it("shows invalid state on date picker when validation fails", async () => {
    const RequiredSchema = z.object({
      expirationDate: z.string().datetime({
        message: "Required",
      }),
    });

    function TestInvalidState() {
      const { control, trigger } = useForm<z.infer<typeof RequiredSchema>>({
        resolver: zodResolver(RequiredSchema),
        mode: "onChange",
        defaultValues: { expirationDate: undefined },
      });

      return (
        <>
          <DateTimeField
            controllerProps={{ control, name: "expirationDate" }}
            formFieldProps={{ label: "Expiration Date" }}
          />
          <button onClick={() => trigger()}>Validate</button>
        </>
      );
    }

    const user = userEvent.setup();
    render(<TestInvalidState />);

    const validateButton = screen.getByRole("button", { name: "Validate" });
    await user.click(validateButton);

    // CloudScape DatePicker adds aria-invalid when invalid
    const dateInput = screen.getByPlaceholderText("YYYY/MM/DD");
    expect(dateInput).toHaveAttribute("aria-invalid", "true");
  });

  it("handles partial input gracefully", async () => {
    let capturedValue: string | undefined;

    function TestPartialInput() {
      const { control, watch } = useForm<TestFormValues>({
        defaultValues: { expirationDate: undefined },
      });

      capturedValue = watch("expirationDate");

      return (
        <DateTimeField
          controllerProps={{ control, name: "expirationDate" }}
          formFieldProps={{ label: "Expiration Date" }}
        />
      );
    }

    const user = userEvent.setup();
    render(<TestPartialInput />);

    const dateInput = screen.getByPlaceholderText("YYYY/MM/DD");

    // Only enter date, no time
    await user.type(dateInput, "2024/12/25");

    // Value should be undefined until both date and time are provided
    expect(capturedValue).toBeUndefined();
  });

  it("clears value when date is removed", async () => {
    let capturedValue: string | undefined;

    function TestClearValue() {
      const { control, watch } = useForm<TestFormValues>({
        defaultValues: {
          expirationDate: "2024-12-25T15:45:00.000Z",
        },
      });

      capturedValue = watch("expirationDate");

      return (
        <DateTimeField
          controllerProps={{ control, name: "expirationDate" }}
          formFieldProps={{ label: "Expiration Date" }}
        />
      );
    }

    const user = userEvent.setup();
    render(<TestClearValue />);

    const dateInput = screen.getByPlaceholderText("YYYY/MM/DD");

    // Clear the date
    await user.clear(dateInput);

    // Value should be undefined when date is cleared
    expect(capturedValue).toBeUndefined();
  });
});
