// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { LeaseService } from "@amzn/innovation-sandbox-frontend/domains/leases/service";
import { SettingsBadge } from "@amzn/innovation-sandbox-frontend/domains/settings/components/SettingsBadge";
import { AdminConfigurationView } from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import {
  AdminSettings,
  GROUP_HELP,
} from "@amzn/innovation-sandbox-frontend/domains/settings/pages/AdminSettings";
import { SETTINGS_GROUPS } from "@amzn/innovation-sandbox-frontend/domains/settings/settings-navigation";
import { SEARCHABLE_SETTINGS } from "@amzn/innovation-sandbox-frontend/domains/settings/settings-search";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createAdminConfig } from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import { ConfigSection } from "@amzn/innovation-sandbox-shared/types/configuration.js";

const role = vi.hoisted(() => ({ isAdmin: true, isLoading: false }));
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => role,
}));
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => vi.fn(),
}));
vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

const apiUrl = getConfig().ApiUrl;
let config: AdminConfigurationView;
let bodies: { section: string; body: Record<string, unknown> }[];
let savedCount: number;
const stamp = () => ({
  createdTime: "2026-04-04T10:00:00.000Z",
  lastEditTime: `2026-11-02T20:00:${String(++savedCount).padStart(2, "0")}.000Z`,
});

function mockConfigurations() {
  server.use(
    http.get(`${apiUrl}/configurations`, () =>
      HttpResponse.json({ status: "success", data: config }),
    ),
    http.get(`${apiUrl}/configurations/:section`, ({ params }) =>
      HttpResponse.json({
        status: "success",
        data: config[params.section as ConfigSection],
      }),
    ),
    http.put(
      `${apiUrl}/configurations/:section`,
      async ({ params, request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        const section = params.section as ConfigSection;
        bodies.push({ section, body });
        const { meta: _meta, ...fields } = body;
        const saved = {
          ...fields,
          meta: stamp(),
          lastSavedBy: "admin@example.com",
        };
        config = { ...config, [section]: saved };
        return HttpResponse.json({ status: "success", data: saved });
      },
    ),
    http.get(`${apiUrl}/configurations/agent/models`, () =>
      HttpResponse.json({ status: "success", data: { models: [] } }),
    ),
  );
}

function renderPage(path = "/settings", withSettingsBadge = false) {
  const router = createMemoryRouter(
    [{ path: "*", element: <AdminSettings /> }],
    { initialEntries: [path] },
  );
  renderWithQueryClient(
    <>
      {withSettingsBadge && <SettingsBadge />}
      <RouterProvider router={router} />
    </>,
  );
  return router;
}
const DEFAULT_SETTINGS_MESSAGE = "Review the values, then save these settings.";
const DEFAULT_SETTINGS_REVIEW_MESSAGE =
  "Default settings have not been saved. Review the values, then save these settings.";
const currentGroup = (label: string) =>
  screen.getByRole("region", { name: `${label} settings` });
const save = () => screen.getByRole("button", { name: "Save changes" });
const searchResult = (label: string) =>
  screen.getByRole("option", { name: (name) => name.startsWith(label) });
const chooseGroup = async (label: string) =>
  userEvent.click(
    within(
      screen.getByRole("navigation", { name: "Settings groups" }),
    ).getByRole("link", { name: label }),
  );
const replaceInput = async (label: string, value: string) => {
  const control = screen.getByRole("textbox", { name: label });
  await userEvent.clear(control);
  await userEvent.type(control, value);
};
const changeNumber = async (label: string, value: string) => {
  const control = screen.getByRole("spinbutton", { name: label });
  await userEvent.clear(control);
  if (value) await userEvent.type(control, value);
};
const modal = () => screen.getByRole("dialog");

beforeEach(() => {
  vi.clearAllMocks();
  role.isAdmin = true;
  role.isLoading = false;
  config = createAdminConfig();
  config.maintenance.enabled = false;
  bodies = [];
  savedCount = 0;
  mockConfigurations();
});
afterEach(() => {
  // Restore only this suite's spy; restoreAllMocks would remove the setup's
  // fetch interception and make subsequent requests bypass MSW.
  if (vi.isMockFunction(LeaseService.prototype.getLeases))
    vi.mocked(LeaseService.prototype.getLeases).mockRestore();
});

describe("Settings groups and roles", () => {
  it.each(SETTINGS_GROUPS)(
    "renders a focus target for every searchable field in $label",
    async (group) => {
      renderPage(`/settings#${group.id}`);
      const region = await screen.findByRole("region", {
        name: `${group.label} settings`,
      });
      for (const field of SEARCHABLE_SETTINGS.filter(
        (field) => field.group === group.id,
      )) {
        const target = document.getElementById(field.id);
        expect(target).not.toBeNull();
        expect(region).toContainElement(target);
        expect(target).toHaveAttribute("tabindex", "-1");
        expect(document.querySelectorAll(`[id="${field.id}"]`)).toHaveLength(1);
      }
    },
  );

  it("shows six deep-linkable groups, one content group and one save bar", async () => {
    renderPage();
    await screen.findByRole("region", { name: "General settings" });
    const links = within(
      screen.getByRole("navigation", { name: "Settings groups" }),
    ).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(
      SETTINGS_GROUPS.map((group) => group.label),
    );
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      SETTINGS_GROUPS.map((group) => `/settings#${group.id}`),
    );
    expect(
      screen
        .getAllByRole("region")
        .filter((region) =>
          region.getAttribute("aria-label")?.endsWith(" settings"),
        ),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Save changes" }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "Deployment settings" }),
    ).toBeInTheDocument();
    expect(save()).toHaveAttribute("aria-disabled", "true");
    expect(save()).toHaveAccessibleDescription("No changes to save.");
  });

  it("mounts form controls only in the active section and restores them on return", async () => {
    renderPage();
    await screen.findByLabelText("Terms of service content");
    expect(screen.queryByLabelText("Max budget")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No Sandbox Spaces models"),
    ).not.toBeInTheDocument();
    const originalTerms = screen.getByLabelText("Terms of service content");
    const savedTerms = (originalTerms as HTMLTextAreaElement).value;
    await chooseGroup("Lease policies");
    expect(
      screen.queryByLabelText("Terms of service content"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Max budget")).toHaveValue(50);
    await chooseGroup("General");
    expect(screen.getByLabelText("Terms of service content")).toHaveValue(
      savedTerms,
    );
    expect(screen.getByLabelText("Terms of service content")).not.toBe(
      originalTerms,
    );
  });

  it.each(SETTINGS_GROUPS)(
    "opens $label through its URL and updates help",
    async (group) => {
      renderPage(`/settings#${group.id}`);
      await screen.findByRole("region", { name: `${group.label} settings` });
      expect(
        screen.getAllByRole("button", { name: "Save changes" }),
      ).toHaveLength(1);
      expect(
        vi
          .mocked(useAppLayoutContext)
          .mock.results.some(({ value }) =>
            value.setTools.mock.calls.some(
              ([tools]: any[]) => tools.props.file === GROUP_HELP[group.id],
            ),
          ),
      ).toBe(true);
    },
  );

  it.each([true, false])(
    "shows the all-notifications-off warning only in Notifications (admin: %s)",
    async (isAdmin) => {
      role.isAdmin = isAdmin;
      config.notification.sesEnabled = false;
      config.notification.snsIntegrationTopicEnabled = false;
      renderPage();
      await screen.findByRole("region", { name: "General settings" });

      for (const group of SETTINGS_GROUPS) {
        await chooseGroup(group.label);
        const region = currentGroup(group.label);
        if (group.id === "notifications") {
          expect(
            within(region).getByText("All notifications are off"),
          ).toBeInTheDocument();
          expect(region).toHaveTextContent(
            "Users and managers won't be told about approvals, budget thresholds or expiring leases.",
          );
        } else {
          expect(
            screen.queryByText(
              /Notifications are off|All notifications are off/,
            ),
          ).not.toBeInTheDocument();
        }
      }
    },
  );

  it.each([
    { sesEnabled: true, snsIntegrationTopicEnabled: false },
    { sesEnabled: false, snsIntegrationTopicEnabled: true },
    { sesEnabled: true, snsIntegrationTopicEnabled: true },
  ])(
    "hides the notification warning when a channel is configured (%j)",
    async (channels) => {
      Object.assign(config.notification, channels, {
        emailFrom: "sender@example.com",
      });
      renderPage("/settings#notifications");
      await screen.findByRole("region", { name: "Notifications settings" });
      expect(
        screen.queryByText(/Notifications are off|All notifications are off/),
      ).not.toBeInTheDocument();
    },
  );

  it("has a help document for every group", () => {
    for (const file of Object.values(GROUP_HELP))
      expect(
        existsSync(
          join(
            process.cwd(),
            existsSync("source/frontend")
              ? "source/frontend/public/markdown"
              : "public/markdown",
            `${file}.md`,
          ),
        ),
      ).toBe(true);
  });

  it("shows deployment fields and version read-only", async () => {
    renderPage();
    expect(await screen.findByText("1.0.0-test")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: config.awsAccessPortalUrl }),
    ).toHaveAttribute("href", config.awsAccessPortalUrl);
    expect(document.getElementById("isbManagedRegions")).toHaveTextContent(
      "us-east-1",
    );
    expect(
      document.getElementById("bedrockInferenceProfilePatterns"),
    ).toHaveTextContent("global.*");
  });

  it.each([
    {
      group: "general",
      anchor: "setting-maintenance-enabled",
      label: "Maintenance mode",
    },
    {
      group: "lease-policies",
      anchor: "setting-leases-requireMaxBudget",
      label: "Require max budget",
    },
    {
      group: "lease-policies",
      anchor: "setting-leases-requireMaxDuration",
      label: "Require max duration",
    },
    {
      group: "cost",
      anchor: "setting-costReporting-requireCostReportGroup",
      label: "Require cost report group",
    },
    {
      group: "lease-policies",
      anchor: "setting-leases-allowUserLeaseTermination",
      label: "Allow users to terminate their own leases",
    },
  ])(
    "uses live Enabled/Disabled text for $label",
    async ({ group, anchor, label }) => {
      renderPage(`/settings#${group}`);
      const toggle = await screen.findByLabelText(label);
      const field = within(document.getElementById(anchor)!);
      const initiallyChecked = (toggle as HTMLInputElement).checked;
      expect(
        field.getByText(initiallyChecked ? "Enabled" : "Disabled"),
      ).toBeInTheDocument();
      await userEvent.click(toggle);
      expect(toggle).toHaveProperty("checked", !initiallyChecked);
      expect(
        field.getByText(initiallyChecked ? "Disabled" : "Enabled"),
      ).toBeInTheDocument();
      expect(
        field.queryByText(initiallyChecked ? "Enabled" : "Disabled"),
      ).not.toBeInTheDocument();
      expect(bodies).toHaveLength(0);
    },
  );

  it("dismisses the default-settings alert after saving a pristine new group", async () => {
    config = createAdminConfig({ unsaved: ["maintenance", "termsOfService"] });
    renderPage("/settings", true);
    await screen.findByLabelText("Terms of service content");
    expect(screen.getAllByText(DEFAULT_SETTINGS_MESSAGE)).toHaveLength(1);
    expect(
      screen.getByRole("img", {
        name: "General: default settings have not been saved",
      }),
    ).toBeInTheDocument();
    const navigation = screen.getByRole("navigation", {
      name: "Settings groups",
    });
    const generalLink = within(navigation).getByRole("link", {
      name: "General",
    });
    const indicator = within(navigation).getByRole("img", {
      name: "General: default settings have not been saved",
    });
    expect(generalLink.parentElement).toContainElement(indicator);
    expect(
      generalLink.compareDocumentPosition(indicator) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(indicator).not.toHaveAttribute(
      "title",
      DEFAULT_SETTINGS_REVIEW_MESSAGE,
    );
    expect(indicator).toHaveAccessibleDescription(
      DEFAULT_SETTINGS_REVIEW_MESSAGE,
    );
    const description = document.getElementById(
      indicator.getAttribute("aria-describedby")!,
    )!;
    expect(description).toHaveAttribute("hidden");
    expect(description).toHaveTextContent(DEFAULT_SETTINGS_REVIEW_MESSAGE);
    expect(
      screen.getByRole("img", { name: "1 settings page has unsaved defaults" }),
    ).toHaveTextContent("1");
    expect(
      screen.queryByText("Initial setup required"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Maintenance mode is on by default"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Maintenance mode")).toBeChecked();
    expect(save()).not.toHaveAttribute("aria-disabled", "true");
    await userEvent.hover(indicator);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      DEFAULT_SETTINGS_REVIEW_MESSAGE,
    );
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(description).toBeInTheDocument();
    await userEvent.unhover(indicator);
    await userEvent.hover(indicator);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.click(save());
    await waitFor(() =>
      expect(bodies.map((entry) => entry.section)).toEqual([
        "maintenance",
        "termsOfService",
      ]),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(DEFAULT_SETTINGS_MESSAGE),
      ).not.toBeInTheDocument(),
    );
    expect(save()).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.queryByRole("img", {
        name: "General: default settings have not been saved",
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(description).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("img", {
          name: "1 settings page has unsaved defaults",
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows the review tooltip on hover and section-link focus without an extra tab stop", async () => {
    config = createAdminConfig({ unsaved: ["maintenance"] });
    const router = renderPage();
    const indicator = await screen.findByRole("img", {
      name: "General: default settings have not been saved",
    });
    const navigation = screen.getByRole("navigation", {
      name: "Settings groups",
    });
    const generalLink = within(navigation).getByRole("link", {
      name: "General",
    });
    expect(indicator).not.toHaveAttribute("tabindex");
    expect(
      within(navigation).queryByRole("button", {
        name: /default settings have not been saved/,
      }),
    ).not.toBeInTheDocument();
    expect(indicator).not.toHaveAttribute(
      "title",
      DEFAULT_SETTINGS_REVIEW_MESSAGE,
    );
    const description = document.getElementById(
      indicator.getAttribute("aria-describedby")!,
    )!;
    expect(description).toHaveAttribute("hidden");
    expect(description).toHaveTextContent(DEFAULT_SETTINGS_REVIEW_MESSAGE);
    expect(indicator).toHaveAccessibleDescription(
      DEFAULT_SETTINGS_REVIEW_MESSAGE,
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await userEvent.hover(indicator);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      DEFAULT_SETTINGS_REVIEW_MESSAGE,
    );
    await userEvent.unhover(indicator);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    act(() => generalLink.focus());
    expect(generalLink).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      DEFAULT_SETTINGS_REVIEW_MESSAGE,
    );
    fireEvent.pointerLeave(indicator, { pointerType: "pen" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(generalLink).toHaveFocus();
    fireEvent.pointerEnter(indicator, { pointerType: "pen" });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(generalLink).toHaveFocus();
    expect(description).toBeInTheDocument();
    expect(indicator).toHaveAccessibleDescription(
      DEFAULT_SETTINGS_REVIEW_MESSAGE,
    );

    await userEvent.tab({ shift: true });
    await userEvent.tab();
    expect(generalLink).toHaveFocus();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await userEvent.tab();
    expect(
      within(navigation).getByRole("link", { name: "Lease policies" }),
    ).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(description).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings");
    expect(router.state.location.hash).toBe("");
    expect(bodies).toHaveLength(0);
  });

  it("counts both pages sharing unsaved leases and clears both indicators after saving", async () => {
    config = createAdminConfig({ unsaved: ["leases"] });
    renderPage("/settings#cost", true);
    await screen.findByRole("region", { name: "Cost settings" });
    expect(
      screen.getByRole("img", {
        name: "2 settings pages have unsaved defaults",
      }),
    ).toHaveTextContent("2");
    const navigation = screen.getByRole("navigation", {
      name: "Settings groups",
    });
    expect(
      within(navigation)
        .getAllByRole("img", { name: /default settings have not been saved/ })
        .map((indicator) => indicator.getAttribute("aria-label")),
    ).toEqual([
      "Lease policies: default settings have not been saved",
      "Cost: default settings have not been saved",
    ]);
    await userEvent.click(save());
    await waitFor(() => expect(showSuccessToast).toHaveBeenCalled());
    expect(bodies.map(({ section }) => section)).toEqual(["leases"]);
    await waitFor(() =>
      expect(
        screen.queryByRole("img", {
          name: /settings pages have unsaved defaults/,
        }),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(navigation).queryByRole("img", {
        name: /default settings have not been saved/,
      }),
    ).not.toBeInTheDocument();
  });

  it("dismisses alerts in both groups sharing leases when Cost is saved", async () => {
    config = createAdminConfig({ unsaved: ["leases", "costReporting"] });
    renderPage("/settings#cost", true);
    await screen.findByRole("region", { name: "Cost settings" });
    expect(screen.getAllByText(DEFAULT_SETTINGS_MESSAGE)).toHaveLength(1);
    expect(
      screen.getByRole("img", {
        name: "2 settings pages have unsaved defaults",
      }),
    ).toHaveTextContent("2");
    for (const label of ["Cost", "Lease policies"]) {
      expect(
        screen.getByRole("img", {
          name: `${label}: default settings have not been saved`,
        }),
      ).toBeInTheDocument();
    }
    await userEvent.click(save());
    await waitFor(() => expect(bodies).toHaveLength(2));
    await waitFor(() =>
      expect(
        screen.queryByText(DEFAULT_SETTINGS_MESSAGE),
      ).not.toBeInTheDocument(),
    );
    await chooseGroup("Lease policies");
    expect(
      screen.queryByText(DEFAULT_SETTINGS_MESSAGE),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("img", {
        name: /default settings have not been saved/,
      }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("img", {
          name: "2 settings pages have unsaved defaults",
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it.each(
    SETTINGS_GROUPS.flatMap((group) =>
      [true, false].map((isAdmin) => ({ ...group, isAdmin })),
    ),
  )(
    "shows review prompts only to admins in $label (admin: $isAdmin)",
    async (group) => {
      role.isAdmin = group.isAdmin;
      config = createAdminConfig({
        unsaved: [
          "leases",
          "cleanup",
          "notification",
          "maintenance",
          "termsOfService",
          "costReporting",
          "agent",
        ],
      });
      renderPage(`/settings#${group.id}`);
      await screen.findByRole("region", { name: `${group.label} settings` });
      expect(screen.queryAllByText(DEFAULT_SETTINGS_MESSAGE)).toHaveLength(
        group.isAdmin ? 1 : 0,
      );
      expect(
        within(currentGroup(group.label)).queryAllByText(
          "Default settings have not been saved",
        ),
      ).toHaveLength(group.isAdmin ? 1 : 0);
      expect(
        screen.queryByRole("img", { name: /unreviewed/i }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Unreviewed")).not.toBeInTheDocument();
      expect(
        screen.queryAllByRole("img", {
          name: /default settings have not been saved/,
        }),
      ).toHaveLength(group.isAdmin ? SETTINGS_GROUPS.length : 0);
      expect(
        within(screen.getByRole("navigation", { name: "Settings groups" }))
          .getAllByRole("link")
          .map((link) => link.textContent),
      ).toEqual(SETTINGS_GROUPS.map((entry) => entry.label));
    },
  );

  it.each(SETTINGS_GROUPS)(
    "does not show a default-settings alert for saved $label settings",
    async (group) => {
      renderPage(`/settings#${group.id}`);
      await screen.findByRole("region", { name: `${group.label} settings` });
      expect(
        screen.queryByText(DEFAULT_SETTINGS_MESSAGE),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("img", {
          name: `${group.label}: default settings have not been saved`,
        }),
      ).not.toBeInTheDocument();
    },
  );

  it("shows the alert only on pages that contain unsaved default sections", async () => {
    config = createAdminConfig({ unsaved: ["agent"] });
    renderPage();
    await screen.findByLabelText("Terms of service content");
    expect(
      screen.queryByText(DEFAULT_SETTINGS_MESSAGE),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("img", {
        name: /default settings have not been saved/,
      }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("img", {
        name: "Sandbox Spaces: default settings have not been saved",
      }),
    ).toBeInTheDocument();
    await chooseGroup("Sandbox Spaces");
    expect(screen.getAllByText(DEFAULT_SETTINGS_MESSAGE)).toHaveLength(1);
    await chooseGroup("General");
    expect(
      screen.queryByText(DEFAULT_SETTINGS_MESSAGE),
    ).not.toBeInTheDocument();
  });

  it("keeps the alert while editing and cancelling an unpersisted default", async () => {
    config = createAdminConfig({ unsaved: ["termsOfService"] });
    renderPage();
    await screen.findByLabelText("Terms of service content");
    expect(screen.getByText(DEFAULT_SETTINGS_MESSAGE)).toBeInTheDocument();
    await replaceInput("Terms of service content", "Draft terms");
    expect(screen.getByText(DEFAULT_SETTINGS_MESSAGE)).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "General: unsaved changes" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "General: default settings have not been saved",
      }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Discard changes" }),
    );
    expect(screen.getByText(DEFAULT_SETTINGS_MESSAGE)).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "General: default settings have not been saved",
      }),
    ).toBeInTheDocument();
    expect(bodies).toHaveLength(0);
  });

  it.each([400, 409])(
    "retains the alert when persisting defaults partially fails with %s",
    async (statusCode) => {
      config = createAdminConfig({
        unsaved: ["maintenance", "termsOfService"],
      });
      server.use(
        http.put(`${apiUrl}/configurations/termsOfService`, () =>
          HttpResponse.json(
            {
              status: "fail",
              data: {
                errors: [
                  { field: "content", message: "Could not persist defaults." },
                ],
              },
            },
            { status: statusCode },
          ),
        ),
      );
      renderPage("/settings", true);
      await screen.findByLabelText("Terms of service content");
      expect(screen.getAllByText(DEFAULT_SETTINGS_MESSAGE)).toHaveLength(1);
      expect(
        screen.getByRole("img", {
          name: "1 settings page has unsaved defaults",
        }),
      ).toHaveTextContent("1");
      await userEvent.click(save());
      if (statusCode === 409) {
        await screen.findByText("Settings changed by another administrator");
        expect(save()).toHaveAttribute("aria-disabled", "true");
      } else {
        await screen.findByText("Could not persist defaults.");
        expect(save()).not.toHaveAttribute("aria-disabled", "true");
      }
      expect(screen.getAllByText(DEFAULT_SETTINGS_MESSAGE)).toHaveLength(1);
      expect(config.maintenance.lastSavedBy).toBe("admin@example.com");
      expect(config.termsOfService.lastSavedBy).toBeNull();
      await waitFor(() =>
        expect(showErrorToast).toHaveBeenCalledWith(
          expect.stringContaining(
            "Saved: Maintenance mode. Not saved: Terms of service:",
          ),
          "Some settings were saved",
        ),
      );
      expect(showErrorToast).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(
          screen.getByRole("img", {
            name: "1 settings page has unsaved defaults",
          }),
        ).toHaveTextContent("1"),
      );
      expect(
        screen.getByRole("img", {
          name: "General: default settings have not been saved",
        }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("img", { name: "General: validation errors" }),
      ).not.toBeInTheDocument();
    },
  );

  it.each(SETTINGS_GROUPS)(
    "gives managers values and no editing actions in $label",
    async (group) => {
      role.isAdmin = false;
      renderPage(`/settings#${group.id}`);
      await screen.findByRole("region", { name: `${group.label} settings` });
      expect(
        screen.queryByRole("button", { name: "Save changes" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Cancel" }),
      ).not.toBeInTheDocument();
      const region = currentGroup(group.label);
      for (const input of region.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement
      >(
        '[id^="setting-"] input:not([type="checkbox"]):not([type="radio"]), [id^="setting-"] textarea',
      )) {
        expect(input).toHaveAttribute("readonly");
        const value = input.value;
        await userEvent.type(input, "changed");
        expect(input.value).toBe(value);
      }
      for (const toggle of within(region).queryAllByRole("checkbox")) {
        expect(toggle).toHaveAttribute("aria-disabled", "true");
        const checked = (toggle as HTMLInputElement).checked;
        await userEvent.click(toggle);
        await userEvent.keyboard("[Space]");
        expect(toggle).toHaveProperty("checked", checked);
      }
      for (const radios of within(region).queryAllByRole("radiogroup"))
        expect(radios).toHaveAttribute("aria-readonly", "true");
      expect(
        screen.queryByRole("button", { name: "Add models" }),
      ).not.toBeInTheDocument();
      if (group.id === "lease-policies")
        expect(screen.getByLabelText("Maximum lease requests")).toHaveValue(10);
      expect(bodies).toHaveLength(0);
    },
  );

  it("keeps cached settings visible after a refresh failure", async () => {
    renderPage();
    await screen.findByRole("region", { name: "General settings" });
    server.use(
      http.get(
        `${apiUrl}/configurations`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh settings" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh settings" }),
      ).toBeEnabled(),
    );
    expect(currentGroup("General")).toBeInTheDocument();
  });

  it("shows retry when the initial configuration read fails", async () => {
    server.use(
      http.get(
        `${apiUrl}/configurations`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    renderPage();
    expect(
      await screen.findByText("There was a problem loading settings."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });
});

describe("Group save, discard and navigation", () => {
  it("blocks section navigation and duplicate writes while a save is pending", async () => {
    let releaseSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    server.use(
      http.put(`${apiUrl}/configurations/leases`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push({ section: "leases", body });
        await pendingSave;
        const { meta: _meta, ...fields } = body;
        const saved = {
          ...config.leases,
          ...fields,
          lastSavedBy: "admin@example.com",
          meta: stamp(),
        };
        config = { ...config, leases: saved };
        return HttpResponse.json({ status: "success", data: saved });
      }),
    );
    const router = renderPage("/settings#lease-policies");
    await screen.findByLabelText("Max budget");
    await changeNumber("Max budget", "100");
    await userEvent.click(save());
    try {
      await waitFor(() => expect(bodies).toHaveLength(1));
      await chooseGroup("Cost");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(currentGroup("Lease policies")).toBeInTheDocument();
      expect(router.state.location.hash).toBe("#lease-policies");
      await userEvent.click(save());
      expect(bodies).toHaveLength(1);
    } finally {
      releaseSave();
    }
    await waitFor(() =>
      expect(showSuccessToast).toHaveBeenCalledWith("Settings saved."),
    );
    expect(bodies).toHaveLength(1);
    expect(
      screen.queryByText("Settings changed by another administrator"),
    ).not.toBeInTheDocument();
    await chooseGroup("Cost");
    expect(currentGroup("Cost")).toBeInTheDocument();
  });

  it("saves and discards changes made only to the rate-limit period", async () => {
    renderPage("/settings#lease-policies");
    await screen.findByLabelText("Lease request hour period");
    await changeNumber("Lease request hour period", "200");
    await waitFor(() =>
      expect(save()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await userEvent.click(save());
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      section: "leases",
      body: {
        leaseRequestWindowHours: 200,
        maxLeaseRequestsPerWindow: 10,
      },
    });
    await waitFor(() =>
      expect(save()).toHaveAttribute("aria-disabled", "true"),
    );
    await changeNumber("Lease request hour period", "201");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Lease request hour period")).toHaveValue(
        200,
      ),
    );
    expect(save()).toHaveAttribute("aria-disabled", "true");
    expect(bodies).toHaveLength(1);
  });

  it("saves the changed General sections with concurrency tokens without a navigation status", async () => {
    renderPage();
    await screen.findByLabelText("Terms of service content");
    await replaceInput("Terms of service content", "New terms");
    const navigation = screen.getByRole("navigation", {
      name: "Settings groups",
    });
    expect(within(navigation).queryByRole("img")).not.toBeInTheDocument();
    await userEvent.click(save());
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      section: "termsOfService",
      body: {
        content: "New terms",
        meta: { lastEditTime: "2026-04-04T12:30:00.000Z" },
      },
    });
    await waitFor(() =>
      expect(save()).toHaveAttribute("aria-disabled", "true"),
    );
    expect(
      screen.queryByRole("img", { name: "General: unsaved changes" }),
    ).not.toBeInTheDocument();
    expect(showSuccessToast).toHaveBeenCalledTimes(1);
  });

  it("confirms Cancel and restores only the group’s saved values", async () => {
    renderPage("/settings#lease-policies");
    await screen.findByLabelText("Max budget");
    await changeNumber("Max budget", "100");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(modal()).toHaveTextContent("Discard unsaved changes?");
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Keep editing" }),
    );
    expect(screen.getByLabelText("Max budget")).toHaveValue(100);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Max budget")).toHaveValue(50),
    );
    expect(save()).toHaveAttribute("aria-disabled", "true");
    expect(bodies).toHaveLength(0);
  });

  it("offers keep editing, discard, and save before switching groups", async () => {
    renderPage("/settings#lease-policies");
    await screen.findByLabelText("Max budget");
    await changeNumber("Max budget", "100");
    await chooseGroup("Cost");
    expect(modal()).toHaveTextContent("Unsaved changes");
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Keep editing" }),
    );
    expect(currentGroup("Lease policies")).toBeInTheDocument();
    expect(screen.getByLabelText("Max budget")).toHaveValue(100);
    await chooseGroup("Cost");
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Save changes" }),
    );
    await screen.findByRole("region", { name: "Cost settings" });
    expect(bodies[0].body.maxBudget).toBe(100);
    await chooseGroup("Lease policies");
    await changeNumber("Max budget", "200");
    await chooseGroup("Cost");
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Discard changes" }),
    );
    await screen.findByRole("region", { name: "Cost settings" });
    await chooseGroup("Lease policies");
    expect(screen.getByLabelText("Max budget")).toHaveValue(100);
  });

  it("guards browser history/hash changes with edits", async () => {
    const router = renderPage("/settings#lease-policies");
    await screen.findByLabelText("Max budget");
    await changeNumber("Max budget", "100");
    await act(() => router.navigate("/settings#notifications"));
    expect(modal()).toHaveTextContent("Unsaved changes");
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Keep editing" }),
    );
    expect(router.state.location.hash).toBe("#lease-policies");
    expect(screen.getByLabelText("Max budget")).toHaveValue(100);
  });

  it("saves Cost without changing other lease settings and advances its shared section token", async () => {
    renderPage("/settings#cost");
    await screen.findByLabelText("Enable service cost breakdown");
    await userEvent.click(
      screen.getByLabelText("Enable service cost breakdown"),
    );
    await userEvent.click(save());
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].body).toMatchObject({
      maxBudget: 50,
      serviceBreakdownEnabled: true,
      meta: { lastEditTime: "2026-04-04T12:30:00.000Z" },
    });
    await waitFor(() =>
      expect(save()).toHaveAttribute("aria-disabled", "true"),
    );
    await chooseGroup("Lease policies");
    await changeNumber("Max budget", "200");
    await userEvent.click(save());
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].body).toMatchObject({
      serviceBreakdownEnabled: true,
      maxBudget: 200,
      meta: { lastEditTime: "2026-11-02T20:00:01.000Z" },
    });
  });

  it("does not report a multi-section save as complete when the second PUT fails", async () => {
    config.costReporting.costReportGroups = ["engineering"];
    server.use(
      http.put(
        `${apiUrl}/configurations/costReporting`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    renderPage("/settings#cost");
    await screen.findByLabelText("Enable service cost breakdown");
    await userEvent.click(
      screen.getByLabelText("Enable service cost breakdown"),
    );
    await userEvent.click(screen.getByLabelText("Require cost report group"));
    await userEvent.click(save());
    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.stringContaining(
          "Saved: Cost monitoring. Not saved: Cost report groups:",
        ),
        "Some settings were saved",
      ),
    );
    expect(showErrorToast).toHaveBeenCalledTimes(1);
    expect(bodies.map((entry) => entry.section)).toEqual(["leases"]);
    expect(showSuccessToast).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("img", { name: "Cost: unsaved changes" }),
    ).not.toBeInTheDocument();
    server.use(
      http.put(
        `${apiUrl}/configurations/costReporting`,
        async ({ request }) => {
          bodies.push({
            section: "costReporting",
            body: (await request.json()) as Record<string, unknown>,
          });
          return HttpResponse.json({
            status: "success",
            data: {
              ...config.costReporting,
              requireCostReportGroup: true,
              meta: stamp(),
            },
          });
        },
      ),
    );
    await userEvent.click(save());
    await waitFor(() => expect(showSuccessToast).toHaveBeenCalledTimes(1));
    expect(bodies.map((entry) => entry.section)).toEqual([
      "leases",
      "costReporting",
    ]);
  });

  it("reports a failed save without claiming an unchanged section was saved", async () => {
    server.use(
      http.put(
        `${apiUrl}/configurations/termsOfService`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    renderPage("/settings#general");
    await screen.findByLabelText("Terms of service content");
    await replaceInput("Terms of service content", "Updated terms");
    await userEvent.click(save());
    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Not saved: Terms of service:"),
        "Settings not saved",
      ),
    );
    expect(showErrorToast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(showErrorToast).mock.calls[0][0]).not.toContain(
      "Maintenance mode",
    );
    expect(bodies).toHaveLength(0);
    expect(screen.getByLabelText("Terms of service content")).toHaveValue(
      "Updated terms",
    );
  });

  it("reports both sections when every write fails", async () => {
    config.costReporting.costReportGroups = ["engineering"];
    server.use(
      http.put(
        `${apiUrl}/configurations/leases`,
        () => new HttpResponse(null, { status: 500 }),
      ),
      http.put(
        `${apiUrl}/configurations/costReporting`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    renderPage("/settings#cost");
    await screen.findByLabelText("Enable service cost breakdown");
    await userEvent.click(
      screen.getByLabelText("Enable service cost breakdown"),
    );
    await userEvent.click(screen.getByLabelText("Require cost report group"));
    await userEvent.click(save());
    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Not saved: Cost monitoring:"),
        "Settings not saved",
      ),
    );
    expect(showErrorToast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(showErrorToast).mock.calls[0][0]).toContain(
      "Cost report groups:",
    );
    expect(showSuccessToast).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(0);
  });
});

describe("Validation, constraints and conflicts", () => {
  it("clears a rate-limit error when increasing retention makes the window valid", async () => {
    renderPage("/settings#lease-policies");
    const period = await screen.findByLabelText("Lease request hour period");
    await changeNumber("Lease request hour period", "721");
    await waitFor(() => expect(period).toHaveAttribute("aria-invalid", "true"));
    expect(save()).toHaveAttribute("aria-disabled", "true");
    await changeNumber("Lease record retention (days)", "31");
    await waitFor(() =>
      expect(period).not.toHaveAttribute("aria-invalid", "true"),
    );
    expect(save()).not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(save());
    await waitFor(() =>
      expect(bodies[0].body).toMatchObject({
        ttl: 31,
        leaseRequestWindowHours: 721,
      }),
    );
  });

  it("explains a stored lease validation failure when saving Cost", async () => {
    config.leases.ttl = 1;
    config.leases.leaseRequestWindowHours = 25;
    renderPage("/settings#cost");
    await screen.findByLabelText("Enable service cost breakdown");
    await userEvent.click(
      screen.getByLabelText("Enable service cost breakdown"),
    );
    await userEvent.click(save());
    expect(
      await screen.findByText(
        /Rate limit window \(hours\) must not exceed the lease TTL/,
      ),
    ).toBeInTheDocument();
    expect(save()).toHaveAttribute("aria-disabled", "true");
    expect(bodies).toHaveLength(0);
  });

  it("uses an enum-backed toggle for group assignments, and renames estimated cost tracking", async () => {
    renderPage("/settings#lease-policies");
    await screen.findByLabelText("Allow group assignments");
    expect(screen.getByLabelText("Allow group assignments")).not.toBeChecked();
    await userEvent.click(screen.getByLabelText("Allow group assignments"));
    await userEvent.click(
      screen.getByLabelText("Allow estimated cost tracking"),
    );
    await userEvent.click(save());
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].body).toMatchObject({
      groupAssignmentMode: "ALL",
      allowPredictiveBudgetControls: true,
    });
  });

  it("stores NONE when turning off the enum-backed group assignment toggle", async () => {
    config.leases.groupAssignmentMode = "ALL";
    renderPage("/settings#lease-policies");
    const toggle = await screen.findByLabelText("Allow group assignments");
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    await userEvent.click(save());
    await waitFor(() =>
      expect(bodies[0].body.groupAssignmentMode).toBe("NONE"),
    );
  });

  it.each([
    { groupAssignments: "NONE", spaces: false, status: "Disabled" },
    { groupAssignments: "ALL", spaces: true, status: "Enabled" },
  ] as const)(
    "shows $status for enum-backed read-only toggles and compound rate-limit inputs",
    async ({ groupAssignments, spaces, status }) => {
      role.isAdmin = false;
      config.leases.groupAssignmentMode = groupAssignments;
      config.agent.sandboxSpacesEnabled = spaces;
      config.leases.maxLeaseRequestsPerWindow = 7;
      config.leases.leaseRequestWindowHours = 24;
      renderPage("/settings#lease-policies");
      await screen.findByRole("region", { name: "Lease policies settings" });
      expect(
        within(
          document.getElementById("setting-leases-groupAssignmentMode")!,
        ).getByText(status),
      ).toBeInTheDocument();
      const requests = screen.getByLabelText("Maximum lease requests");
      const period = screen.getByLabelText("Lease request hour period");
      expect(requests).toHaveValue(7);
      expect(period).toHaveValue(24);
      expect(requests).toHaveAttribute("readonly");
      expect(period).toHaveAttribute("readonly");
      const groupToggle = screen.getByLabelText("Allow group assignments");
      expect(groupToggle).toHaveAttribute("aria-disabled", "true");
      expect(groupToggle).toHaveProperty("checked", groupAssignments === "ALL");
      await chooseGroup("Sandbox Spaces");
      expect(
        within(
          document.getElementById("setting-agent-sandboxSpacesEnabled")!,
        ).getByText(status),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "Allow Bedrock token monitoring" }),
      ).toHaveAttribute(
        "href",
        "/settings#setting-leases-allowBedrockTokenMonitoring",
      );
      const spacesToggle = screen.getByLabelText("Enable Sandbox Spaces");
      expect(spacesToggle).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(spacesToggle);
      expect(spacesToggle).toHaveProperty("checked", spaces);
      expect(bodies).toHaveLength(0);
    },
  );

  it("shows budget bounds and inline errors and blocks Save without a navigation error icon", async () => {
    renderPage("/settings#lease-policies");
    await screen.findByLabelText("Max budget");
    expect(currentGroup("Lease policies")).toHaveTextContent(
      "0 to 1,000,000,000",
    );
    await changeNumber("Max budget", "-1");
    await waitFor(() =>
      expect(save()).toHaveAttribute("aria-disabled", "true"),
    );
    const navigation = screen.getByRole("navigation", {
      name: "Settings groups",
    });
    expect(within(navigation).queryByRole("img")).not.toBeInTheDocument();
    expect(currentGroup("Lease policies")).toHaveTextContent(/Too small/);
    expect(save()).toHaveAccessibleDescription(
      "Fix validation errors before saving.",
    );
    const footer = screen.getByRole("region", {
      name: "Lease policies save bar",
    });
    expect(within(footer).getByRole("status")).toHaveTextContent(
      "Fix validation errors before saving.",
    );
    expect(within(footer).queryByRole("alert")).not.toBeInTheDocument();
    expect(
      within(footer).getByRole("region", {
        name: "Lease policies last edited",
      }),
    ).toBeInTheDocument();
    await changeNumber("Max budget", "100");
    await waitFor(() =>
      expect(save()).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(within(footer).queryByRole("status")).not.toBeInTheDocument();
  });

  it("presents rate limits as a sentence and validates both inputs against retention", async () => {
    renderPage("/settings#lease-policies");
    await screen.findByLabelText("Maximum lease requests");
    expect(screen.getByLabelText("Maximum lease requests")).toHaveValue(10);
    expect(screen.getByLabelText("Lease request hour period")).toHaveValue(168);
    expect(currentGroup("Lease policies")).toHaveTextContent(
      "Maximum period: 720 hours, based on lease record retention of 30 days.",
    );
    await changeNumber("Lease record retention (days)", "60");
    expect(currentGroup("Lease policies")).toHaveTextContent(
      "Maximum period: 1,440 hours, based on lease record retention of 60 days.",
    );
    await changeNumber("Lease record retention (days)", "30");
    await changeNumber("Lease request hour period", "721");
    expect(
      await screen.findByText(
        /Rate limit window \(hours\) must not exceed the lease TTL/,
      ),
    ).toBeInTheDocument();
    expect(save()).toHaveAttribute("aria-disabled", "true");
    await changeNumber("Lease request hour period", "1");
    await changeNumber("Maximum lease requests", "0");
    await waitFor(() =>
      expect(save()).toHaveAttribute("aria-disabled", "true"),
    );
    await changeNumber("Maximum lease requests", "12345678");
    await userEvent.click(save());
    await waitFor(() =>
      expect(bodies[0].body).toMatchObject({
        leaseRequestWindowHours: 1,
        maxLeaseRequestsPerWindow: 12345678,
      }),
    );
  });

  it("keeps cooldown advice advisory and only shows it for Warn or Quarantine below 168 hours", async () => {
    renderPage("/settings#account-cleanup");
    await screen.findByLabelText("Account cooldown (hours)");
    expect(
      screen.queryByText(
        /When choosing Warn or Quarantine, set the account cooldown to at least 168 hours/,
      ),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /Warn/ }));
    expect(
      screen.getByText(
        /When choosing Warn or Quarantine, set the account cooldown to at least 168 hours/,
      ),
    ).toBeInTheDocument();
    expect(save()).not.toHaveAttribute("aria-disabled", "true");
    await changeNumber("Account cooldown (hours)", "168");
    expect(
      screen.queryByText(
        /When choosing Warn or Quarantine, set the account cooldown to at least 168 hours/,
      ),
    ).not.toBeInTheDocument();
    await changeNumber("Account cooldown (hours)", "24");
    await userEvent.click(save());
    await waitFor(() =>
      expect(bodies[0].body.validation).toEqual({ failureAction: "Warn" }),
    );
    await waitFor(() =>
      expect(save()).toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("keeps the sender editable while SES is off and enforces its email and character limits", async () => {
    renderPage("/settings#notifications");
    await screen.findByLabelText("Email from address (SES)");
    await userEvent.click(screen.getByLabelText("Email notifications (SES)"));
    expect(screen.getByLabelText("Email from address (SES)")).toBeEnabled();
    expect(currentGroup("Notifications")).toHaveTextContent(
      "Not used while SES is off.",
    );
    expect(currentGroup("Notifications")).toHaveTextContent(
      "Maximum 254 characters",
    );
    await replaceInput("Email from address (SES)", "invalid");
    await waitFor(() =>
      expect(save()).toHaveAttribute("aria-disabled", "true"),
    );
    await replaceInput("Email from address (SES)", "sender@example.com");
    await userEvent.click(save());
    await waitFor(() =>
      expect(bodies[0].body).toMatchObject({
        sesEnabled: false,
        emailFrom: "sender@example.com",
      }),
    );
  });

  it("shows live terms and group counters", async () => {
    renderPage();
    await screen.findByLabelText("Terms of service content");
    await replaceInput("Terms of service content", "Terms");
    expect(screen.getByText("5 / 10000 characters")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Discard changes" }),
    );
    await chooseGroup("Cost");
    expect(screen.getByText("0 / 250 groups")).toBeInTheDocument();
    expect(screen.getByText("0 / 50 characters")).toBeInTheDocument();
  });

  it("names the concurrent editor, preserves edits and blocks saves until explicit reload", async () => {
    server.use(
      http.put(`${apiUrl}/configurations/leases`, () =>
        HttpResponse.json({ status: "fail", data: {} }, { status: 409 }),
      ),
    );
    renderPage("/settings#lease-policies");
    await screen.findByLabelText("Max budget");
    await changeNumber("Max budget", "100");
    config = {
      ...config,
      leases: {
        ...config.leases,
        maxBudget: 80,
        lastSavedBy: "other-admin@example.com",
        meta: stamp(),
      },
    };
    await userEvent.click(save());
    expect(
      await screen.findByText(/other-admin@example.com saved these settings/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Max budget")).toHaveValue(100);
    expect(save()).toHaveAttribute("aria-disabled", "true");
    expect(
      within(
        screen.getByRole("region", { name: "Lease policies save bar" }),
      ).getByRole("status"),
    ).toHaveTextContent("Reload latest values before saving.");
    await userEvent.click(
      screen.getByRole("button", { name: "Reload latest values" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Max budget")).toHaveValue(80),
    );
    expect(
      screen.queryByText("Settings changed by another administrator"),
    ).not.toBeInTheDocument();
    expect(save()).toHaveAttribute("aria-disabled", "true");
    await changeNumber("Max budget", "90");
    expect(save()).not.toHaveAttribute("aria-disabled", "true");
  });

  it.each([
    {
      group: "lease-policies",
      label: "Lease policies",
      otherLabel: "Cost",
      field: "Max budget",
    },
    {
      group: "cost",
      label: "Cost",
      otherLabel: "Lease policies",
      field: "Enable service cost breakdown",
    },
  ])(
    "requires discarding the $label draft before reloading the shared leases section from $otherLabel",
    async ({ group, label, otherLabel, field }) => {
      server.use(
        http.put(`${apiUrl}/configurations/leases`, () =>
          HttpResponse.json({ status: "fail", data: {} }, { status: 409 }),
        ),
      );
      renderPage(`/settings#${group}`);
      await screen.findByLabelText(field);
      if (group === "lease-policies") await changeNumber(field, "100");
      else await userEvent.click(screen.getByLabelText(field));
      await userEvent.click(save());
      await screen.findByText("Settings changed by another administrator");
      await chooseGroup(otherLabel);
      expect(currentGroup(label)).toBeInTheDocument();
      expect(
        within(modal()).getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
      await userEvent.click(
        within(modal()).getByRole("button", { name: "Keep editing" }),
      );
      if (group === "lease-policies")
        expect(screen.getByLabelText(field)).toHaveValue(100);
      else expect(screen.getByLabelText(field)).toBeChecked();
      await chooseGroup(otherLabel);
      await userEvent.click(
        within(modal()).getByRole("button", { name: "Discard changes" }),
      );
      await screen.findByRole("region", { name: `${otherLabel} settings` });
      await userEvent.click(
        screen.getByRole("button", { name: "Reload latest values" }),
      );
      await waitFor(() =>
        expect(
          screen.queryByText("Settings changed by another administrator"),
        ).not.toBeInTheDocument(),
      );
      await chooseGroup(label);
      if (group === "lease-policies")
        expect(screen.getByLabelText(field)).toHaveValue(50);
      else expect(screen.getByLabelText(field)).not.toBeChecked();
    },
  );

  it("retains the conflict and the draft if reload fails", async () => {
    server.use(
      http.put(`${apiUrl}/configurations/leases`, () =>
        HttpResponse.json({ status: "fail", data: {} }, { status: 409 }),
      ),
    );
    renderPage("/settings#lease-policies");
    await screen.findByLabelText("Max budget");
    await changeNumber("Max budget", "100");
    await userEvent.click(save());
    await screen.findByText("Settings changed by another administrator");
    server.use(
      http.get(
        `${apiUrl}/configurations/leases`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reload latest values" }),
    );
    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.any(String),
        "Reload failed",
      ),
    );
    expect(screen.getByLabelText("Max budget")).toHaveValue(100);
    expect(save()).toHaveAttribute("aria-disabled", "true");
  });

  it("blocks page actions during reload and resumes deferred history navigation afterward", async () => {
    server.use(
      http.put(`${apiUrl}/configurations/leases`, () =>
        HttpResponse.json({ status: "fail", data: {} }, { status: 409 }),
      ),
    );
    const router = renderPage("/settings#lease-policies");
    await screen.findByLabelText("Max budget");
    await changeNumber("Max budget", "100");
    await userEvent.click(save());
    await screen.findByText("Settings changed by another administrator");

    let releaseReload!: () => void;
    const pendingReload = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    let reloadStarted = false;
    server.use(
      http.get(`${apiUrl}/configurations/leases`, async () => {
        reloadStarted = true;
        await pendingReload;
        return HttpResponse.json({
          status: "success",
          data: { ...config.leases, maxBudget: 80, meta: stamp() },
        });
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reload latest values" }),
    );
    try {
      await waitFor(() => expect(reloadStarted).toBe(true));
      await chooseGroup("Cost");
      expect(currentGroup("Lease policies")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Reload latest values" }),
      ).toBeDisabled();
      await act(() => router.navigate("/settings#cost"));
      expect(currentGroup("Lease policies")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
      releaseReload();
    }
    await screen.findByRole("region", { name: "Cost settings" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await chooseGroup("Lease policies");
    expect(screen.getByLabelText("Max budget")).toHaveValue(80);
  });

  it("maps a server validation error onto its field", async () => {
    server.use(
      http.put(`${apiUrl}/configurations/notification`, () =>
        HttpResponse.json(
          {
            status: "fail",
            data: {
              errors: [
                { field: "emailFrom", message: "Sender is not verified." },
              ],
            },
          },
          { status: 400 },
        ),
      ),
    );
    renderPage("/settings#notifications");
    await screen.findByLabelText("Email from address (SES)");
    await replaceInput("Email from address (SES)", "sender@example.com");
    await userEvent.click(save());
    expect(
      await screen.findByText("Sender is not verified."),
    ).toBeInTheDocument();
    expect(save()).not.toHaveAttribute("aria-disabled", "true");
  });

  it("retries a temporary SES failure without editing the sender or advancing the concurrency token", async () => {
    const message =
      "Unable to verify this email against SES. Please try again shortly.";
    const requests: Record<string, unknown>[] = [];
    let sesUnavailable = true;
    server.use(
      http.put(`${apiUrl}/configurations/notification`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        requests.push(body);
        if (sesUnavailable)
          return HttpResponse.json(
            {
              status: "fail",
              data: { errors: [{ field: "emailFrom", message }] },
            },
            { status: 400 },
          );
        const saved = {
          ...config.notification,
          ...body,
          meta: stamp(),
          lastSavedBy: "admin@example.com",
        };
        config = { ...config, notification: saved };
        return HttpResponse.json({ status: "success", data: saved });
      }),
    );
    renderPage("/settings#notifications");
    await screen.findByLabelText("Email from address (SES)");
    await replaceInput("Email from address (SES)", "sender@example.com");
    await userEvent.click(save());
    await screen.findByText(message);
    expect(showSuccessToast).not.toHaveBeenCalled();
    expect(save()).not.toHaveAttribute("aria-disabled", "true");

    sesUnavailable = false;
    await userEvent.click(save());
    await waitFor(() => expect(showSuccessToast).toHaveBeenCalledTimes(1));
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[1]).toMatchObject({
      emailFrom: "sender@example.com",
      meta: { lastEditTime: "2026-04-04T12:30:00.000Z" },
    });
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(save()).toHaveAttribute("aria-disabled", "true");
  });
});

describe("Sensitive save confirmations", () => {
  it.each(["Keep editing", "Save changes"])(
    "defers browser history navigation until sensitive confirmation resolves with %s",
    async (action) => {
      config.costReporting.lastSavedBy = null;
      const router = renderPage("/settings#cost");
      await screen.findByLabelText("Require cost report group");
      await chooseGroup("General");
      await userEvent.click(screen.getByLabelText("Maintenance mode"));
      await userEvent.click(save());
      await screen.findByRole("dialog", { name: "Confirm settings changes" });

      await act(() => router.navigate(-1));
      expect(router.state.location.hash).toBe("#cost");
      expect(currentGroup("General")).toBeInTheDocument();
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(modal()).toHaveAccessibleName("Confirm settings changes");
      expect(bodies).toHaveLength(0);

      await userEvent.click(
        within(modal()).getByRole("button", { name: action }),
      );
      if (action === "Keep editing") {
        await screen.findByRole("dialog", { name: "Unsaved changes" });
        await userEvent.click(
          within(modal()).getByRole("button", { name: "Discard changes" }),
        );
        expect(bodies).toHaveLength(0);
      } else {
        await waitFor(() =>
          expect(bodies).toEqual([
            {
              section: "maintenance",
              body: {
                enabled: true,
                meta: { lastEditTime: "2026-04-04T12:30:00.000Z" },
              },
            },
          ]),
        );
      }
      await screen.findByRole("region", { name: "Cost settings" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(config.costReporting.lastSavedBy).toBeNull();
    },
  );

  it("replaces the switch prompt with a sensitive confirmation and can keep editing", async () => {
    renderPage();
    await screen.findByLabelText("Maintenance mode");
    await userEvent.click(screen.getByLabelText("Maintenance mode"));
    await chooseGroup("Notifications");
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Save changes" }),
    );
    await screen.findByRole("dialog", { name: "Confirm settings changes" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Keep editing" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(currentGroup("General")).toBeInTheDocument();
    expect(screen.getByLabelText("Maintenance mode")).toBeChecked();
    expect(bodies).toHaveLength(0);
    await chooseGroup("Notifications");
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Save changes" }),
    );
    await screen.findByRole("dialog", { name: "Confirm settings changes" });
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Save changes" }),
    );
    await screen.findByRole("region", { name: "Notifications settings" });
    expect(bodies[0]).toMatchObject({
      section: "maintenance",
      body: { enabled: true },
    });
  });

  it("confirms maintenance lockout and admin access before saving", async () => {
    renderPage();
    await screen.findByLabelText("Maintenance mode");
    await userEvent.click(screen.getByLabelText("Maintenance mode"));
    await userEvent.click(save());
    expect(modal()).toHaveTextContent("locks managers and users out");
    expect(modal()).toHaveTextContent("Admins keep full access");
    expect(bodies).toHaveLength(0);
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() => expect(bodies[0].body.enabled).toBe(true));
  });

  it("saves maintenance off without a confirmation and disables unchanged re-saves", async () => {
    config.maintenance.enabled = true;
    renderPage();
    await screen.findByLabelText("Maintenance mode");
    await userEvent.click(screen.getByLabelText("Maintenance mode"));
    await userEvent.click(save());
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      section: "maintenance",
      body: { enabled: false },
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(save()).toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("retains the draft and shows a conflict when a confirmed maintenance save is rejected", async () => {
    server.use(
      http.put(`${apiUrl}/configurations/maintenance`, () =>
        HttpResponse.json({ status: "fail", data: {} }, { status: 409 }),
      ),
    );
    renderPage();
    await screen.findByLabelText("Maintenance mode");
    await userEvent.click(screen.getByLabelText("Maintenance mode"));
    await userEvent.click(save());
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Save changes" }),
    );
    await screen.findByText("Settings changed by another administrator");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Maintenance mode")).toBeChecked();
    expect(save()).toHaveAttribute("aria-disabled", "true");
    expect(showSuccessToast).not.toHaveBeenCalled();
  });

  it("names removed cost report groups and preserves existing-template and lease semantics", async () => {
    config.costReporting.costReportGroups = ["engineering", "research"];
    renderPage("/settings#cost");
    await screen.findByRole("button", { name: "Remove engineering" });
    await userEvent.click(
      screen.getByRole("button", { name: "Remove engineering" }),
    );
    await userEvent.click(save());
    expect(modal()).toHaveTextContent("engineering");
    expect(modal()).toHaveTextContent(
      "Existing templates and leases keep these groups",
    );
    expect(bodies).toHaveLength(0);
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() =>
      expect(bodies[0].body.costReportGroups).toEqual(["research"]),
    );
  });

  it("does not confirm additions alone", async () => {
    renderPage("/settings#cost");
    await screen.findByPlaceholderText("Add a group");
    await userEvent.type(
      screen.getByPlaceholderText("Add a group"),
      "new-group",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.click(save());
    await waitFor(() =>
      expect(bodies[0].body.costReportGroups).toEqual(["new-group"]),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("confirms disabling Spaces without fetching leases and explains that running tasks are not cancelled", async () => {
    config.agent.sandboxSpacesEnabled = true;
    const getLeases = vi
      .spyOn(LeaseService.prototype, "getLeases")
      .mockResolvedValue([]);
    renderPage("/settings#sandbox-spaces");
    await screen.findByLabelText("Enable Sandbox Spaces");
    await userEvent.click(screen.getByLabelText("Enable Sandbox Spaces"));
    await userEvent.click(save());
    await screen.findByRole("dialog");
    expect(getLeases).not.toHaveBeenCalled();
    expect(modal()).toHaveTextContent(
      "Turning this off prevents new agent turns.",
    );
    expect(modal()).toHaveTextContent(
      "Tasks already running are not cancelled and may continue making AWS calls while their leases remain active.",
    );
    expect(bodies).toHaveLength(0);
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() =>
      expect(bodies[0]).toMatchObject({
        section: "agent",
        body: { sandboxSpacesEnabled: false },
      }),
    );
    expect(config.leases.allowBedrockTokenMonitoring).toBe(false);
  });

  it("allows disabling Spaces when lease listing is unavailable", async () => {
    config.agent.sandboxSpacesEnabled = true;
    const getLeases = vi
      .spyOn(LeaseService.prototype, "getLeases")
      .mockRejectedValue(new Error("Read failed"));
    renderPage("/settings#sandbox-spaces");
    await screen.findByLabelText("Enable Sandbox Spaces");
    await userEvent.click(screen.getByLabelText("Enable Sandbox Spaces"));
    await userEvent.click(save());
    await screen.findByRole("dialog");
    expect(getLeases).not.toHaveBeenCalled();
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() =>
      expect(bodies[0]).toMatchObject({
        section: "agent",
        body: { sandboxSpacesEnabled: false },
      }),
    );
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it("keeps global token monitoring independent when enabling Spaces", async () => {
    renderPage("/settings#sandbox-spaces");
    await screen.findByLabelText("Enable Sandbox Spaces");
    await userEvent.click(screen.getByLabelText("Enable Sandbox Spaces"));
    await userEvent.click(save());
    await waitFor(() =>
      expect(bodies.map((entry) => entry.section)).toEqual(["agent"]),
    );
    expect(bodies[0].body.sandboxSpacesEnabled).toBe(true);
    expect(config.leases.allowBedrockTokenMonitoring).toBe(false);
  });
});

describe("Model catalog group drafts", () => {
  const row = () => ({
    modelId: "anthropic.claude-3-haiku-20240307-v1:0",
    displayName: "Claude 3 Haiku",
    provider: "Anthropic",
    availability: "global",
    pricingSource: "agreement-offers",
    inputPricePer1KTokens: 0.001,
    outputPricePer1KTokens: 0.005,
    enabled: true,
    addedAt: "2026-09-01T12:00:00.000Z",
    lastSavedBy: "admin@example.com",
    meta: {
      createdTime: "2026-09-01T12:00:00.000Z",
      lastEditTime: "2026-09-01T12:00:00.000Z",
    },
  });
  async function stageDisable() {
    const checkboxes = within(currentGroup("Sandbox Spaces")).getAllByRole(
      "checkbox",
    );
    await userEvent.click(checkboxes.at(-1)!);
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Disable" }),
    );
    await screen.findByText(
      /1 model will be disabled when you save this group/,
    );
  }

  it.each([
    { isAdmin: true, label: "administrator" },
    { isAdmin: false, label: "manager" },
  ])(
    "loads the catalog only after the $label first visits Sandbox Spaces",
    async ({ isAdmin }) => {
      role.isAdmin = isAdmin;
      let reads = 0;
      server.use(
        http.get(`${apiUrl}/configurations/agent/models`, () => {
          reads++;
          return HttpResponse.json({
            status: "success",
            data: { models: [row()] },
          });
        }),
      );
      renderPage();
      await screen.findByRole("region", { name: "General settings" });
      await chooseGroup("Cost");
      expect(currentGroup("Cost")).toBeInTheDocument();
      expect(reads).toBe(0);
      await chooseGroup("Sandbox Spaces");
      await screen.findByText("Claude 3 Haiku");
      expect(reads).toBe(1);
      await chooseGroup("General");
      await chooseGroup("Sandbox Spaces");
      expect(screen.getByText("Claude 3 Haiku")).toBeInTheDocument();
      expect(reads).toBe(1);
    },
  );

  it("preserves staged model disables when refreshing the catalog", async () => {
    let models = [
      row(),
      { ...row(), modelId: "amazon.nova-pro-v1:0", displayName: "Nova Pro" },
    ];
    let reads = 0;
    const modelWrites: Record<string, unknown>[] = [];
    server.use(
      http.get(`${apiUrl}/configurations/agent/models`, () => {
        reads++;
        return HttpResponse.json({ status: "success", data: { models } });
      }),
      http.put(
        `${apiUrl}/configurations/agent/models/:modelId`,
        async ({ params, request }) => {
          modelWrites.push({
            modelId: params.modelId,
            ...((await request.json()) as Record<string, unknown>),
          });
          models = models.map((model) =>
            model.modelId === params.modelId
              ? { ...model, enabled: false, meta: stamp() }
              : model,
          );
          return HttpResponse.json({
            status: "success",
            data: models.find((model) => model.modelId === params.modelId),
          });
        },
      ),
    );
    renderPage("/settings#sandbox-spaces");
    await screen.findByText("Nova Pro");
    await stageDisable();
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh model catalog" }),
    );
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh model catalog" }),
      ).not.toBeDisabled(),
    );
    expect(
      screen.getByText(/1 model will be disabled when you save this group/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Nova Pro")).not.toBeInTheDocument();
    expect(modelWrites).toHaveLength(0);
    await userEvent.click(save());
    await waitFor(() =>
      expect(showSuccessToast).toHaveBeenCalledWith("Settings saved."),
    );
    expect(modelWrites).toEqual([
      expect.objectContaining({
        modelId: "amazon.nova-pro-v1:0",
        enabled: false,
        expectedLastEditTime: row().meta.lastEditTime,
      }),
    ]);
  });

  it("preserves model selection and its cached query while section views change", async () => {
    let catalogReads = 0;
    server.use(
      http.get(`${apiUrl}/configurations/agent/models`, () => {
        catalogReads++;
        return HttpResponse.json({
          status: "success",
          data: { models: [row()] },
        });
      }),
    );
    renderPage("/settings#sandbox-spaces");
    await screen.findByText("Claude 3 Haiku");
    const checkboxes = within(currentGroup("Sandbox Spaces")).getAllByRole(
      "checkbox",
    );
    await userEvent.click(checkboxes.at(-1)!);
    expect(screen.getByRole("button", { name: "Actions" })).not.toBeDisabled();
    const readsBeforeNavigation = catalogReads;
    await chooseGroup("General");
    expect(screen.queryByText("Claude 3 Haiku")).not.toBeInTheDocument();
    await chooseGroup("Sandbox Spaces");
    expect(screen.getByText("Claude 3 Haiku")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actions" })).not.toBeDisabled();
    expect(catalogReads).toBe(readsBeforeNavigation);
  });

  it("stages model disables with the group, supports Cancel, and preserves the row token on Save", async () => {
    let model = row();
    const modelWrites: Record<string, unknown>[] = [];
    server.use(
      http.get(`${apiUrl}/configurations/agent/models`, () =>
        HttpResponse.json({ status: "success", data: { models: [model] } }),
      ),
      http.put(
        `${apiUrl}/configurations/agent/models/:modelId`,
        async ({ request }) => {
          modelWrites.push((await request.json()) as Record<string, unknown>);
          model = {
            ...model,
            enabled: false,
            lastSavedBy: "catalog-editor@example.com",
            meta: stamp(),
          };
          return HttpResponse.json({ status: "success", data: model });
        },
      ),
    );
    renderPage("/settings#sandbox-spaces");
    await screen.findByText("Claude 3 Haiku");
    await stageDisable();
    expect(modelWrites).toHaveLength(0);
    expect(
      screen.queryByRole("img", { name: "Sandbox Spaces: unsaved changes" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Discard changes" }),
    );
    await screen.findByText("Claude 3 Haiku");
    expect(save()).toHaveAttribute("aria-disabled", "true");
    await stageDisable();
    await userEvent.click(save());
    await waitFor(() =>
      expect(showSuccessToast).toHaveBeenCalledWith("Settings saved."),
    );
    expect(modelWrites).toEqual([
      expect.objectContaining({
        enabled: false,
        expectedLastEditTime: row().meta.lastEditTime,
      }),
    ]);
    expect(bodies).toHaveLength(0);
    expect(save()).toHaveAttribute("aria-disabled", "true");
    await waitFor(() =>
      expect(
        screen.getByRole("region", {
          name: "Sandbox Spaces last edited",
        }),
      ).toHaveTextContent("Last edited by catalog-editor@example.com"),
    );
    expect(screen.getAllByText(/^Last edited by /)).toHaveLength(1);
  });

  it("blocks a model conflict until explicit reload and names the latest editor", async () => {
    let model = row();
    const catalogRows = () => [
      model,
      { ...model, modelId: "amazon.nova-pro-v1:0", displayName: "Nova Pro" },
    ];
    let writes = 0;
    server.use(
      http.get(`${apiUrl}/configurations/agent/models`, () =>
        HttpResponse.json({
          status: "success",
          data: { models: catalogRows() },
        }),
      ),
      http.put(`${apiUrl}/configurations/agent/models/:modelId`, () => {
        writes++;
        return HttpResponse.json({ status: "fail", data: {} }, { status: 409 });
      }),
    );
    renderPage("/settings#sandbox-spaces");
    await screen.findByText("Claude 3 Haiku");
    await stageDisable();
    model = {
      ...model,
      lastSavedBy: "catalog-admin@example.com",
      meta: stamp(),
    };
    await userEvent.click(save());
    await screen.findByText(/catalog-admin@example.com saved these settings/);
    expect(save()).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("button", { name: "Refresh model catalog" }),
    ).toBeDisabled();
    await userEvent.click(save());
    expect(writes).toBe(1);
    let releaseReload!: () => void;
    const pendingReload = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    let catalogReloadStarted = false;
    server.use(
      http.get(`${apiUrl}/configurations/agent/models`, async () => {
        catalogReloadStarted = true;
        await pendingReload;
        return HttpResponse.json({
          status: "success",
          data: { models: catalogRows() },
        });
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reload latest values" }),
    );
    try {
      // The configuration read has finished; the page must still wait for the catalog.
      await waitFor(() => expect(catalogReloadStarted).toBe(true));
      await chooseGroup("General");
      expect(currentGroup("Sandbox Spaces")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Reload latest values" }),
      ).toBeDisabled();
      expect(screen.getByLabelText("Enable Sandbox Spaces")).toBeDisabled();
    } finally {
      releaseReload();
    }
    await screen.findByText("Claude 3 Haiku");
    await waitFor(() =>
      expect(
        screen.queryByText("Settings changed by another administrator"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Refresh model catalog" }),
    ).not.toBeDisabled();
    await stageDisable();
    expect(save()).not.toHaveAttribute("aria-disabled", "true");
  });

  it("keeps a saved configuration when the catalog write fails and retries only the catalog", async () => {
    let model = row();
    let rejectModelWrite = true;
    const modelWrites: Record<string, unknown>[] = [];
    server.use(
      http.get(`${apiUrl}/configurations/agent/models`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            models: [
              row(),
              {
                ...model,
                modelId: "amazon.nova-pro-v1:0",
                displayName: "Nova Pro",
              },
            ],
          },
        }),
      ),
      http.put(
        `${apiUrl}/configurations/agent/models/:modelId`,
        async ({ request }) => {
          modelWrites.push((await request.json()) as Record<string, unknown>);
          if (rejectModelWrite) return new HttpResponse(null, { status: 500 });
          model = { ...model, enabled: false, meta: stamp() };
          return HttpResponse.json({ status: "success", data: model });
        },
      ),
    );
    renderPage("/settings#sandbox-spaces");
    await screen.findByText("Nova Pro");
    await userEvent.click(screen.getByLabelText("Enable Sandbox Spaces"));
    await stageDisable();
    await chooseGroup("General");
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => expect(showErrorToast).toHaveBeenCalled());
    expect(currentGroup("Sandbox Spaces")).toBeInTheDocument();
    expect(showSuccessToast).not.toHaveBeenCalled();
    expect(bodies.map(({ section }) => section)).toEqual(["agent"]);
    expect(config.agent.sandboxSpacesEnabled).toBe(true);
    expect(modelWrites).toHaveLength(1);
    expect(screen.getByLabelText("Enable Sandbox Spaces")).toBeChecked();

    rejectModelWrite = false;
    await chooseGroup("General");
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Save changes" }),
    );
    await screen.findByRole("region", { name: "General settings" });
    expect(showSuccessToast).toHaveBeenCalledTimes(1);
    expect(bodies.map(({ section }) => section)).toEqual(["agent"]);
    expect(modelWrites).toHaveLength(2);
  });

  describe("keeping a model enabled while Sandbox Spaces is on", () => {
    const KEEP_ONE_MODEL =
      "Keep at least one model enabled while Sandbox Spaces is turned on.";
    let modelWrites: string[];
    beforeEach(() => {
      config.agent.sandboxSpacesEnabled = true;
      modelWrites = [];
      const models = [
        row(),
        { ...row(), modelId: "amazon.nova-pro-v1:0", displayName: "Nova Pro" },
      ];
      server.use(
        http.get(`${apiUrl}/configurations/agent/models`, () =>
          HttpResponse.json({ status: "success", data: { models } }),
        ),
        http.put(
          `${apiUrl}/configurations/agent/models/:modelId`,
          ({ params }) => {
            modelWrites.push(params.modelId as string);
            return HttpResponse.json({
              status: "success",
              data: {
                ...models.find((model) => model.modelId === params.modelId),
                enabled: false,
                meta: stamp(),
              },
            });
          },
        ),
      );
    });
    async function stageDisableAll() {
      await screen.findByText("Nova Pro");
      await userEvent.click(
        within(screen.getByRole("table")).getAllByRole("checkbox")[0],
      );
      await userEvent.click(screen.getByRole("button", { name: "Actions" }));
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Disable" }),
      );
      await screen.findByText(
        /2 models will be disabled when you save this group/,
      );
    }

    it("stops the save before any write and keeps both drafts", async () => {
      renderPage("/settings#sandbox-spaces");
      await stageDisableAll();
      await userEvent.click(save());

      await waitFor(() =>
        expect(showErrorToast).toHaveBeenCalledWith(
          KEEP_ONE_MODEL,
          "Settings not saved",
        ),
      );
      expect(modelWrites).toHaveLength(0);
      expect(bodies).toHaveLength(0);
      expect(showSuccessToast).not.toHaveBeenCalled();
      expect(
        screen.getByText(/2 models will be disabled when you save this group/),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Enable Sandbox Spaces")).toBeChecked();
      expect(save()).not.toHaveAttribute("aria-disabled", "true");
    });

    it("stops the save when Sandbox Spaces is turned on in the same save", async () => {
      config.agent.sandboxSpacesEnabled = false;
      renderPage("/settings#sandbox-spaces");
      await stageDisableAll();
      await userEvent.click(screen.getByLabelText("Enable Sandbox Spaces"));
      await userEvent.click(save());

      await waitFor(() =>
        expect(showErrorToast).toHaveBeenCalledWith(
          KEEP_ONE_MODEL,
          "Settings not saved",
        ),
      );
      expect(modelWrites).toHaveLength(0);
      expect(bodies).toHaveLength(0);
      expect(screen.getByLabelText("Enable Sandbox Spaces")).toBeChecked();
      expect(
        screen.getByText(/2 models will be disabled when you save this group/),
      ).toBeInTheDocument();
    });

    it("keeps every model enabled when turning off Sandbox Spaces fails", async () => {
      server.use(
        http.put(
          `${apiUrl}/configurations/agent`,
          () => new HttpResponse(null, { status: 500 }),
        ),
      );
      renderPage("/settings#sandbox-spaces");
      await stageDisableAll();
      await userEvent.click(screen.getByLabelText("Enable Sandbox Spaces"));
      await userEvent.click(save());
      await userEvent.click(
        within(await screen.findByRole("dialog")).getByRole("button", {
          name: "Save changes",
        }),
      );

      await waitFor(() => expect(showErrorToast).toHaveBeenCalled());
      expect(modelWrites).toHaveLength(0);
      expect(showSuccessToast).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Enable Sandbox Spaces")).not.toBeChecked();
      expect(
        screen.getByText(/2 models will be disabled when you save this group/),
      ).toBeInTheDocument();
    });

    it("disables every model when Sandbox Spaces is turned off in the same save", async () => {
      renderPage("/settings#sandbox-spaces");
      await stageDisableAll();
      await userEvent.click(screen.getByLabelText("Enable Sandbox Spaces"));
      await userEvent.click(save());
      await userEvent.click(
        within(await screen.findByRole("dialog")).getByRole("button", {
          name: "Save changes",
        }),
      );

      await waitFor(() =>
        expect(showSuccessToast).toHaveBeenCalledWith("Settings saved."),
      );
      expect(modelWrites).toHaveLength(2);
      expect(bodies).toEqual([
        expect.objectContaining({
          section: "agent",
          body: expect.objectContaining({ sandboxSpacesEnabled: false }),
        }),
      ]);
    });

    it("disables a model when another stays enabled", async () => {
      renderPage("/settings#sandbox-spaces");
      await screen.findByText("Nova Pro");
      await stageDisable();
      await userEvent.click(save());

      await waitFor(() =>
        expect(showSuccessToast).toHaveBeenCalledWith("Settings saved."),
      );
      expect(modelWrites).toEqual(["amazon.nova-pro-v1:0"]);
      expect(showErrorToast).not.toHaveBeenCalled();
    });

    it("counts models disabled by a partly failed save before the catalog reloads", async () => {
      const models = [
        row(),
        { ...row(), modelId: "amazon.nova-pro-v1:0", displayName: "Nova Pro" },
        {
          ...row(),
          modelId: "amazon.nova-lite-v1:0",
          displayName: "Nova Lite",
        },
      ];
      let catalogReads = 0;
      server.use(
        http.get(`${apiUrl}/configurations/agent/models`, () => {
          catalogReads++;
          // Later reads never settle, so only the save's own results update the count.
          if (catalogReads > 1) return new Promise<never>(() => {});
          return HttpResponse.json({ status: "success", data: { models } });
        }),
        http.put(
          `${apiUrl}/configurations/agent/models/:modelId`,
          ({ params }) => {
            modelWrites.push(params.modelId as string);
            if (params.modelId === "amazon.nova-pro-v1:0")
              return new HttpResponse(null, { status: 500 });
            return HttpResponse.json({
              status: "success",
              data: {
                ...models.find((model) => model.modelId === params.modelId),
                enabled: false,
                meta: stamp(),
              },
            });
          },
        ),
      );
      renderPage("/settings#sandbox-spaces");
      await screen.findByText("Nova Lite");
      const rowCheckbox = (name: string) =>
        within(screen.getByRole("row", { name: new RegExp(name) })).getByRole(
          "checkbox",
        );
      await userEvent.click(rowCheckbox("Claude 3 Haiku"));
      await userEvent.click(rowCheckbox("Nova Pro"));
      await userEvent.click(screen.getByRole("button", { name: "Actions" }));
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Disable" }),
      );
      await userEvent.click(save());
      await waitFor(() => expect(modelWrites).toHaveLength(2));
      await screen.findByText(
        /1 model will be disabled when you save this group/,
      );
      expect(screen.queryByText("Claude 3 Haiku")).not.toBeInTheDocument();

      await userEvent.click(rowCheckbox("Nova Lite"));
      await userEvent.click(screen.getByRole("button", { name: "Actions" }));
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Disable" }),
      );
      await screen.findByText(
        /2 models will be disabled when you save this group/,
      );
      vi.mocked(showErrorToast).mockClear();
      await userEvent.click(save());

      await waitFor(() =>
        expect(showErrorToast).toHaveBeenCalledWith(
          KEEP_ONE_MODEL,
          "Settings not saved",
        ),
      );
      expect(modelWrites).toHaveLength(2);
    });
  });

  it("protects a model-only draft when leaving Settings", async () => {
    server.use(
      http.get(`${apiUrl}/configurations/agent/models`, () =>
        HttpResponse.json({ status: "success", data: { models: [row()] } }),
      ),
    );
    renderPage("/settings#sandbox-spaces");
    await screen.findByText("Claude 3 Haiku");
    await stageDisable();
    await userEvent.click(screen.getByRole("button", { name: "Add models" }));
    expect(
      await screen.findByRole("dialog", { name: "Leave page?" }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Stay" }),
    );
    expect(currentGroup("Sandbox Spaces")).toBeInTheDocument();
  });
});

describe("Page save history", () => {
  it("shows last edit above the save actions without an unsaved-changes message", async () => {
    renderPage();
    const footer = await screen.findByRole("region", {
      name: "General save bar",
    });
    const lastEdit = within(footer).getByRole("region", {
      name: "General last edited",
    });
    expect(
      within(footer)
        .getByRole("button", { name: "Save changes" })
        .compareDocumentPosition(lastEdit) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(within(footer).queryByRole("status")).not.toBeInTheDocument();
    expect(
      within(footer).queryByText("You have unsaved changes."),
    ).not.toBeInTheDocument();
    expect(
      within(footer).getByRole("button", { name: "Save changes" }),
    ).toHaveAttribute("aria-disabled", "true");
    await replaceInput("Terms of service content", "Updated terms");
    expect(
      within(footer).queryByText("You have unsaved changes."),
    ).not.toBeInTheDocument();
    expect(within(footer).getByText(/^Last edited by /)).toBeInTheDocument();
    expect(
      within(footer).getByRole("button", { name: "Save changes" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(
      within(footer).getByRole("button", { name: "Cancel" }),
    );
    await userEvent.click(
      within(modal()).getByRole("button", { name: "Discard changes" }),
    );
    expect(
      within(footer).queryByText("You have unsaved changes."),
    ).not.toBeInTheDocument();
    expect(within(footer).getByText(/^Last edited by /)).toBeInTheDocument();
    expect(
      within(footer).getByRole("button", { name: "Save changes" }),
    ).toHaveAttribute("aria-disabled", "true");
  });
  it.each([true, false])(
    "shows one last-edited summary on every page (admin: %s)",
    async (isAdmin) => {
      role.isAdmin = isAdmin;
      renderPage();
      await screen.findByRole("region", { name: "General settings" });
      for (const group of SETTINGS_GROUPS) {
        await chooseGroup(group.label);
        const summary = screen.getByRole("region", {
          name: `${group.label} last edited`,
        });
        expect(screen.getAllByText(/^Last edited by /)).toHaveLength(1);
        const footer = screen.getByRole("region", {
          name: `${group.label} ${isAdmin ? "save bar" : "footer"}`,
        });
        expect(
          within(footer).getByRole("region", {
            name: `${group.label} last edited`,
          }),
        ).toBe(summary);
        expect(
          within(footer).queryByRole("button", { name: "Save changes" }) !==
            null,
        ).toBe(isAdmin);
        expect(
          within(currentGroup(group.label)).getByRole("region", {
            name: `${group.label} last edited`,
          }),
        ).toBe(summary);
        expect(
          within(summary).getByText(/^Last edited by admin@example.com/),
        ).toBeInTheDocument();
      }
    },
  );

  it("uses the most recent edit on this page, comparing timestamps across time zones", async () => {
    config.maintenance.lastSavedBy = "latest-general-editor@example.com";
    config.maintenance.meta!.lastEditTime = "2026-11-03T08:00:00.000Z";
    config.termsOfService.lastSavedBy = "earlier-general-editor@example.com";
    config.termsOfService.meta!.lastEditTime = "2026-11-03T10:30:00.000+03:00";
    config.leases.lastSavedBy = "unrelated-page-editor@example.com";
    config.leases.meta!.lastEditTime = "2026-11-03T09:00:00.000Z";
    renderPage();
    const summary = await screen.findByRole("region", {
      name: "General last edited",
    });
    expect(summary).toHaveTextContent(
      "Last edited by latest-general-editor@example.com",
    );
    expect(summary).not.toHaveTextContent("earlier-general-editor@example.com");
    expect(summary).not.toHaveTextContent("unrelated-page-editor@example.com");
    expect(screen.getAllByText(/^Last edited by /)).toHaveLength(1);
  });

  it("omits save history when the page uses unpersisted defaults", async () => {
    config = createAdminConfig({ unsaved: ["maintenance", "termsOfService"] });
    renderPage();
    const summary = await screen.findByRole("region", {
      name: "General last edited",
    });
    expect(summary).toBeEmptyDOMElement();
    expect(screen.queryByText("Not yet saved")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Last edited by /)).not.toBeInTheDocument();
  });

  it("preserves saved provenance when a timestamp is unavailable", async () => {
    config.maintenance.lastSavedBy = null;
    config.termsOfService.lastSavedBy = "legacy-editor@example.com";
    delete config.termsOfService.meta;
    renderPage();
    const summary = await screen.findByRole("region", {
      name: "General last edited",
    });
    expect(summary).toHaveTextContent(
      "Last edited by legacy-editor@example.com",
    );
    expect(screen.getAllByText(/^Last edited by /)).toHaveLength(1);
  });

  it("updates the page summary after saving an edit", async () => {
    server.use(
      http.put(
        `${apiUrl}/configurations/termsOfService`,
        async ({ request }) => {
          const { meta: _meta, ...fields } = (await request.json()) as Record<
            string,
            unknown
          >;
          config.termsOfService = {
            ...config.termsOfService,
            ...fields,
            lastSavedBy: "new-general-editor@example.com",
            meta: stamp(),
          };
          return HttpResponse.json({
            status: "success",
            data: config.termsOfService,
          });
        },
      ),
    );
    renderPage();
    await screen.findByRole("region", { name: "General last edited" });
    await replaceInput("Terms of service content", "Updated terms");
    await userEvent.click(save());
    await waitFor(() =>
      expect(
        screen.getByRole("region", {
          name: "General last edited",
        }),
      ).toHaveTextContent("Last edited by new-general-editor@example.com"),
    );
    expect(screen.getAllByText(/^Last edited by /)).toHaveLength(1);
  });
});

describe("Setting search and existing links", () => {
  it("scrolls and refocuses the same search result on every selection", async () => {
    const scroll = vi.fn();
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      renderPage();
      const search = await screen.findByRole("combobox", {
        name: "Find a setting",
      });
      for (let selection = 0; selection < 2; selection++) {
        scroll.mockClear();
        await userEvent.type(search, "max budget");
        fireEvent.keyDown(search, { key: "ArrowDown", keyCode: 40 });
        fireEvent.keyDown(search, { key: "Enter", keyCode: 13 });
        await waitFor(() =>
          expect(screen.getByLabelText("Max budget")).toHaveFocus(),
        );
        expect(scroll).toHaveBeenCalledWith({
          behavior: "smooth",
          block: "start",
        });
      }
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
  });

  it.each([
    ["version", "Solution version"],
    ["awsAccessPortalUrl", "AWS access portal URL"],
    ["isbManagedRegions", "Innovation Sandbox managed regions"],
    ["bedrockInferenceProfilePatterns", "Bedrock inference profile patterns"],
  ])(
    "focuses the read-only %s value after selecting its search result",
    async (id, label) => {
      renderPage();
      const search = await screen.findByRole("combobox", {
        name: "Find a setting",
      });
      await userEvent.type(search, label);
      await userEvent.click(searchResult(label));
      await waitFor(() => expect(document.getElementById(id)).toHaveFocus());
    },
  );

  it.each([
    ["retention", "Lease record retention (days)", "Lease policies"],
    ["typeahead", "Principal search", "Lease policies"],
    ["quarantine", "On validation failure", "Account cleanup"],
    ["budget", "Max budget", "Lease policies"],
  ])(
    "finds %s, opens its group, scrolls and focuses the setting",
    async (query, label, group) => {
      const scroll = vi.fn();
      const originalScroll = HTMLElement.prototype.scrollIntoView;
      HTMLElement.prototype.scrollIntoView = scroll;
      try {
        renderPage();
        await screen.findByRole("combobox", { name: "Find a setting" });
        await userEvent.type(
          screen.getByRole("combobox", { name: "Find a setting" }),
          query,
        );
        await userEvent.click(searchResult(label));
        await screen.findByRole("region", { name: `${group} settings` });
        await waitFor(() =>
          expect(scroll).toHaveBeenCalledWith({
            behavior: "smooth",
            block: "start",
          }),
        );
        await waitFor(() =>
          expect(
            document.activeElement?.closest("[id^='setting-']"),
          ).toHaveTextContent(label),
        );
      } finally {
        HTMLElement.prototype.scrollIntoView = originalScroll;
      }
    },
  );

  it("finds group and subgroup names and displays the Group › Subgroup path", async () => {
    renderPage();
    await screen.findByRole("combobox", { name: "Find a setting" });
    await userEvent.type(
      screen.getByRole("combobox", { name: "Find a setting" }),
      "data retention",
    );
    expect(searchResult("Lease record retention (days)")).toBeInTheDocument();
    expect(searchResult("Cleanup report retention (days)")).toBeInTheDocument();
    expect(searchResult("Lease record retention (days)")).toHaveTextContent(
      "Lease policies › Data retention",
    );
  });

  it.each([true, false])(
    "keeps section links mounted while searching and after clearing (admin: %s)",
    async (isAdmin) => {
      role.isAdmin = isAdmin;
      renderPage();
      const search = await screen.findByRole("combobox", {
        name: "Find a setting",
      });
      const navigation = screen.getByRole("navigation", {
        name: "Settings groups",
      });
      const links = SETTINGS_GROUPS.map((group) =>
        within(navigation).getByRole("link", { name: group.label }),
      );
      await userEvent.type(search, "cost");
      const results = within(navigation).getByRole("listbox");
      expect(
        within(results).getAllByRole("option", { name: /cost/i }),
      ).toHaveLength(5);
      expect(within(navigation).getByText("5 matches")).toBeInTheDocument();
      for (const [index, group] of SETTINGS_GROUPS.entries()) {
        expect(
          within(navigation).getByRole("link", { name: group.label }),
        ).toBe(links[index]);
      }
      await userEvent.clear(search);
      expect(within(navigation).queryByRole("listbox")).not.toBeInTheDocument();
      for (const [index, group] of SETTINGS_GROUPS.entries()) {
        expect(
          within(navigation).getByRole("link", { name: group.label }),
        ).toBe(links[index]);
      }
    },
  );

  it("keeps section links available when the search has no matches", async () => {
    renderPage();
    const search = await screen.findByRole("combobox", {
      name: "Find a setting",
    });
    await userEvent.type(search, "does-not-match-any-setting");
    const navigation = screen.getByRole("navigation", {
      name: "Settings groups",
    });
    expect(
      within(navigation).getByText("No settings found."),
    ).toBeInTheDocument();
    for (const group of SETTINGS_GROUPS) {
      expect(
        within(navigation).getByRole("link", { name: group.label }),
      ).toBeInTheDocument();
    }
  });

  it("includes the title and path in one native search result and opens it from the path", async () => {
    renderPage();
    const search = await screen.findByRole("combobox", {
      name: "Find a setting",
    });
    await userEvent.type(search, "cost");
    const result = searchResult("Allow estimated cost tracking");
    const path = within(result).getByText(/Lease policies/);
    expect(result).toHaveAccessibleName(
      "Allow estimated cost tracking Lease policies › Cost tracking",
    );
    await userEvent.click(path);
    await screen.findByRole("region", { name: "Lease policies settings" });
    expect(search).toHaveValue("");
    await waitFor(() =>
      expect(
        screen.getByLabelText("Allow estimated cost tracking"),
      ).toHaveFocus(),
    );
  });

  it.each([
    ["ArrowDown", 40, "Allow estimated cost tracking"],
    ["ArrowUp", 38, "Allow Bedrock token monitoring"],
  ])(
    "opens a search result with %s using native keyboard selection",
    async (key, keyCode, label) => {
      renderPage();
      const search = await screen.findByRole("combobox", {
        name: "Find a setting",
      });
      await userEvent.type(search, "cost");
      expect(search).toHaveFocus();
      expect(searchResult(label)).toHaveTextContent(
        "Lease policies › Cost tracking",
      );
      fireEvent.keyDown(search, { key, keyCode });
      fireEvent.keyDown(search, { key: "Enter", keyCode: 13 });
      await screen.findByRole("region", { name: "Lease policies settings" });
      await waitFor(() => expect(screen.getByLabelText(label)).toHaveFocus());
    },
  );

  it("opens and focuses token monitoring from the Spaces description", async () => {
    renderPage("/settings#sandbox-spaces");
    await screen.findByLabelText("Enable Sandbox Spaces");
    await userEvent.click(
      screen.getByRole("link", { name: "Allow Bedrock token monitoring" }),
    );
    await screen.findByRole("region", { name: "Lease policies settings" });
    await waitFor(() =>
      expect(
        screen.getByLabelText("Allow Bedrock token monitoring"),
      ).toHaveFocus(),
    );
  });

  it("opens and focuses token monitoring from its standardized URL", async () => {
    renderPage("/settings#setting-leases-allowBedrockTokenMonitoring");
    await screen.findByRole("region", { name: "Lease policies settings" });
    await waitFor(() =>
      expect(
        screen.getByLabelText("Allow Bedrock token monitoring"),
      ).toHaveFocus(),
    );
  });

  it.each([
    ["setting-maintenance-enabled", "General", "Maintenance mode"],
    ["setting-termsOfService-content", "General", "Terms of service content"],
    [
      "setting-notification-sesEnabled",
      "Notifications",
      "Email notifications (SES)",
    ],
    [
      "setting-cleanup-numberOfFailedAttemptsToCancelCleanup",
      "Account cleanup",
      "Failed attempts before quarantine",
    ],
    [
      "setting-costReporting-requireCostReportGroup",
      "Cost",
      "Require cost report group",
    ],
    [
      "setting-agent-sandboxSpacesEnabled",
      "Sandbox Spaces",
      "Enable Sandbox Spaces",
    ],
  ])("opens and focuses the #%s field link", async (hash, group, label) => {
    renderPage(`/settings#${hash}`);
    await screen.findByRole("region", { name: `${group} settings` });
    await waitFor(() => expect(screen.getByLabelText(label)).toHaveFocus());
  });
});
