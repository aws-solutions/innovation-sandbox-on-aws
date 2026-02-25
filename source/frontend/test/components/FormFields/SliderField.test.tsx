// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import SliderField from "@amzn/innovation-sandbox-frontend/components/FormFields/SliderField";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const TestSchema = z.object({
  volume: z.number().min(0).max(100),
});

type TestFormValues = z.infer<typeof TestSchema>;

function TestComponent({ defaultValue = 50 }: { defaultValue?: number }) {
  const { control } = useForm<TestFormValues>({
    resolver: zodResolver(TestSchema),
    mode: "onChange",
    defaultValues: {
      volume: defaultValue,
    },
  });

  return (
    <SliderField
      controllerProps={{ control, name: "volume" }}
      formFieldProps={{
        label: "Volume",
        description: "Adjust the volume level",
      }}
      sliderProps={{
        min: 0,
        max: 100,
        step: 1,
      }}
    />
  );
}

describe("SliderField", () => {
  test("renders with label and description", () => {
    renderWithQueryClient(<TestComponent />);

    expect(screen.getByText("Volume")).toBeInTheDocument();
    expect(screen.getByText("Adjust the volume level")).toBeInTheDocument();
  });

  test("renders slider element", () => {
    renderWithQueryClient(<TestComponent />);

    expect(screen.getByRole("slider")).toBeInTheDocument();
  });

  test("displays validation error on submit", async () => {
    const StrictSchema = z.object({
      volume: z
        .number()
        .refine((val) => val >= 10, { message: "Volume must be at least 10" }),
    });

    function TestValidation() {
      const { control, handleSubmit } = useForm<z.infer<typeof StrictSchema>>({
        resolver: zodResolver(StrictSchema),
        defaultValues: { volume: 5 },
      });

      return (
        <form onSubmit={handleSubmit(() => {})}>
          <SliderField
            controllerProps={{ control, name: "volume" }}
            formFieldProps={{ label: "Volume" }}
            sliderProps={{ min: 0, max: 100 }}
          />
          <button type="submit">Submit</button>
        </form>
      );
    }

    const user = userEvent.setup();
    renderWithQueryClient(<TestValidation />);

    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(
        screen.getByText("Volume must be at least 10"),
      ).toBeInTheDocument();
    });
  });
});
