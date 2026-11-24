// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationForm as NotificationFormFields } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/NotificationForm";
import type { ConfigurationSectionView } from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  configurationSectionValidationHandler,
  mockAdminConfig,
} from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";

import { ConfigurationFormHarness } from "./ConfigurationFormHarness";

function NotificationForm({
  data,
}: {
  data: ConfigurationSectionView<"notification">;
}) {
  return (
    <ConfigurationFormHarness section="notification" data={data}>
      <NotificationFormFields />
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

// The shared fixture carries the schema defaults (SES on, SNS off, no
// sender); tests override only the field they exercise.
const renderForm = (
  overrides: Partial<ConfigurationSectionView<"notification">> = {},
) =>
  render(
    <NotificationForm
      data={{ ...mockAdminConfig.notification, ...overrides }}
    />,
    { wrapper: createQueryClientWrapper() },
  );

const sesToggle = () =>
  screen.getByRole("checkbox", { name: /email notifications \(ses\)/i });
const snsToggle = () =>
  screen.getByRole("checkbox", { name: /sns integration topic/i });
const senderInput = () => screen.getByPlaceholderText(/no-reply@example\.com/i);
const saveButton = () => screen.getByRole("button", { name: /save/i });

// Captures the PUT body so a test can assert on the exact payload.
const capturePut = () => {
  const bodies: unknown[] = [];
  server.use(
    http.put(
      `${getConfig().ApiUrl}/configurations/:section`,
      async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({
          status: "success",
          data: {
            ...(bodies.at(-1) as object),
            lastSavedBy: "a@b.com",
            meta: {
              createdTime: "2026-04-04T10:00:00.000Z",
              lastEditTime: "2026-09-28T23:00:00.000Z",
            },
          },
        });
      },
    ),
  );
  return bodies;
};

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUser.mockResolvedValue(adminUser);
});

describe("NotificationForm", () => {
  it("updates its channel warning as the sender and notification toggles change", async () => {
    renderForm({
      sesEnabled: true,
      snsIntegrationTopicEnabled: false,
      emailFrom: "",
    });
    await screen.findByText("All notifications are off");

    await userEvent.type(senderInput(), "sender@example.com");
    expect(
      screen.queryByText("All notifications are off"),
    ).not.toBeInTheDocument();
    await userEvent.clear(senderInput());
    expect(screen.getByText("All notifications are off")).toBeInTheDocument();
    await userEvent.click(snsToggle());
    expect(
      screen.queryByText("All notifications are off"),
    ).not.toBeInTheDocument();
    await userEvent.click(sesToggle());
    expect(
      screen.queryByText("All notifications are off"),
    ).not.toBeInTheDocument();
    await userEvent.click(snsToggle());
    expect(screen.getByText("All notifications are off")).toBeInTheDocument();
  });

  it("renders both toggles, the sender input, and a Save button for an admin", async () => {
    renderForm({ emailFrom: "current@example.com" });

    expect(
      await screen.findByRole("button", { name: /save/i }),
    ).toBeInTheDocument();
    expect(sesToggle()).toBeChecked();
    expect(snsToggle()).not.toBeChecked();
    expect(senderInput()).toHaveValue("current@example.com");
  });

  it("keeps the sender editable while SES is off and notes it is unused", async () => {
    const user = userEvent.setup();
    renderForm({ sesEnabled: false, emailFrom: "current@example.com" });

    await screen.findByRole("button", { name: /save/i });
    expect(senderInput()).toBeEnabled();
    expect(senderInput()).toHaveValue("current@example.com");
    expect(screen.getByText(/not used while ses is off/i)).toBeInTheDocument();

    await user.click(sesToggle());
    expect(screen.getByText(/not used while ses is off/i)).toBeInTheDocument();
  });

  it("lets the admin fix an invalid sender after turning SES off", async () => {
    // A disabled input would trap the resolver error and leave Save stuck; the
    // field must stay editable so the admin can clear it.
    const user = userEvent.setup();
    renderForm();

    await screen.findByRole("button", { name: /save/i });
    await user.type(senderInput(), "not-an-email");
    await user.click(sesToggle());

    await waitFor(() =>
      expect(saveButton()).toHaveAttribute("aria-disabled", "true"),
    );
    await user.clear(senderInput());
    await waitFor(() =>
      expect(saveButton()).not.toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("saves all three fields in one PUT to the notification section", async () => {
    const bodies = capturePut();
    const user = userEvent.setup();
    renderForm();

    await screen.findByRole("button", { name: /save/i });
    await user.type(senderInput(), "sender@example.com");
    await user.click(snsToggle());
    await user.click(saveButton());

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      emailFrom: "sender@example.com",
      sesEnabled: true,
      snsIntegrationTopicEnabled: true,
      meta: { lastEditTime: mockAdminConfig.notification.meta?.lastEditTime },
    });
  });

  it("rejects a malformed sender client-side without calling the API", async () => {
    const bodies = capturePut();
    const user = userEvent.setup();
    renderForm();

    await screen.findByRole("button", { name: /save/i });
    await user.type(senderInput(), "not-an-email");

    // The zod resolver flags the field and SectionForm disables Save.
    await waitFor(() =>
      expect(saveButton()).toHaveAttribute("aria-disabled", "true"),
    );
    expect(bodies).toHaveLength(0);
  });

  it("maps a server-side sender error onto the sender field", async () => {
    server.use(
      configurationSectionValidationHandler([
        {
          field: "emailFrom",
          message: "Sender is not a verified SES identity.",
        },
      ]),
    );
    const user = userEvent.setup();
    renderForm();

    await screen.findByRole("button", { name: /save/i });
    await user.type(senderInput(), "unverified@example.com");
    await user.click(saveButton());

    expect(
      await screen.findByText("Sender is not a verified SES identity."),
    ).toBeInTheDocument();
  });

  it("saves the code defaults on a fresh install without edits", async () => {
    // Never saved: SES on, no sender, SNS off. Save stays enabled and persists
    // the defaults rather than demanding a sender the admin did not touch.
    const bodies = capturePut();
    const user = userEvent.setup();
    renderForm({ emailFrom: "", lastSavedBy: null, meta: undefined });

    await screen.findByRole("button", { name: /save/i });
    expect(
      screen.queryByRole("img", { name: /unreviewed/i }),
    ).not.toBeInTheDocument();
    expect(saveButton()).not.toHaveAttribute("aria-disabled", "true");
    await user.click(saveButton());

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      emailFrom: "",
      sesEnabled: true,
      snsIntegrationTopicEnabled: false,
    });
    await waitFor(() =>
      expect(saveButton()).toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("renders all values read-only for a manager", async () => {
    getCurrentUser.mockResolvedValue(managerUser);
    renderForm({ emailFrom: "current@example.com" });

    expect(
      await screen.findByText("Email from address (SES)"),
    ).toBeInTheDocument();
    const input = screen.getByLabelText("Email from address (SES)");
    expect(input).toHaveValue("current@example.com");
    expect(input).toHaveAttribute("readonly");
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    for (const toggle of screen.getAllByRole("checkbox"))
      expect(toggle).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(input, "changed@example.com");
    expect(input).toHaveValue("current@example.com");
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();
  });

  it("shows an empty read-only input when no sender is configured", async () => {
    getCurrentUser.mockResolvedValue(managerUser);
    renderForm({ emailFrom: "" });

    const input = await screen.findByLabelText("Email from address (SES)");
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveValue("");
  });
});
