// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SettingsBadge } from "@amzn/innovation-sandbox-frontend/domains/settings/components/SettingsBadge";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import {
  adminConfigGetHandler,
  createAdminConfig,
} from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";
import { ConfigSection } from "@amzn/innovation-sandbox-shared/types/configuration.js";

vi.mock("@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService", () => ({
  CognitoAuthService: {
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

function ConfigSettledProbe() {
  const { isSuccess } = useGetConfigurations();
  return isSuccess ? <div data-testid="config-settled" /> : null;
}

describe("SettingsBadge", () => {
  it.each([
    {
      unsaved: ["agent"],
      count: 1,
      label: "1 settings page has unsaved defaults",
    },
    {
      unsaved: ["maintenance"],
      count: 1,
      label: "1 settings page has unsaved defaults",
    },
    {
      unsaved: ["termsOfService"],
      count: 1,
      label: "1 settings page has unsaved defaults",
    },
    {
      unsaved: ["maintenance", "termsOfService"],
      count: 1,
      label: "1 settings page has unsaved defaults",
    },
    {
      unsaved: ["maintenance", "termsOfService", "cleanup"],
      count: 2,
      label: "2 settings pages have unsaved defaults",
    },
    {
      unsaved: ["leases"],
      count: 2,
      label: "2 settings pages have unsaved defaults",
    },
    {
      unsaved: ["costReporting"],
      count: 1,
      label: "1 settings page has unsaved defaults",
    },
    {
      unsaved: ["leases", "costReporting"],
      count: 2,
      label: "2 settings pages have unsaved defaults",
    },
    {
      unsaved: ["leases", "cleanup"],
      count: 3,
      label: "3 settings pages have unsaved defaults",
    },
    {
      unsaved: [
        "agent",
        "leases",
        "cleanup",
        "maintenance",
        "notification",
        "termsOfService",
        "costReporting",
      ],
      count: 6,
      label: "6 settings pages have unsaved defaults",
    },
  ])(
    "counts $count settings pages with unsaved defaults when $unsaved are unsaved",
    async ({ unsaved, count, label }) => {
      server.use(
        adminConfigGetHandler(
          createAdminConfig({ unsaved: unsaved as ConfigSection[] }),
        ),
      );
      render(<SettingsBadge />, { wrapper: createQueryClientWrapper() });
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(await screen.findByRole("img", { name: label })).toHaveTextContent(
        String(count),
      );
    },
  );

  it("renders nothing after every section has been saved", async () => {
    server.use(adminConfigGetHandler(createAdminConfig()));
    render(
      <>
        <SettingsBadge />
        <ConfigSettledProbe />
      </>,
      { wrapper: createQueryClientWrapper() },
    );
    await screen.findByTestId("config-settled");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
