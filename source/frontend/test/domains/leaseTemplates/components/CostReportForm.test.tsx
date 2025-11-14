// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter as Router } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

import { CostReportForm } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/CostReportForm";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

describe("CostReportForm", () => {
  const mockOnSubmit = vi.fn();
  const mockOnCancel = vi.fn();

  const renderComponent = (props = {}) =>
    renderWithQueryClient(
      <Router>
        <CostReportForm
          costReportGroup=""
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
          isUpdating={false}
          costReportGroups={["finance-team-a", "marketing-team-b"]}
          requireCostReportGroup={false}
          {...props}
        />
      </Router>,
    );

  test("renders the form with correct initial values", async () => {
    renderComponent({ costReportGroup: "finance-team-a" });

    await waitFor(() => {
      expect(screen.getByLabelText("Set cost report group")).toBeChecked();
      expect(screen.getByText("finance-team-a")).toBeInTheDocument();
    });
  });

  test("shows required message when cost report group is required", async () => {
    const user = userEvent.setup();
    renderComponent({ requireCostReportGroup: true });

    const enableRadio = screen.getByLabelText("Do not set a cost report group");
    await user.click(enableRadio);

    const submitButton = screen.getByRole("button", {
      name: /Update Cost Report Group/i,
    });
    await user.click(submitButton);

    await waitFor(() => {
      expect(
        screen.getByText("Cost report group is required."),
      ).toBeInTheDocument();
    });
  });

  test("submits form with updated cost report group", async () => {
    const user = userEvent.setup();
    renderComponent();

    const enableRadio = screen.getByLabelText("Set cost report group");
    await user.click(enableRadio);

    await waitFor(() => {
      expect(
        screen.getByLabelText("Select cost report group"),
      ).toBeInTheDocument();
    });

    // Click the select dropdown to open it
    const selectButton = screen.getByLabelText("Select cost report group");
    await user.click(selectButton);

    // Wait for options to appear and click the desired option
    await waitFor(() => {
      expect(screen.getByText("marketing-team-b")).toBeInTheDocument();
    });

    const option = screen.getByText("marketing-team-b");
    await user.click(option);

    const submitButton = screen.getByRole("button", {
      name: /Update Cost Report Group/i,
    });
    await user.click(submitButton);

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalledWith({
        costReportGroup: "marketing-team-b",
      });
    });
  });

  test("validates required field when cost report group is required", async () => {
    const user = userEvent.setup();
    renderComponent({ requireCostReportGroup: true });

    const disableRadio = screen.getByLabelText(
      "Do not set a cost report group",
    );
    await user.click(disableRadio);

    const submitButton = screen.getByRole("button", {
      name: /Update Cost Report Group/i,
    });
    await user.click(submitButton);

    await waitFor(() => {
      expect(
        screen.getByText("Cost report group is required."),
      ).toBeInTheDocument();
    });
  });

  test("validates select field when enabled but no group selected", async () => {
    const user = userEvent.setup();
    renderComponent();

    const enableRadio = screen.getByLabelText("Set cost report group");
    await user.click(enableRadio);

    const submitButton = screen.getByRole("button", {
      name: /Update Cost Report Group/i,
    });
    await user.click(submitButton);

    await waitFor(() => {
      expect(
        screen.getByText("Please select a cost report group"),
      ).toBeInTheDocument();
    });
  });

  test("handles disabled cost report group", async () => {
    const user = userEvent.setup();
    renderComponent({ costReportGroup: "finance-team-a" });

    const disableRadio = screen.getByLabelText(
      "Do not set a cost report group",
    );
    await user.click(disableRadio);

    const submitButton = screen.getByRole("button", {
      name: /Update Cost Report Group/i,
    });
    await user.click(submitButton);

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalledWith({
        costReportGroup: undefined,
      });
    });
  });

  test("calls onCancel when cancel button is clicked", async () => {
    const user = userEvent.setup();
    renderComponent();

    const cancelButton = screen.getByRole("button", { name: /cancel/i });
    await user.click(cancelButton);

    expect(mockOnCancel).toHaveBeenCalled();
  });

  test("shows loading state when updating", async () => {
    renderComponent({ isUpdating: true });

    await waitFor(() => {
      const submitButton = screen.getByRole("button", {
        name: /Update Cost Report Group/i,
      });
      expect(submitButton).toBeInTheDocument();
    });
  });

  test("shows 'No cost report groups available' message when no cost report groups are provided", async () => {
    const user = userEvent.setup();
    renderComponent({ costReportGroups: undefined });

    const enableRadio = screen.getByLabelText("Set cost report group");
    await user.click(enableRadio);

    await waitFor(() => {
      expect(
        screen.getByText(
          "No cost report groups available. Please contact your administrator.",
        ),
      ).toBeInTheDocument();
    });
  });
});
