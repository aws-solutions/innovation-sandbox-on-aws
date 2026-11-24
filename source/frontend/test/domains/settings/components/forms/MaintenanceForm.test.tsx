// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaintenanceForm as MaintenanceFormFields } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/MaintenanceForm";
import type { ConfigurationSectionView } from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import { mockAdminConfig } from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";

import { ConfigurationFormHarness } from "./ConfigurationFormHarness";

function MaintenanceForm({
  data,
}: {
  data: ConfigurationSectionView<"maintenance">;
}) {
  return (
    <ConfigurationFormHarness section="maintenance" data={data}>
      <MaintenanceFormFields />
    </ConfigurationFormHarness>
  );
}

const adminUser = {
  status: "authenticated",
  user: { type: "user", email: "a@b.com", userId: "a1", roles: ["Admin"] },
};
const managerUser = {
  status: "authenticated",
  user: { type: "user", email: "m@b.com", userId: "m1", roles: ["Manager"] },
};
const getCurrentUser = vi.fn().mockResolvedValue(adminUser);

vi.mock("@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService", () => ({
  CognitoAuthService: {
    getCurrentUser: () => getCurrentUser(),
    getIdToken: vi.fn().mockResolvedValue("mock-id-token"),
    getCredentials: vi.fn().mockResolvedValue({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-not-a-real-key",
      sessionToken: "test-session-token",
    }),
    login: vi.fn(),
    logout: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUser.mockResolvedValue(adminUser);
});

describe("MaintenanceForm", () => {
  it("renders the editable toggle and a Save button for an admin", async () => {
    render(<MaintenanceForm data={mockAdminConfig.maintenance} />, {
      wrapper: createQueryClientWrapper(),
    });

    // Waiting for Save confirms the Admin role has resolved.
    expect(
      await screen.findByRole("button", { name: /save/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });

  it.each([
    { enabled: true, lastSavedBy: null },
    { enabled: false, lastSavedBy: null },
    { enabled: true, lastSavedBy: "a@b.com" },
  ])(
    "renders maintenance state without a page-specific alert (%j)",
    async (data) => {
      render(<MaintenanceForm data={data} />, {
        wrapper: createQueryClientWrapper(),
      });

      await screen.findByRole("button", { name: /save/i });
      expect(screen.getByRole("checkbox")).toHaveProperty(
        "checked",
        data.enabled,
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("shows an inline Enabled state label when maintenance is on", async () => {
    render(
      <MaintenanceForm data={{ enabled: true, lastSavedBy: "a@b.com" }} />,
      { wrapper: createQueryClientWrapper() },
    );

    await screen.findByRole("button", { name: /save/i });
    expect(screen.getByText("Enabled")).toBeInTheDocument();
  });

  it("shows an inline Disabled state label when maintenance is off", async () => {
    render(
      <MaintenanceForm data={{ enabled: false, lastSavedBy: "a@b.com" }} />,
      { wrapper: createQueryClientWrapper() },
    );

    await screen.findByRole("button", { name: /save/i });
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("renders the maintenance toggle read-only for a manager", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(<MaintenanceForm data={mockAdminConfig.maintenance} />, {
      wrapper: createQueryClientWrapper(),
    });

    const toggle = await screen.findByRole("checkbox");
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(toggle);
    await userEvent.keyboard("[Space]");
    expect(toggle).toHaveProperty(
      "checked",
      mockAdminConfig.maintenance.enabled,
    );
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the read-only boolean as human-readable status, not raw true/false", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(
      <MaintenanceForm data={{ enabled: true, lastSavedBy: "a@b.com" }} />,
      {
        wrapper: createQueryClientWrapper(),
      },
    );

    // Wait for the read-only view itself (the "Enabled" status), not the
    // section header "Maintenance Mode" which also renders during the loading
    // state before the Manager role resolves.
    expect(await screen.findByText("Enabled")).toBeInTheDocument();
    expect(screen.queryByText("true")).not.toBeInTheDocument();
  });
});
