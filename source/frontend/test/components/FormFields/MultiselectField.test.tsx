// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MultiselectProps } from "@cloudscape-design/components/multiselect";
import { zodResolver } from "@hookform/resolvers/zod";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import MultiselectField from "@amzn/innovation-sandbox-frontend/components/FormFields/MultiselectField";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

type Status = "active" | "inactive" | "pending";

const TestSchema = z.object({
  statuses: z.array(z.enum(["active", "inactive", "pending"])).min(1, {
    error: "Choose at least one status",
  }),
});

type TestFormValues = z.infer<typeof TestSchema>;

const STATUS_OPTIONS: MultiselectProps.Option[] = [
  { label: "Active", value: "active" },
  { label: "Inactive", value: "inactive" },
  { label: "Pending", value: "pending" },
];

const valueToOptions = (
  values: Status[] = [],
): ReadonlyArray<MultiselectProps.Option> =>
  STATUS_OPTIONS.filter((option) => values.includes(option.value as Status));

const optionsToValue = (
  options: ReadonlyArray<MultiselectProps.Option>,
): Status[] =>
  options
    .map((option) => option.value)
    .filter((value): value is Status => value !== undefined);

function TestComponent({
  defaultValue = ["active"],
  shouldUpdateValue,
  onChange,
  validateOnMount = false,
}: {
  defaultValue?: Status[];
  shouldUpdateValue?: (value: Status[]) => boolean;
  onChange?: MultiselectProps["onChange"];
  validateOnMount?: boolean;
}) {
  const { control, trigger, watch } = useForm<TestFormValues>({
    resolver: zodResolver(TestSchema),
    mode: "all",
    defaultValues: {
      statuses: defaultValue,
    },
  });

  useEffect(() => {
    if (validateOnMount) {
      void trigger();
    }
  }, [trigger, validateOnMount]);

  return (
    <>
      <MultiselectField
        controllerProps={{ control, name: "statuses" }}
        formFieldProps={{
          label: "Statuses",
          description: "Choose statuses",
        }}
        multiselectProps={{
          options: STATUS_OPTIONS,
          valueToOptions,
          optionsToValue,
          shouldUpdateValue,
          onChange,
          placeholder: "Choose statuses",
        }}
      />
      <output data-testid="selected-statuses">
        {watch("statuses").join(",")}
      </output>
    </>
  );
}

describe("MultiselectField", () => {
  test("renders the field and selected form value", () => {
    renderWithQueryClient(<TestComponent />);

    expect(screen.getByText("Statuses")).toBeInTheDocument();
    expect(screen.getAllByText("Choose statuses")).toHaveLength(2);
    expect(screen.getByTestId("selected-statuses")).toHaveTextContent("active");
  });

  test("converts selected options into the form value", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    await user.click(screen.getByRole("button", { name: /Statuses/ }));
    await user.click(screen.getByText("Inactive"));

    await waitFor(() => {
      expect(screen.getByTestId("selected-statuses")).toHaveTextContent(
        "active,inactive",
      );
    });
  });

  test("displays the React Hook Form validation error", async () => {
    renderWithQueryClient(
      <TestComponent defaultValue={[]} validateOnMount={true} />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("Choose at least one status"),
      ).toBeInTheDocument();
    });
  });

  test("calls a custom change handler", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithQueryClient(<TestComponent onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Statuses/ }));
    await user.click(screen.getByText("Inactive"));

    expect(onChange).toHaveBeenCalledOnce();
  });

  test("can reject a converted value before updating form state", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <TestComponent
        shouldUpdateValue={(values) => !values.includes("inactive")}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Statuses/ }));
    await user.click(screen.getByText("Inactive"));

    await waitFor(() => {
      expect(screen.getByTestId("selected-statuses")).toHaveTextContent(
        "active",
      );
    });
  });
});
