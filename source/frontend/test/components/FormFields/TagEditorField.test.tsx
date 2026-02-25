// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import TagEditorField from "@amzn/innovation-sandbox-frontend/components/FormFields/TagEditorField";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const TagSchema = z.object({
  key: z.string().min(1, "Key is required"),
  value: z.string().optional(),
});

const TestSchema = z.object({
  tags: z.array(TagSchema),
});

type TestFormValues = z.infer<typeof TestSchema>;

function TestComponent({
  defaultTags = [],
  maxTags,
}: {
  defaultTags?: Array<{ key: string; value?: string }>;
  maxTags?: number;
}) {
  const methods = useForm<TestFormValues>({
    resolver: zodResolver(TestSchema),
    mode: "all",
    defaultValues: {
      tags: defaultTags,
    },
  });

  return (
    <FormProvider {...methods}>
      <TagEditorField
        controllerProps={{ control: methods.control, name: "tags" }}
        formFieldProps={{
          label: "Tags",
          description: "Add tags to your resource",
        }}
        maxTags={maxTags}
      />
    </FormProvider>
  );
}

describe("TagEditorField", () => {
  test("renders with label and description", () => {
    renderWithQueryClient(<TestComponent />);

    expect(screen.getByText("Tags")).toBeInTheDocument();
    expect(screen.getByText("Add tags to your resource")).toBeInTheDocument();
  });

  test("adds a new tag on button click", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    await user.click(screen.getByRole("button", { name: /add tag/i }));

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /remove/i })).toHaveLength(
        1,
      );
    });
  });

  test("removes a tag on remove button click", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <TestComponent
        defaultTags={[
          { key: "env", value: "prod" },
          { key: "team", value: "alpha" },
        ]}
      />,
    );

    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    expect(removeButtons).toHaveLength(2);

    await user.click(removeButtons[0]);

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /remove/i })).toHaveLength(
        1,
      );
    });
  });

  test("disables add button when maxTags reached", () => {
    renderWithQueryClient(
      <TestComponent
        defaultTags={[
          { key: "env", value: "prod" },
          { key: "team", value: "alpha" },
        ]}
        maxTags={2}
      />,
    );

    const addButton = screen.getByRole("button", { name: /add tag/i });
    expect(addButton).toHaveAttribute("aria-disabled", "true");
  });

  test("displays validateKey error for invalid key", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    await user.click(screen.getByRole("button", { name: /add tag/i }));

    // Find the key input by its name attribute and trigger blur
    const keyInput = screen.getByRole("textbox", { name: /key/i });
    await user.click(keyInput);
    await user.tab(); // Blur the field

    await waitFor(() => {
      expect(screen.getByText("Key is required")).toBeInTheDocument();
    });
  });
});
