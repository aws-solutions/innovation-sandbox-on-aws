// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TermsOfServiceForm as TermsOfServiceFormFields } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/TermsOfServiceForm";
import type { ConfigurationSectionView } from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import { mockAdminConfig } from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";
import { CONFIG_BOUNDS } from "@amzn/innovation-sandbox-shared/types/configuration.js";

import { ConfigurationFormHarness } from "./ConfigurationFormHarness";

function TermsOfServiceForm({
  data,
}: {
  data: ConfigurationSectionView<"termsOfService">;
}) {
  return (
    <ConfigurationFormHarness section="termsOfService" data={data}>
      <TermsOfServiceFormFields />
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

describe("TermsOfServiceForm", () => {
  it("renders the editable textarea and a Save button for an admin", async () => {
    render(<TermsOfServiceForm data={mockAdminConfig.termsOfService} />, {
      wrapper: createQueryClientWrapper(),
    });

    // The "Terms of service content" label appears in both views, so
    // disambiguate the admin view by the Save button (await it) and the textarea
    // control, which the read-only view does not render.
    expect(
      await screen.findByRole("button", { name: /save/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("shows a live character count against the schema max", async () => {
    const content = mockAdminConfig.termsOfService.content;
    render(<TermsOfServiceForm data={mockAdminConfig.termsOfService} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByRole("button", { name: /save/i });

    // The count reflects the current content length over the schema max.
    expect(
      screen.getByText(
        `${content.length} / ${CONFIG_BOUNDS.MAX_TERMS_OF_SERVICE_LENGTH} characters`,
      ),
    ).toBeInTheDocument();
  });

  it("renders the terms textarea read-only for a manager", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(<TermsOfServiceForm data={mockAdminConfig.termsOfService} />, {
      wrapper: createQueryClientWrapper(),
    });

    const input = await screen.findByRole("textbox");
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveValue(mockAdminConfig.termsOfService.content);
    await userEvent.type(input, "Changed terms");
    expect(input).toHaveValue(mockAdminConfig.termsOfService.content);
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();
  });
});
