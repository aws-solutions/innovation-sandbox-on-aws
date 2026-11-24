// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CostReportingForm as CostReportingFormFields } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/CostReportingForm";
import type { ConfigurationSectionView } from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";
import { CONFIG_BOUNDS } from "@amzn/innovation-sandbox-shared/types/configuration.js";

import { ConfigurationFormHarness } from "./ConfigurationFormHarness";

function CostReportingForm({
  data,
}: {
  data: ConfigurationSectionView<"costReporting">;
}) {
  return (
    <ConfigurationFormHarness section="costReporting" data={data}>
      <CostReportingFormFields />
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

const baseData = {
  costReportGroups: ["team-a"],
  requireCostReportGroup: false,
  lastSavedBy: "a@b.com",
};

describe("CostReportingForm", () => {
  it.each(["enable requirement", "remove last group"])(
    "blocks saving missing required groups after %s and recovers when a group is added",
    async (action) => {
      const put = vi.fn();
      server.use(
        http.put(
          `${getConfig().ApiUrl}/configurations/costReporting`,
          async ({ request }) => {
            const body = await request.json();
            put(body);
            return HttpResponse.json({
              status: "success",
              data: { ...baseData, ...(body as object) },
            });
          },
        ),
      );
      render(
        <CostReportingForm
          data={{
            ...baseData,
            costReportGroups: action === "enable requirement" ? [] : ["team-a"],
            requireCostReportGroup: action === "remove last group",
          }}
        />,
        { wrapper: createQueryClientWrapper() },
      );
      const input = await screen.findByPlaceholderText(/add a group/i);
      await userEvent.click(
        action === "enable requirement"
          ? screen.getByRole("checkbox")
          : screen.getByRole("button", { name: /remove team-a/i }),
      );

      const message =
        "Add at least one cost report group or turn off Require cost report group.";
      expect(await screen.findByText(message)).toBeInTheDocument();
      const save = screen.getByRole("button", { name: /^save$/i });
      expect(save).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(save);
      expect(put).not.toHaveBeenCalled();

      await userEvent.type(input, "team-b{enter}");
      await waitFor(() =>
        expect(save).not.toHaveAttribute("aria-disabled", "true"),
      );
      expect(screen.queryByText(message)).not.toBeInTheDocument();
      await userEvent.click(save);
      await waitFor(() =>
        expect(put).toHaveBeenCalledWith({
          requireCostReportGroup: true,
          costReportGroups: ["team-b"],
        }),
      );
    },
  );

  it("clears the missing-groups error and allows saving when the requirement is turned off", async () => {
    render(
      <CostReportingForm
        data={{ ...baseData, requireCostReportGroup: true }}
      />,
      { wrapper: createQueryClientWrapper() },
    );
    await screen.findByPlaceholderText(/add a group/i);
    await userEvent.click(
      screen.getByRole("button", { name: /remove team-a/i }),
    );
    const message =
      "Add at least one cost report group or turn off Require cost report group.";
    expect(await screen.findByText(message)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => {
      expect(screen.queryByText(message)).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /^save$/i }),
      ).not.toHaveAttribute("aria-disabled", "true");
    });
  });

  it("loads existing invalid settings and lets the admin repair them by adding a group", async () => {
    render(
      <CostReportingForm
        data={{
          ...baseData,
          requireCostReportGroup: true,
          costReportGroups: [],
        }}
      />,
      { wrapper: createQueryClientWrapper() },
    );
    const input = await screen.findByPlaceholderText(/add a group/i);
    expect(screen.getByRole("checkbox")).toBeChecked();

    await userEvent.type(input, "team-a{enter}");

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^save$/i }),
      ).not.toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("renders existing groups as tokens and adds a new one", async () => {
    render(<CostReportingForm data={baseData} />, {
      wrapper: createQueryClientWrapper(),
    });

    // Wait for the form controls, then verify the saved token and live count.
    const input = await screen.findByPlaceholderText(/add a group/i);
    expect(screen.getByText("team-a")).toBeInTheDocument();
    // The field shows a live "N / max groups" count (not a static "Up to N").
    expect(
      screen.getByText(`1 / ${CONFIG_BOUNDS.MAX_COST_REPORT_GROUPS} groups`),
    ).toBeInTheDocument();

    await userEvent.type(input, "team-b{enter}");

    expect(await screen.findByText("team-b")).toBeInTheDocument();
    expect(
      screen.getByText(`2 / ${CONFIG_BOUNDS.MAX_COST_REPORT_GROUPS} groups`),
    ).toBeInTheDocument();
  });

  it("adds a group on Enter without submitting the form (only Save saves)", async () => {
    // Adding a token edits the local draft; only Save persists it.
    let putCount = 0;
    server.use(
      http.put(`${getConfig().ApiUrl}/configurations/:section`, async () => {
        putCount += 1;
        return HttpResponse.json({
          status: "success",
          data: {
            costReportGroups: ["team-a"],
            requireCostReportGroup: false,
            lastSavedBy: "a@b.com",
            meta: {
              schemaVersion: 1,
              createdTime: "2026-01-01T00:00:00.000Z",
              lastEditTime: "T1",
            },
          },
        });
      }),
    );

    render(<CostReportingForm data={baseData} />, {
      wrapper: createQueryClientWrapper(),
    });

    const input = await screen.findByPlaceholderText(/add a group/i);
    await userEvent.type(input, "team-b{enter}");

    // The token is added locally (the Enter handler ran)...
    expect(await screen.findByText("team-b")).toBeInTheDocument();
    // ...but Enter must NOT have triggered a save. Give any erroneous implicit
    // submit time to fire, then assert no PUT was made.
    await new Promise((r) => setTimeout(r, 50));
    expect(putCount).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(putCount).toBe(1));
  });

  it("removes a group when its token is dismissed", async () => {
    render(
      <CostReportingForm
        data={{ ...baseData, costReportGroups: ["team-a", "team-b"] }}
      />,
      {
        wrapper: createQueryClientWrapper(),
      },
    );

    // Wait for the admin (editable) form before locating the dismiss buttons.
    await screen.findByPlaceholderText(/add a group/i);
    expect(screen.getByText("team-a")).toBeInTheDocument();
    // Dismiss the first token.
    const dismissButtons = screen.getAllByRole("button", { name: /remove/i });
    await userEvent.click(dismissButtons[0]);

    expect(screen.queryByText("team-a")).not.toBeInTheDocument();
  });

  it("keeps the typed draft when the entry is a duplicate (no silent discard)", async () => {
    render(<CostReportingForm data={baseData} />, {
      wrapper: createQueryClientWrapper(),
    });

    // baseData already contains "team-a". Re-entering it must NOT add a second
    // token and, critically, must leave the typed text in the input rather than
    // clearing it with no feedback.
    const input = await screen.findByPlaceholderText(/add a group/i);
    await userEvent.type(input, "team-a{enter}");

    expect(screen.getAllByText("team-a")).toHaveLength(1);
    expect(input).toHaveValue("team-a");
  });

  it("rejects a group longer than the schema's max length at input time", async () => {
    render(<CostReportingForm data={baseData} />, {
      wrapper: createQueryClientWrapper(),
    });

    const input = await screen.findByPlaceholderText(/add a group/i);
    const tooLong = "x".repeat(CONFIG_BOUNDS.MAX_COST_REPORT_GROUP_LENGTH + 1);
    await userEvent.type(input, `${tooLong}{enter}`);

    // The over-length group is not added and an inline limit message appears.
    expect(screen.queryByText(tooLong)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        new RegExp(
          `${CONFIG_BOUNDS.MAX_COST_REPORT_GROUP_LENGTH} characters or fewer`,
          "i",
        ),
      ),
    ).toBeInTheDocument();
  });

  it("displays the group tokens sorted alphabetically regardless of entry order", async () => {
    // Saved out of order, then a new group added — the tokens must display a, b,
    // c, d, not the entry/stored order. Scoped to the TokenGroup so the assertion
    // is about the rendered token order.
    const { container } = render(
      <CostReportingForm
        data={{ ...baseData, costReportGroups: ["team-c", "team-a", "team-b"] }}
      />,
      { wrapper: createQueryClientWrapper() },
    );

    const input = await screen.findByPlaceholderText(/add a group/i);
    await userEvent.type(input, "team-d{enter}");

    // The dismiss buttons are labelled "Remove <group>" in token display order.
    await waitFor(() =>
      expect(
        within(container).getAllByRole("button", { name: /remove team-/i }),
      ).toHaveLength(4),
    );
    const tokenOrder = within(container)
      .getAllByRole("button", { name: /remove team-/i })
      .map((btn) => btn.getAttribute("aria-label"));
    expect(tokenOrder).toEqual([
      "Remove team-a",
      "Remove team-b",
      "Remove team-c",
      "Remove team-d",
    ]);
  });

  it("renders cost reporting controls read-only for a manager", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(<CostReportingForm data={baseData} />, {
      wrapper: createQueryClientWrapper(),
    });

    const input = await screen.findByPlaceholderText(/add a group/i);
    expect(input).toHaveAttribute("readonly");
    expect(screen.getByRole("checkbox")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    await userEvent.type(input, "team-b{Enter}");
    expect(screen.queryByText("team-b")).not.toBeInTheDocument();
    const remove = screen.getByRole("button", { name: /remove team-a/i });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(remove);
    expect(screen.getByText("team-a")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^save$/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the read-only boolean as human-readable status, not raw true/false", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(<CostReportingForm data={baseData} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByText("Require cost report group");
    // requireCostReportGroup is false -> shows "Disabled", never the raw "false".
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByText("false")).not.toBeInTheDocument();
  });

  it("renders saved cost report groups as sorted read-only tokens", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    const { container } = render(
      <CostReportingForm
        // Stored out of order so this asserts sorting, not merely "not reversed":
        // an identity (no-sort) render would show [team-c, team-a, team-b].
        data={{ ...baseData, costReportGroups: ["team-c", "team-a", "team-b"] }}
      />,
      { wrapper: createQueryClientWrapper() },
    );

    await screen.findByPlaceholderText(/add a group/i);
    const tokens = createWrapper(container).findTokenGroup()!.findTokens();
    expect(
      tokens.map((token) => token.findLabel().getElement().textContent),
    ).toEqual(["team-a", "team-b", "team-c"]);
    for (const remove of screen.getAllByRole("button", {
      name: /remove team-/i,
    }))
      expect(remove).toHaveAttribute("aria-disabled", "true");
  });

  it("shows an empty token list when no cost report groups are configured", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(<CostReportingForm data={{ ...baseData, costReportGroups: [] }} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByPlaceholderText(/add a group/i);
    expect(
      screen.getByText(`0 / ${CONFIG_BOUNDS.MAX_COST_REPORT_GROUPS} groups`),
    ).toBeInTheDocument();
  });
});
