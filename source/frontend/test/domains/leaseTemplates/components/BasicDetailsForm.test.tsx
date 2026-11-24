// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { render, screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";

import {
  BasicDetailsForm,
  BasicDetailsFormValues,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/BasicDetailsForm";
import { BasicDetailsValidationSchema } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/validation";

function TestWrapper({
  defaultValues,
}: {
  defaultValues?: Partial<BasicDetailsFormValues>;
}) {
  const methods = useForm<BasicDetailsFormValues>({
    resolver: zodResolver(BasicDetailsValidationSchema),
    mode: "all",
    defaultValues: {
      name: "",
      description: "",
      requiresApproval: true,
      visibility: "PRIVATE",
      ...defaultValues,
    },
  });

  return (
    <FormProvider {...methods}>
      <BasicDetailsForm />
    </FormProvider>
  );
}

describe("BasicDetailsForm", () => {
  it("renders name, description, user request, and approval fields", () => {
    render(<TestWrapper />);

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText(/Description/i)).toBeInTheDocument();
    expect(screen.getByText("Allow user requests")).toBeInTheDocument();
    expect(screen.getByLabelText("Assignment only")).not.toBeChecked();
    expect(screen.getByText("Requires Approval")).toBeInTheDocument();
    expect(
      screen.queryByText("Allow owner to share lease"),
    ).not.toBeInTheDocument();
  });
});
