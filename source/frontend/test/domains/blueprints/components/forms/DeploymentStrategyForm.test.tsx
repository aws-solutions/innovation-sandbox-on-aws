// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormProvider, useForm } from "react-hook-form";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { DeploymentStrategyForm } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/forms/DeploymentStrategyForm";
import { REGION_CONCURRENCY_OPTIONS } from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

describe("DeploymentStrategyForm", () => {
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
        <DeploymentStrategyForm />
      </TestWrapper>,
    );

  test("renders deployment strategy form", () => {
    renderComponent();

    expect(screen.getByText("Deployment strategy")).toBeInTheDocument();
  });

  test("renders deployment strategy options", () => {
    renderComponent();

    expect(screen.getByRole("radio", { name: /Default/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Custom/i })).toBeInTheDocument();
  });

  test("shows description for Default strategy", () => {
    renderComponent({ deploymentStrategy: "Default" });

    expect(
      screen.getByText(/Deploys to one region at a time/i),
    ).toBeInTheDocument();
  });

  test("shows custom controls when Custom strategy selected", async () => {
    renderComponent({ deploymentStrategy: "Custom" });

    await waitFor(() => {
      expect(screen.getByText(/Concurrent deployments:/i)).toBeInTheDocument();
      expect(screen.getByText(/Failure tolerance:/i)).toBeInTheDocument();
      expect(screen.getByText(/Concurrency mode/i)).toBeInTheDocument();
    });
  });

  test("allows changing deployment strategy", async () => {
    renderComponent();
    const user = userEvent.setup();

    const customRadio = screen.getByRole("radio", { name: /Custom/i });
    await user.click(customRadio);

    await waitFor(() => {
      expect(screen.getByText(/Concurrent deployments:/i)).toBeInTheDocument();
    });
  });

  test("updates form values when strategy changes", async () => {
    renderComponent({ deploymentStrategy: "Default" });
    const user = userEvent.setup();

    const customRadio = screen.getByRole("radio", { name: /Custom/i });
    await user.click(customRadio);

    await waitFor(() => {
      expect(customRadio).toBeChecked();
    });
  });

  test("renders sliders for custom strategy", async () => {
    renderComponent({ deploymentStrategy: "Custom" });

    await waitFor(() => {
      const sliders = screen.getAllByRole("slider");
      expect(sliders.length).toBeGreaterThan(0);
    });
  });

  test("renders region concurrency options for custom strategy", async () => {
    renderComponent({ deploymentStrategy: "Custom" });

    await waitFor(() => {
      expect(
        screen.getByRole("radio", { name: /Sequential/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("radio", { name: /Parallel/i }),
      ).toBeInTheDocument();
    });
  });

  test("renders concurrency mode options for custom strategy", async () => {
    renderComponent({ deploymentStrategy: "Custom" });

    await waitFor(() => {
      expect(screen.getByText(/Concurrency mode/i)).toBeInTheDocument();
    });
  });
});
