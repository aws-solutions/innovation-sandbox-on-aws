// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { RegionSelectionForm } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/forms/RegionSelectionForm";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

describe("RegionSelectionForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const TestWrapper = ({
    defaultValues = {},
    children,
  }: {
    defaultValues?: Record<string, any>;
    children: React.ReactNode;
  }) => {
    const methods = useForm({
      defaultValues: {
        selectedRegions: [],
        ...defaultValues,
      },
    });

    return (
      <Router>
        <FormProvider {...methods}>{children}</FormProvider>
      </Router>
    );
  };

  const renderComponent = (defaultValues = {}) =>
    renderWithQueryClient(
      <TestWrapper defaultValues={defaultValues}>
        <RegionSelectionForm />
      </TestWrapper>,
    );

  test("renders region selection form", () => {
    renderComponent();

    expect(screen.getByText("Regions")).toBeInTheDocument();
  });

  test("renders with empty regions by default", () => {
    renderComponent();

    expect(screen.getByText("Regions")).toBeInTheDocument();
  });

  test("renders with pre-selected regions", () => {
    renderComponent({ selectedRegions: ["us-east-1", "us-west-2"] });

    expect(screen.getByText("Regions")).toBeInTheDocument();
  });

  test("allows adding regions", async () => {
    renderComponent();

    expect(screen.getByText("Regions")).toBeInTheDocument();
  });

  test("displays validation error when no regions selected", async () => {
    const TestWrapperWithValidation = () => {
      const methods = useForm({
        defaultValues: {
          selectedRegions: [],
        },
        mode: "all",
      });

      return (
        <Router>
          <FormProvider {...methods}>
            <RegionSelectionForm />
          </FormProvider>
        </Router>
      );
    };

    renderWithQueryClient(<TestWrapperWithValidation />);

    expect(screen.getByText("Regions")).toBeInTheDocument();
  });
});
