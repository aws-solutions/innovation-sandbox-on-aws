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
import { EditAccessAndSharing } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditAccessAndSharing";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import { mockAdvancedLeaseTemplate } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockNavigate = vi.fn();
const mockUseUser = vi.fn();
const mockUuid = mockAdvancedLeaseTemplate.uuid;
let permissionSetRequestCount = 0;
const mockConfig = createConfiguration({
  leases: {
    maxBudget: 500,
    requireMaxBudget: false,
    maxDurationHours: 720,
    requireMaxDuration: false,
    leaseSharingEnabled: true,
  },
});

const developerPermissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
  permissionSetId: "ps-0123456789abcdef",
  name: "DeveloperAccess",
  description: "Developer sandbox access",
  availability: "AVAILABLE" as const,
};

const auditorPermissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1123456789abcdef",
  permissionSetId: "ps-1123456789abcdef",
  name: "AuditorAccess",
  description: "Read-only sandbox access",
  availability: "AVAILABLE" as const,
};

const powerUserPermissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-2123456789abcdef",
  permissionSetId: "ps-2123456789abcdef",
  name: "PowerUserAccess",
  description: "Power-user sandbox access",
  availability: "AVAILABLE" as const,
};

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

vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => mockUseUser(),
}));

function pinHydratedTemplate() {
  server.use(
    http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
      HttpResponse.json({
        status: "success",
        data: {
          ...mockAdvancedLeaseTemplate,
          defaultPermissionSet: developerPermissionSet,
          allowedPermissionSets: [developerPermissionSet, auditorPermissionSet],
        },
      }),
    ),
    http.get(`${getConfig().ApiUrl}/permissionSets`, () => {
      permissionSetRequestCount += 1;
      return HttpResponse.json({
        status: "success",
        data: {
          result: [
            developerPermissionSet,
            auditorPermissionSet,
            powerUserPermissionSet,
          ],
        },
      });
    }),
    http.get(`${getConfig().ApiUrl}/configurations`, () =>
      HttpResponse.json({ status: "success", data: mockConfig }),
    ),
  );
}

describe("EditAccessAndSharing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUser.mockReturnValue({
      isAdmin: true,
      isManager: false,
      isUser: false,
    });
    mockNavigate.mockClear();
    permissionSetRequestCount = 0;
    pinHydratedTemplate();
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditAccessAndSharing />
      </Router>,
    );

  test("loads the hydrated profile and explains future-lease semantics", async () => {
    renderComponent();

    expect(await screen.findByText("Edit access and sharing")).toBeVisible();
    expect(screen.getByText("Allow owner to share lease")).toBeVisible();
    expect(screen.getAllByText("DeveloperAccess").length).toBeGreaterThan(0);
    expect(screen.getByText("AuditorAccess")).toBeVisible();
    expect(screen.getByText("Default").closest("tr")).toHaveTextContent(
      "DeveloperAccess",
    );
    expect(permissionSetRequestCount).toBe(0);
    expect(
      screen.getByText(/Changes apply only to future leases/i),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  test("treats a missing allowed permission-set list as an empty selection", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            defaultPermissionSet: developerPermissionSet,
            allowedPermissionSets: undefined,
          },
        }),
      ),
    );

    renderComponent();

    expect(
      await screen.findByRole("heading", {
        name: "Selected permission sets",
      }),
    ).toBeVisible();
    expect(screen.getByText("Default")).toBeVisible();
    expect(screen.getByText("Default").closest("tr")).toHaveTextContent(
      "DeveloperAccess",
    );
  });

  test("uses the real form and disables it while updating the template", async () => {
    const templateUpdate = vi.fn();
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          templateUpdate(await request.json());
          await updateGate;
          return HttpResponse.json({ status: "success", data: {} });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    expect(await screen.findByText("Default")).toBeVisible();
    await user.click(screen.getByLabelText("Add permission sets"));
    await user.click(await screen.findByText("PowerUserAccess"));
    await user.click(
      screen.getByRole("button", {
        name: "Set PowerUserAccess as default permission set",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeEnabled();
    });
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(templateUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: mockAdvancedLeaseTemplate.name,
          allowOwnerToShareLease:
            mockAdvancedLeaseTemplate.allowOwnerToShareLease,
          defaultPermissionSetArn: powerUserPermissionSet.permissionSetArn,
          allowedPermissionSetArns: [
            developerPermissionSet.permissionSetArn,
            auditorPermissionSet.permissionSetArn,
          ],
        }),
      );
    });
    expect(screen.getByLabelText("Add permission sets")).toBeDisabled();
    expect(
      screen.getByRole("link", {
        name: "Manage permission sets",
      }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    releaseUpdate();
    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Access settings updated successfully.",
      );
      expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
    });
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  test("shows a load error and retries the lease template request", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () => {
        requestCount += 1;
        if (requestCount === 1) {
          return HttpResponse.json(
            { status: "error", message: "Temporary failure" },
            { status: 500 },
          );
        }
        return HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            defaultPermissionSet: developerPermissionSet,
            allowedPermissionSets: [
              developerPermissionSet,
              auditorPermissionSet,
            ],
          },
        });
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    expect(screen.getByText("Loading...")).toBeVisible();
    expect(
      await screen.findByText(
        "There was a problem loading this lease template.",
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Edit access and sharing")).toBeVisible();
    expect(requestCount).toBe(2);
  });

  test("shows a configuration error and retries the configuration request", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () => {
        requestCount += 1;
        if (requestCount === 1) {
          return HttpResponse.json(
            { status: "error", message: "Temporary configuration failure" },
            { status: 500 },
          );
        }
        return HttpResponse.json({ status: "success", data: mockConfig });
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    expect(
      await screen.findByText(
        "There was a problem loading configuration settings.",
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Edit access and sharing")).toBeVisible();
    expect(requestCount).toBe(2);
  });

  test("shows an error and stays on the form when the update fails", async () => {
    server.use(
      http.put(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json(
          { status: "error", message: "Update failed" },
          { status: 500 },
        ),
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    expect(await screen.findByText("Default")).toBeVisible();
    await user.click(screen.getByLabelText("Add permission sets"));
    await user.click(await screen.findByText("PowerUserAccess"));
    await user.click(
      screen.getByRole("button", {
        name: "Set PowerUserAccess as default permission set",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update access settings"),
        "Update Failed",
      );
    });
    expect(showSuccessToast).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  test("navigates back without updating on cancel", async () => {
    renderComponent();
    const user = userEvent.setup();

    expect(await screen.findByText("Default")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
  });
});
