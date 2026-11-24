// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { EditCostReportSettings } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditCostReportSettings";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import { mockBasicLeaseTemplate } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockNavigate = vi.fn();
const mockUuid = mockBasicLeaseTemplate.uuid;

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ uuid: mockUuid }),
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

describe("EditCostReportSettings", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.clearAllMocks();
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditCostReportSettings />
      </Router>,
    );

  test("renders form with existing cost report settings", async () => {
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(/Edit Cost Report Settings/i),
      ).toBeInTheDocument();
    });
  });

  test("describes the leases that use the template", async () => {
    renderComponent();

    expect(
      await screen.findByText(
        "When enabled, leases using this template will be assigned to a cost report group for billing and reporting purposes",
      ),
    ).toBeInTheDocument();
  });

  test("navigates back on cancel", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByText(/Edit Cost Report Settings/i),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
  });

  test("submits form successfully", async () => {
    const submitSpy = vi.fn();
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          const data = await request.json();
          submitSpy(data);
          return HttpResponse.json({ status: "success", data });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByText(/Edit Cost Report Settings/i),
      ).toBeInTheDocument();
    });

    // Enable cost report group
    const enableToggle = screen.getByRole("checkbox");
    await user.click(enableToggle);

    await waitFor(() => {
      const saveButton = screen.getByRole("button", { name: /save changes/i });
      expect(saveButton).not.toBeDisabled();
    });

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Cost report settings updated successfully.",
      );
      expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
    });
  });

  test("displays error toast on submission failure", async () => {
    server.use(
      http.put(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () => {
        return HttpResponse.json(
          { status: "error", message: "Update failed" },
          { status: 500 },
        );
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByText(/Edit Cost Report Settings/i),
      ).toBeInTheDocument();
    });

    const enableToggle = screen.getByRole("checkbox");
    await user.click(enableToggle);

    await waitFor(() => {
      const saveButton = screen.getByRole("button", { name: /save changes/i });
      expect(saveButton).not.toBeDisabled();
    });

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update cost report settings"),
        "Update Failed",
      );
    });
  });

  test("disables save button when form is not dirty", async () => {
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(/Edit Cost Report Settings/i),
      ).toBeInTheDocument();
    });

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    expect(saveButton).toBeDisabled();
  });

  test("assigns a group when required and none was previously set", async () => {
    // Regression: with a required group and none set, the enable toggle is
    // forced-on-but-disabled, so costReportGroupEnabled stays false. Selecting a
    // group must still submit it (not undefined).
    const configWithRequired = createConfiguration({
      costReporting: {
        costReportGroups: ["group-a", "group-b"],
        requireCostReportGroup: true,
      },
    });

    let submittedData: any = null;
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: configWithRequired }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: { ...mockBasicLeaseTemplate, costReportGroup: undefined },
        }),
      ),
      http.put(
        `${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          submittedData = await request.json();
          return HttpResponse.json({ status: "success", data: submittedData });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByText(/Edit Cost Report Settings/i),
      ).toBeInTheDocument();
    });

    expect(screen.getByRole("checkbox")).toBeChecked();

    // Open the select and choose a group.
    const selectTrigger = screen
      .getAllByRole("button")
      .find((btn) => btn.textContent?.includes("Select a cost report group"));
    expect(selectTrigger).toBeDefined();
    await user.click(selectTrigger!);
    await user.click(await screen.findByText("group-b"));

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    await user.click(saveButton);

    await waitFor(() => expect(submittedData?.costReportGroup).toBe("group-b"));
  });
});
