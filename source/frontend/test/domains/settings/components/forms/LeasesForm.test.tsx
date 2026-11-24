// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LeasesForm as LeasesFormFields } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/LeasesForm";
import type { ConfigurationSectionView } from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { mockAdminConfig } from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";
import { CONFIG_BOUNDS } from "@amzn/innovation-sandbox-shared/types/configuration.js";

import { ConfigurationFormHarness } from "./ConfigurationFormHarness";

function LeasesForm({ data }: { data: ConfigurationSectionView<"leases"> }) {
  return (
    <ConfigurationFormHarness section="leases" data={data}>
      <LeasesFormFields group="lease-policies" />
      <LeasesFormFields group="cost" />
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

describe("LeasesForm", () => {
  it("renders editable fields and a Save button for an admin", async () => {
    render(<LeasesForm data={mockAdminConfig.leases} />, {
      wrapper: createQueryClientWrapper(),
    });

    expect(await screen.findByText("Max budget")).toBeInTheDocument();
    expect(screen.getByText(/max leases per user/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  it("renders the lease controls read-only for a manager", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(<LeasesForm data={mockAdminConfig.leases} />, {
      wrapper: createQueryClientWrapper(),
    });

    const budget = await screen.findByLabelText("Max budget");
    for (const input of screen.getAllByRole("spinbutton"))
      expect(input).toHaveAttribute("readonly");
    for (const toggle of screen.getAllByRole("checkbox"))
      expect(toggle).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(budget, "99");
    expect(budget).toHaveValue(mockAdminConfig.leases.maxBudget);
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();
  });

  it("renders read-only booleans as human-readable status, not raw true/false", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(<LeasesForm data={mockAdminConfig.leases} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByText("Max budget");
    // Defaults: requireMaxBudget=true (Enabled), leaseSharingEnabled=false
    // (Disabled). Neither should render as the raw "true"/"false" string.
    expect(screen.getAllByText("Enabled").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Disabled").length).toBeGreaterThan(0);
    expect(screen.queryByText("true")).not.toBeInTheDocument();
    expect(screen.queryByText("false")).not.toBeInTheDocument();
  });

  it("bounds the max-budget input with min 0 and the schema max", async () => {
    render(<LeasesForm data={mockAdminConfig.leases} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByRole("button", { name: /save/i });

    const input = screen.getByLabelText(/^max budget$/i);
    expect(input).toHaveAttribute("min", "0");
    expect(input).toHaveAttribute("max", String(CONFIG_BOUNDS.MAX_BUDGET));
  });

  it("bounds the max-leases-per-user input with the schema minimum", async () => {
    render(<LeasesForm data={mockAdminConfig.leases} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByRole("button", { name: /save/i });

    const input = screen.getByLabelText(/max leases per user/i);
    expect(input).toHaveAttribute(
      "min",
      String(CONFIG_BOUNDS.MIN_LEASES_PER_USER),
    );
  });

  it("bounds the max-duration input with min 0 and the schema max", async () => {
    render(<LeasesForm data={mockAdminConfig.leases} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByRole("button", { name: /save/i });

    const input = screen.getByLabelText(/max lease duration/i);
    expect(input).toHaveAttribute("min", "0");
    expect(input).toHaveAttribute(
      "max",
      String(CONFIG_BOUNDS.MAX_DURATION_HOURS),
    );
  });

  it("disables Save when a typed number exceeds the field maximum (#5 caught by resolver, #6 disables Save)", async () => {
    // Use a never-saved section (lastSavedBy: null) so Save starts enabled on a
    // pristine form (the finish-setup carve-out) — this isolates the invalid-
    // field gate from the separate nothing-to-save gate, which would otherwise
    // disable Save on a pristine saved section.
    render(
      <LeasesForm data={{ ...mockAdminConfig.leases, lastSavedBy: null }} />,
      { wrapper: createQueryClientWrapper() },
    );

    const save = await screen.findByRole("button", { name: /save/i });
    expect(save).not.toHaveAttribute("aria-disabled", "true");

    // Typing a value above MAX_BUDGET is not silently clamped — the zod resolver
    // flags it (live under mode "all") and Save disables. This is the #5<->#6
    // integration: native min/max bound the arrows; typed out-of-range is caught.
    // (Cloudscape's disabledReason-disabled Save uses aria-disabled, not the
    // native disabled attribute.)
    const input = screen.getByLabelText(/^max budget$/i);
    await userEvent.clear(input);
    await userEvent.type(input, String(CONFIG_BOUNDS.MAX_BUDGET + 1));

    await waitFor(() => expect(save).toHaveAttribute("aria-disabled", "true"));
  });

  it("shows the cross-field error when the request window exceeds ttl * 24", async () => {
    render(
      <LeasesForm
        data={{ ...mockAdminConfig.leases, ttl: 1, leaseRequestWindowHours: 1 }}
      />,
      { wrapper: createQueryClientWrapper() },
    );

    await screen.findByRole("button", { name: /save/i });

    // Find the numeric input for the "Rate limit window" field (Cloudscape
    // FormField wires htmlFor to the control) and set it to 25 (> ttl 1 * 24).
    const input = screen.getByLabelText(/lease request hour period/i);
    await userEvent.clear(input);
    await userEvent.type(input, "25");

    // The cross-field rule is a client (resolver) error under mode "all", so it
    // appears live and Save disables (#6) — pin both so this test cannot pass
    // for the wrong reason if the disable-on-cross-field-error path regresses.
    await waitFor(() =>
      expect(
        screen.getByText(/must not exceed the lease ttl/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /save/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  it("renders the three predictive-budget toggles as editable controls", async () => {
    render(<LeasesForm data={mockAdminConfig.leases} />, {
      wrapper: createQueryClientWrapper(),
    });

    expect(
      await screen.findByText("Allow estimated cost tracking"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Enable service cost breakdown"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Allow Bedrock token monitoring"),
    ).toBeInTheDocument();
  });

  it("saves Allow Bedrock token monitoring as toggled", async () => {
    let putBody: any = null;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/configurations/:section`,
        async ({ request }) => {
          putBody = await request.json();
          return HttpResponse.json({
            status: "success",
            data: { ...mockAdminConfig.leases, meta: { schemaVersion: 1 } },
          });
        },
      ),
    );

    render(
      <LeasesForm
        data={{
          ...mockAdminConfig.leases,
          allowBedrockTokenMonitoring: false,
          lastSavedBy: null,
        }}
      />,
      { wrapper: createQueryClientWrapper() },
    );

    const monitoringToggle = await screen.findByRole("checkbox", {
      name: /allow bedrock token monitoring/i,
    });
    expect(monitoringToggle).not.toBeChecked();
    expect(monitoringToggle).toBeEnabled();
    expect(
      screen.getByText(
        "When enabled, lease templates may turn on Bedrock token monitoring, which prices each lease's Amazon Bedrock token usage before AWS Cost Explorer bills it. Leases with a Sandbox Space always use it to count agent spend, even when this is disabled.",
      ),
    ).toBeInTheDocument();

    await userEvent.click(monitoringToggle);
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(putBody).not.toBeNull());
    expect(putBody.allowBedrockTokenMonitoring).toBe(true);
  });

  it("saves the three predictive-budget fields through PUT /configurations/leases", async () => {
    let putBody: any = null;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/configurations/:section`,
        async ({ request }) => {
          putBody = await request.json();
          return HttpResponse.json({
            status: "success",
            data: { ...mockAdminConfig.leases, meta: { schemaVersion: 1 } },
          });
        },
      ),
    );

    render(
      <LeasesForm data={{ ...mockAdminConfig.leases, lastSavedBy: null }} />,
      { wrapper: createQueryClientWrapper() },
    );

    // Flip the predictive-controls toggle so there is a change to save.
    const toggle = await screen.findByRole("checkbox", {
      name: /allow estimated cost tracking/i,
    });
    await userEvent.click(toggle);

    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(putBody).not.toBeNull());
    // All three new field names must be present in the PUT body — a toggle
    // wired to a wrong/absent field name would fail here.
    expect(putBody).toHaveProperty("allowPredictiveBudgetControls");
    expect(putBody).toHaveProperty("serviceBreakdownEnabled");
    expect(putBody).toHaveProperty("allowBedrockTokenMonitoring");
    expect(putBody.allowPredictiveBudgetControls).toBe(true);
  });

  it("shows the cost-tracking toggle values in read-only controls", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(
      <LeasesForm
        data={{
          ...mockAdminConfig.leases,
          allowPredictiveBudgetControls: true,
          serviceBreakdownEnabled: false,
          allowBedrockTokenMonitoring: true,
        }}
      />,
      { wrapper: createQueryClientWrapper() },
    );

    for (const label of [
      "Allow estimated cost tracking",
      "Enable service cost breakdown",
      "Allow Bedrock token monitoring",
    ]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
    expect(
      screen.getByLabelText("Allow estimated cost tracking"),
    ).toBeChecked();
    expect(
      screen.getByLabelText("Allow Bedrock token monitoring"),
    ).toBeChecked();
    expect(
      screen.getByLabelText("Enable service cost breakdown"),
    ).not.toBeChecked();
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();
  });
});
