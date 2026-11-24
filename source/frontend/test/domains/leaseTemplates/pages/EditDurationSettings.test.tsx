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
import { EditDurationSettings } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditDurationSettings";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import { mockAdvancedLeaseTemplate } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockNavigate = vi.fn();
const mockUuid = mockAdvancedLeaseTemplate.uuid;

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

describe("EditDurationSettings", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.clearAllMocks();
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditDurationSettings />
      </Router>,
    );

  test("renders form with existing duration settings", async () => {
    renderComponent();

    await waitFor(() => {
      const durationInput = screen.getByLabelText("Maximum Duration (Hours)");
      expect(durationInput).toBeInTheDocument();
      // Just verify the field exists and has some value
      if (mockAdvancedLeaseTemplate.leaseDurationInHours) {
        expect(durationInput).toHaveValue(
          mockAdvancedLeaseTemplate.leaseDurationInHours,
        );
      }
    });
  });

  test("navigates back on cancel", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum Duration (Hours)"),
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
        screen.getByLabelText("Maximum Duration (Hours)"),
      ).toBeInTheDocument();
    });

    const durationInput = screen.getByLabelText("Maximum Duration (Hours)");
    await user.tripleClick(durationInput);
    await user.keyboard("240");

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Duration settings updated successfully.",
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
        screen.getByLabelText("Maximum Duration (Hours)"),
      ).toBeInTheDocument();
    });

    const durationInput = screen.getByLabelText("Maximum Duration (Hours)");
    await user.tripleClick(durationInput);
    await user.keyboard("240");

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update duration settings"),
        "Update Failed",
      );
    });
  });

  test("disables save button when form is not dirty", async () => {
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum Duration (Hours)"),
      ).toBeInTheDocument();
    });

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    expect(saveButton).toBeDisabled();
  });

  test("assigns a duration when required and none was previously set", async () => {
    // Regression: with a required duration and none set, the enable toggle is
    // forced-on-but-disabled, so maxDurationEnabled stays false. Entering a
    // value must still submit it (not undefined).
    const configRequired = createConfiguration({
      leases: {
        maxDurationHours: 8760,
        requireMaxDuration: true,
      },
    });

    let submittedData: any = null;
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: configRequired }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            leaseDurationInHours: undefined,
            durationThresholds: undefined,
          },
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
        screen.getByLabelText("Maximum Duration (Hours)"),
      ).toBeInTheDocument();
    });

    const toggle = screen.getByRole("checkbox", { name: /Duration limit/ });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Add Threshold" }),
    ).toBeInTheDocument();

    const durationInput = screen.getByLabelText("Maximum Duration (Hours)");
    await user.tripleClick(durationInput);
    await user.keyboard("240");

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => expect(submittedData?.leaseDurationInHours).toBe(240));
  });

  test("drops hidden invalid values when the maximum duration is turned off, so the change can be saved", async () => {
    let submittedData: any = null;
    server.use(
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
        screen.getByLabelText("Maximum Duration (Hours)"),
      ).toBeInTheDocument();
    });

    // A duration of 0 is invalid, and so is a new row, which starts at 0 hours
    // remaining.
    await user.tripleClick(screen.getByLabelText("Maximum Duration (Hours)"));
    await user.keyboard("0");
    await user.click(screen.getByRole("button", { name: "Add Threshold" }));
    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeDisabled());

    const toggle = screen.getByRole("checkbox", { name: /Duration limit/ });
    await user.click(toggle);
    await waitFor(() => expect(saveButton).toBeEnabled());

    // Turning it back on shows the saved duration and threshold again.
    await user.click(toggle);
    expect(screen.getByLabelText("Maximum Duration (Hours)")).toHaveValue(72);
    expect(screen.getAllByPlaceholderText("e.g., 24")).toHaveLength(1);
    expect(screen.getByPlaceholderText("e.g., 24")).toHaveValue(24);

    await user.click(toggle);
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => expect(submittedData).not.toBeNull());
    expect(submittedData.leaseDurationInHours).toBeUndefined();
    expect(submittedData.durationThresholds).toBeUndefined();
  });

  test("removes an added threshold when the maximum duration is turned off and on, for a template with no saved thresholds", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: { ...mockAdvancedLeaseTemplate, durationThresholds: undefined },
        }),
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum Duration (Hours)"),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add Threshold" }));
    expect(screen.getAllByPlaceholderText("e.g., 24")).toHaveLength(1);

    const toggle = screen.getByRole("checkbox", { name: /Duration limit/ });
    await user.click(toggle);
    await user.click(toggle);

    expect(screen.queryByPlaceholderText("e.g., 24")).not.toBeInTheDocument();
  });
  test("warns without blocking when the template uses predictive controls and duration is under 48 hours", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            predictiveBudgetEnabled: true,
            leaseDurationInHours: 12,
          },
        }),
      ),
    );

    renderComponent();

    expect(
      await screen.findByText(/estimated-cost thresholds may never fire/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeInTheDocument();
  });
  test("does not warn when the template does not use predictive controls", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            predictiveBudgetEnabled: false,
            leaseDurationInHours: 12,
          },
        }),
      ),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum Duration (Hours)"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/estimated-cost thresholds may never fire/i),
    ).not.toBeInTheDocument();
  });
});
