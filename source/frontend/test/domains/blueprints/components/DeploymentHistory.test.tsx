// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { DeploymentHistory } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/DeploymentHistory";
import { createDeploymentHistory } from "@amzn/innovation-sandbox-frontend/mocks/factories/blueprintFactory";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const getDeploymentIndicators = () =>
  document.querySelectorAll("svg[focusable='false']");

describe("DeploymentHistory", () => {
  test("displays '-' when no deployments provided", () => {
    renderWithQueryClient(<DeploymentHistory deployments={[]} />);

    expect(screen.getByText("-")).toBeInTheDocument();
  });

  test("displays '-' when deployments is undefined", () => {
    renderWithQueryClient(<DeploymentHistory />);

    expect(screen.getByText("-")).toBeInTheDocument();
  });

  test("displays deployment indicators for successful deployments", () => {
    const deployments = [
      createDeploymentHistory({ status: "SUCCEEDED" }),
      createDeploymentHistory({ status: "SUCCEEDED" }),
    ];

    renderWithQueryClient(<DeploymentHistory deployments={deployments} />);

    expect(getDeploymentIndicators()).toHaveLength(2);
  });

  test("displays deployment indicators for failed deployments", () => {
    const deployments = [
      createDeploymentHistory({
        status: "FAILED",
        errorMessage: "Deployment timed out",
      }),
    ];

    renderWithQueryClient(<DeploymentHistory deployments={deployments} />);

    expect(getDeploymentIndicators()).toHaveLength(1);
  });

  test("displays deployment indicators for running deployments", () => {
    const deployments = [
      createDeploymentHistory({
        status: "RUNNING",
        deploymentCompletedAt: undefined,
        duration: undefined,
      }),
    ];

    renderWithQueryClient(<DeploymentHistory deployments={deployments} />);

    expect(getDeploymentIndicators()).toHaveLength(1);
  });

  test("displays mixed deployment statuses", () => {
    const deployments = [
      createDeploymentHistory({ status: "SUCCEEDED" }),
      createDeploymentHistory({ status: "FAILED" }),
      createDeploymentHistory({ status: "RUNNING" }),
    ];

    renderWithQueryClient(<DeploymentHistory deployments={deployments} />);

    expect(getDeploymentIndicators()).toHaveLength(3);
  });

  test("limits display to 10 most recent deployments", () => {
    const deployments = Array.from({ length: 15 }, (_, i) =>
      createDeploymentHistory({
        status: "SUCCEEDED",
        operationId: `op-${i}`,
      }),
    );

    renderWithQueryClient(<DeploymentHistory deployments={deployments} />);

    expect(getDeploymentIndicators()).toHaveLength(10);
  });
});
