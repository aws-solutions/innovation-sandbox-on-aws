// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { EditDeploymentConfigForm } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/forms/EditDeploymentConfigForm";
import { REGION_CONCURRENCY_OPTIONS } from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";
import { BLUEPRINT_DEPLOYMENT_TIMEOUT } from "@amzn/innovation-sandbox-frontend/domains/blueprints/validation";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

describe("EditDeploymentConfigForm", () => {
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
        deploymentStrategy: "Default",
        regionConcurrencyType: REGION_CONCURRENCY_OPTIONS.SEQUENTIAL,
        maxConcurrentPercentage: 100,
        failureTolerancePercentage: 0,
        concurrencyMode: "STRICT_FAILURE_TOLERANCE",
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
        <EditDeploymentConfigForm />
      </TestWrapper>,
    );

  test("renders both deployment strategy and timeout forms", () => {
    renderComponent();

    expect(screen.getByText("Deployment strategy")).toBeInTheDocument();
    expect(screen.getByText("Timeout")).toBeInTheDocument();
  });

  test("does not render region selection form", () => {
    renderComponent();

    expect(screen.queryByText("Regions")).not.toBeInTheDocument();
  });

  test("renders deployment strategy options", () => {
    renderComponent();

    expect(screen.getByRole("radio", { name: /Default/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Custom/i })).toBeInTheDocument();
  });

  test("renders timeout slider", () => {
    renderComponent();

    const slider = screen.getByRole("slider");
    expect(slider).toBeInTheDocument();
  });

  test("composes strategy and timeout forms correctly", () => {
    renderComponent();

    expect(screen.getByText("Deployment strategy")).toBeInTheDocument();
    expect(screen.getByText("Timeout")).toBeInTheDocument();
    expect(screen.getByRole("slider")).toBeInTheDocument();
  });

  test("renders with custom deployment strategy", () => {
    renderComponent({ deploymentStrategy: "Custom" });

    expect(screen.getByText("Deployment strategy")).toBeInTheDocument();
    expect(screen.getByText("Timeout")).toBeInTheDocument();
  });

  test("renders with different timeout values", () => {
    renderComponent({ deploymentTimeout: 120 });

    expect(screen.getByText("Timeout")).toBeInTheDocument();
    expect(screen.getByRole("slider")).toBeInTheDocument();
  });

  test("renders with parallel concurrency type", () => {
    renderComponent({
      regionConcurrencyType: REGION_CONCURRENCY_OPTIONS.PARALLEL,
    });

    expect(screen.getByText("Deployment strategy")).toBeInTheDocument();
    expect(screen.getByText("Timeout")).toBeInTheDocument();
  });
});
