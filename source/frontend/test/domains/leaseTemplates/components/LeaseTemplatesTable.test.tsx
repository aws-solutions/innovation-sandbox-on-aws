// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { describe, expect, test } from "vitest";

import { LeaseTemplatesTable } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/LeaseTemplatesTable";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { mockLeaseTemplates } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

describe("LeaseTemplatesTable", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <LeaseTemplatesTable />
      </Router>,
    );

  test("renders the table with lease templates", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Lease Templates")).toBeInTheDocument();
      expect(screen.getByText(mockLeaseTemplates[0].name)).toBeInTheDocument();
      expect(screen.getByText(mockLeaseTemplates[1].name)).toBeInTheDocument();
    });
  });

  test("handles error when fetching lease templates fails", async () => {
    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates`, () => {
        return HttpResponse.json(
          { status: "error", message: "Failed to fetch lease templates" },
          { status: 500 },
        );
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("Could not load lease templates. Please try again."),
      ).toBeInTheDocument();
    });
  });

  test("allows selecting and deleting lease templates", async () => {
    renderComponent();
    const user = userEvent.setup();

    // Waiting for initial render
    await waitFor(() => {
      expect(screen.getByText(mockLeaseTemplates[0].name)).toBeInTheDocument();
    });

    // Select a template
    const basicTemplateRow = screen
      .getByText(mockLeaseTemplates[0].name)
      .closest("tr");
    if (!basicTemplateRow) throw new Error("Basic Template row not found");

    const checkbox = within(basicTemplateRow).getByRole("checkbox");
    await user.click(checkbox);

    // Open actions dropdown
    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    // Click delete option
    const deleteOption = await screen.findByRole("menuitem", {
      name: /delete/i,
    });
    await user.click(deleteOption);

    // Confirming deletion
    const confirmButton = await screen.findByRole("button", {
      name: /delete/i,
    });
    await user.click(confirmButton);

    // Waiting for the deletion process and refetch
    await waitFor(() => {
      expect(
        screen.queryByText(mockLeaseTemplates[0].name),
      ).not.toBeInTheDocument();
    });

    // Checking if other templates still exist
    expect(screen.getByText(mockLeaseTemplates[1].name)).toBeInTheDocument();
  });

  test("refreshes the table data", async () => {
    const initialTemplates = [...mockLeaseTemplates];
    const refreshedTemplates = [mockLeaseTemplates[0]];

    let callCount = 0;
    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates`, () => {
        callCount++;
        const data = callCount === 1 ? initialTemplates : refreshedTemplates;
        return HttpResponse.json({
          status: "success",
          data: { result: data, nextPageIdentifier: null },
        });
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(initialTemplates[0].name)).toBeInTheDocument();
      expect(screen.getByText(initialTemplates[1].name)).toBeInTheDocument();
    });

    const refreshButton = screen.getByTestId("refresh-button");

    await user.click(refreshButton);

    await waitFor(() => {
      expect(screen.getByText(refreshedTemplates[0].name)).toBeInTheDocument();
      expect(
        screen.queryByText(initialTemplates[1].name),
      ).not.toBeInTheDocument();
    });
  });

  test("navigates to edit page when clicking on a template name", async () => {
    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates`, () => {
        return HttpResponse.json({
          status: "success",
          data: { result: mockLeaseTemplates, nextPageIdentifier: null },
        });
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockLeaseTemplates[0].name)).toBeInTheDocument();
    });

    const templateLink = screen.getByText(mockLeaseTemplates[0].name);
    await user.click(templateLink);

    expect(templateLink.closest("a")).toHaveAttribute(
      "href",
      `/lease_templates/${mockLeaseTemplates[0].uuid}`,
    );
  });
});
