// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { EditAccessSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditAccessSettings";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import { createActiveLease } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockNavigate = vi.fn();
const mockSetBreadcrumb = vi.fn();
let permissionSetRequestCount = 0;

const RefetchLeaseButton = () => {
  const queryClient = useQueryClient();
  const [refetchComplete, setRefetchComplete] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={async () => {
          setRefetchComplete(false);
          await queryClient.invalidateQueries({
            queryKey: ["leases", "lease-123"],
            exact: true,
          });
          setRefetchComplete(true);
        }}
      >
        Refetch lease
      </button>
      {refetchComplete && <span>Lease refetch complete</span>}
    </>
  );
};

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ leaseId: "lease-123" }),
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => mockSetBreadcrumb,
}));

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

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
const mockConfig = createConfiguration({
  leases: {
    maxBudget: 500,
    requireMaxBudget: false,
    maxDurationHours: 720,
    requireMaxDuration: false,
    leaseSharingEnabled: true,
  },
});

const mockLease = createActiveLease({
  leaseId: "lease-123",
  uuid: "12345678-abcd-4321-abcd-123456789012",
  originalLeaseTemplateName: "Developer Sandbox",
  allowOwnerToShareLease: false,
  defaultPermissionSet: developerPermissionSet,
  allowedPermissionSets: [developerPermissionSet, auditorPermissionSet],
  desiredAssignments: [
    {
      principalId: "12345678-1234-1234-1234-123456789012",
      principalType: "USER",
      permissionSetArn: developerPermissionSet.permissionSetArn,
      displayName: "Assigned developer",
      email: "developer@example.com",
    },
    {
      principalId: "87654321-4321-4321-4321-210987654321",
      principalType: "GROUP",
      permissionSetArn: developerPermissionSet.permissionSetArn,
      displayName: "Development team",
    },
  ],
});

function mockReadApis() {
  server.use(
    http.get(`${getConfig().ApiUrl}/leases/lease-123`, () =>
      HttpResponse.json({ status: "success", data: mockLease }),
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

describe("EditAccessSettings", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditAccessSettings />
        <RefetchLeaseButton />
      </Router>,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    permissionSetRequestCount = 0;
    mockReadApis();
  });

  it("uses the canonical lease name in the breadcrumb", async () => {
    renderComponent();

    await waitFor(() => {
      expect(mockSetBreadcrumb).toHaveBeenCalledWith([
        { text: "Home", href: "/" },
        { text: "Leases", href: "/leases" },
        {
          text: "Developer Sandbox (12345678)",
          href: "/leases/lease-123",
        },
        { text: "Edit Access Settings", href: "" },
      ]);
    });
  });

  it("loads the lease's hydrated profile without a catalog join", async () => {
    renderComponent();

    expect(await screen.findByText("Edit Access Settings")).toBeVisible();
    expect(screen.getByText("Allow owner to share lease")).toBeVisible();
    expect(screen.getByText("Default").closest("tr")).toHaveTextContent(
      "DeveloperAccess",
    );
    expect(screen.getByText("AuditorAccess")).toBeVisible();
    expect(permissionSetRequestCount).toBe(0);
    expect(
      screen.getByText(
        /Changes apply to sharing and permission-set assignments/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("serializes a successful edit and returns to lease details", async () => {
    let patchBody: unknown;
    server.use(
      http.patch(
        `${getConfig().ApiUrl}/leases/lease-123`,
        async ({ request }) => {
          patchBody = await request.json();
          return HttpResponse.json({ status: "success", data: mockLease });
        },
      ),
    );
    const user = userEvent.setup();
    renderComponent();

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
      expect(patchBody).toEqual({
        defaultPermissionSetArn: powerUserPermissionSet.permissionSetArn,
        allowedPermissionSetArns: [
          developerPermissionSet.permissionSetArn,
          auditorPermissionSet.permissionSetArn,
        ],
      });
    });
    expect(showSuccessToast).toHaveBeenCalledWith(
      "Access settings updated successfully.",
    );
    expect(mockNavigate).toHaveBeenCalledWith("/leases/lease-123");
  });

  it("preserves unsaved edits when the lease query refetches", async () => {
    let leaseResponse = mockLease;
    let requestCount = 0;
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        requestCount += 1;
        return HttpResponse.json({
          status: "success",
          data: leaseResponse,
        });
      }),
    );
    const user = userEvent.setup();
    renderComponent();

    expect(await screen.findByText("Default")).toBeVisible();
    await user.click(screen.getByLabelText("Add permission sets"));
    await user.click(await screen.findByText("PowerUserAccess"));
    await user.click(
      screen.getByRole("button", {
        name: "Set PowerUserAccess as default permission set",
      }),
    );
    expect(screen.getByText("Default").closest("tr")).toHaveTextContent(
      "PowerUserAccess",
    );

    const requestsBeforeRefetch = requestCount;
    leaseResponse = {
      ...mockLease,
      userEmail: "updated-owner@example.com",
    };
    await user.click(screen.getByRole("button", { name: "Refetch lease" }));

    await waitFor(() => {
      expect(requestCount).toBeGreaterThan(requestsBeforeRefetch);
    });
    expect(await screen.findByText("Lease refetch complete")).toBeVisible();
    await waitFor(() => {
      expect(screen.getByText("Default").closest("tr")).toHaveTextContent(
        "PowerUserAccess",
      );
    });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("links assignment-count narrowing guidance to the lease assignments", async () => {
    server.use(
      http.patch(`${getConfig().ApiUrl}/leases/lease-123`, () =>
        HttpResponse.json(
          {
            status: "fail",
            data: {
              errors: [
                {
                  message: `Permission set ${developerPermissionSet.permissionSetArn} is still used by a desired assignment.`,
                },
              ],
            },
          },
          {
            status: 409,
            headers: { "x-amzn-errortype": "ConflictError" },
          },
        ),
      ),
    );
    const user = userEvent.setup();
    renderComponent();

    expect(await screen.findByText("Default")).toBeVisible();
    await user.click(screen.getByLabelText("Add permission sets"));
    await user.click(await screen.findByText("PowerUserAccess"));
    await user.click(
      screen.getByRole("button", {
        name: "Set PowerUserAccess as default permission set",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Remove DeveloperAccess" }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(showErrorToast).toHaveBeenCalled());
    const [toastDescription, toastTitle] = vi
      .mocked(showErrorToast)
      .mock.calls.at(-1)!;
    expect(toastTitle).toBe("Update Failed");

    const { container } = renderWithQueryClient(
      <Router>
        <div>{toastDescription}</div>
      </Router>,
    );
    expect(container).toHaveTextContent(
      "2 assignments using DeveloperAccess are still active on Developer Sandbox (12345678).",
    );
    expect(container).not.toHaveTextContent("Assigned developer");
    expect(container).not.toHaveTextContent("developer@example.com");
    expect(container).not.toHaveTextContent("Development team");

    const assignmentsLink = screen.getByRole("link", {
      name: "Open assignments",
    });
    expect(assignmentsLink).toHaveAttribute(
      "href",
      "/leases/lease-123?tab=assignments",
    );
    await user.click(assignmentsLink);
    expect(mockNavigate).toHaveBeenCalledWith(
      "/leases/lease-123?tab=assignments",
    );
    expect(showSuccessToast).not.toHaveBeenCalled();
  });

  it("links legacy owner conflicts to the lease assignments", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () =>
        HttpResponse.json({
          status: "success",
          data: { ...mockLease, desiredAssignments: undefined },
        }),
      ),
      http.patch(`${getConfig().ApiUrl}/leases/lease-123`, () =>
        HttpResponse.json(
          {
            status: "fail",
            data: {
              errors: [
                {
                  message: `Permission set ${developerPermissionSet.permissionSetArn} is still used by the legacy owner assignment.`,
                },
              ],
            },
          },
          {
            status: 409,
            headers: { "x-amzn-errortype": "ConflictError" },
          },
        ),
      ),
    );
    const user = userEvent.setup();
    renderComponent();

    expect(await screen.findByText("Default")).toBeVisible();
    await user.click(screen.getByLabelText("Add permission sets"));
    await user.click(await screen.findByText("PowerUserAccess"));
    await user.click(
      screen.getByRole("button", {
        name: "Set PowerUserAccess as default permission set",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Remove DeveloperAccess" }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(showErrorToast).toHaveBeenCalled());
    const [toastDescription, toastTitle] = vi
      .mocked(showErrorToast)
      .mock.calls.at(-1)!;
    expect(toastTitle).toBe("Update Failed");

    const { container } = renderWithQueryClient(
      <Router>
        <div>{toastDescription}</div>
      </Router>,
    );
    expect(container).toHaveTextContent(
      "is still used by the legacy owner assignment.",
    );
    expect(
      screen.getByRole("link", {
        name: "Open assignments for Developer Sandbox (12345678)",
      }),
    ).toHaveAttribute("href", "/leases/lease-123?tab=assignments");
    expect(container).toHaveTextContent(
      "update any assignment using the removed permission set, then try again.",
    );
    expect(showSuccessToast).not.toHaveBeenCalled();
  });

  it("preserves non-narrowing 409 error details", async () => {
    server.use(
      http.patch(`${getConfig().ApiUrl}/leases/lease-123`, () =>
        HttpResponse.json(
          {
            status: "fail",
            data: {
              errors: [
                { message: "The lease is locked by another operation." },
              ],
            },
          },
          {
            status: 409,
            headers: { "x-amzn-errortype": "ConflictError" },
          },
        ),
      ),
    );
    const user = userEvent.setup();
    renderComponent();

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
        expect.stringContaining("The lease is locked by another operation."),
        "Update Failed",
      );
    });
    expect(showErrorToast).not.toHaveBeenCalledWith(
      expect.stringContaining("Update assignments"),
      expect.anything(),
    );
  });

  it("allows an existing sharing setting to be turned off while sharing is globally disabled", async () => {
    let patchBody: unknown;
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () =>
        HttpResponse.json({
          status: "success",
          data: { ...mockLease, allowOwnerToShareLease: true },
        }),
      ),
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockConfig,
            leases: { ...mockConfig.leases, leaseSharingEnabled: false },
          },
        }),
      ),
      http.patch(
        `${getConfig().ApiUrl}/leases/lease-123`,
        async ({ request }) => {
          patchBody = await request.json();
          return HttpResponse.json({ status: "success", data: mockLease });
        },
      ),
    );
    const user = userEvent.setup();
    renderComponent();

    const sharingToggle = await screen.findByLabelText(
      "Allow owner to share lease",
    );
    await waitFor(() => {
      expect(sharingToggle).toBeEnabled();
      expect(sharingToggle).toBeChecked();
    });
    await user.click(sharingToggle);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(patchBody).toEqual({ allowOwnerToShareLease: false });
    });
  });

  it("cancels without updating", async () => {
    const user = userEvent.setup();
    renderComponent();

    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(mockNavigate).toHaveBeenCalledWith("/leases/lease-123");
    expect(showSuccessToast).not.toHaveBeenCalled();
  });
});
