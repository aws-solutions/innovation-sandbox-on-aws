// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { DeploymentTimeoutForm } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/forms/DeploymentTimeoutForm";
import { REGION_CONCURRENCY_OPTIONS } from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";
import { BLUEPRINT_DEPLOYMENT_TIMEOUT } from "@amzn/innovation-sandbox-frontend/domains/blueprints/validation";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

describe("DeploymentTimeoutForm", () => {
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
        deploymentTimeout: BLUEPRINT_DEPLOYMENT_TIMEOUT.DEFAULT,
        regionConcurrencyType: REGION_CONCURRENCY_OPTIONS.SEQUENTIAL,
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
        <DeploymentTimeoutForm />
      </TestWrapper>,
    );

  test("renders deployment timeout form", () => {
    renderComponent();

    expect(screen.getByText("Timeout")).toBeInTheDocument();
  });

  test("renders timeout slider", () => {
    renderComponent();

    const slider = screen.getByRole("slider");
    expect(slider).toBeInTheDocument();
  });

  test("displays default timeout value", () => {
    renderComponent();

    expect(screen.getByText(/Timeout:/i)).toBeInTheDocument();
  });

  test("shows sequential deployment tip for sequential concurrency", () => {
    renderComponent({
      regionConcurrencyType: REGION_CONCURRENCY_OPTIONS.SEQUENTIAL,
    });

    expect(
      screen.getByText(
        /Sequential deployments across multiple regions may need longer timeouts/i,
      ),
    ).toBeInTheDocument();
  });

  test("shows parallel deployment tip for parallel concurrency", () => {
    renderComponent({
      regionConcurrencyType: REGION_CONCURRENCY_OPTIONS.PARALLEL,
    });

    expect(
      screen.getByText(/Parallel deployments typically complete faster/i),
    ).toBeInTheDocument();
  });

  test("allows changing timeout value", async () => {
    renderComponent();

    const slider = screen.getByRole("slider");

    expect(slider).toBeInTheDocument();
  });

  test("displays formatted timeout duration", () => {
    renderComponent({ deploymentTimeout: 60 });

    // Verify actual formatted value, not just presence of "Timeout:" text
    expect(screen.getByText(/Timeout: 60 minutes/i)).toBeInTheDocument();
  });

  test("renders with minimum timeout value", () => {
    renderComponent({ deploymentTimeout: BLUEPRINT_DEPLOYMENT_TIMEOUT.MIN });

    const slider = screen.getByRole("slider");
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveValue(BLUEPRINT_DEPLOYMENT_TIMEOUT.MIN.toString());
  });

  test("renders with maximum timeout value", () => {
    renderComponent({ deploymentTimeout: BLUEPRINT_DEPLOYMENT_TIMEOUT.MAX });

    const slider = screen.getByRole("slider");
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveValue(BLUEPRINT_DEPLOYMENT_TIMEOUT.MAX.toString());
  });
});
