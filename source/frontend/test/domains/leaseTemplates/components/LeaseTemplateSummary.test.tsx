// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { LeaseTemplateSummary } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/LeaseTemplateSummary";
import { SANDBOX_SPACES_CONSTRAINTS } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/validation";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createAdvancedLeaseTemplate } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseTemplateFactory";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

// The summary reads the full catalog (GET /configurations/agent/models); the
// adapter drops rows without `meta`, so every fixture row carries one.
function catalogRow(modelId: string, displayName: string, enabled: boolean) {
  return {
    modelId,
    displayName,
    provider: "Anthropic",
    availability: "global",
    enabled,
    addedAt: "2026-09-01T12:00:00.000Z",
    lastSavedBy: "admin@example.com",
    meta: {
      createdTime: "2026-01-01T00:00:00.000Z",
      lastEditTime: "2026-09-01T12:00:00.000Z",
    },
  };
}

function mockCatalog(models: ReturnType<typeof catalogRow>[]) {
  server.use(
    http.get(`${getConfig().ApiUrl}/configurations/agent/models`, () =>
      HttpResponse.json({ status: "success", data: { models } }),
    ),
  );
}

describe("LeaseTemplateSummary predictive budget read view", () => {
  it("shows the opt-ins as disabled and rate limits as not set on a template without the feature", () => {
    // Pin sharing and Sandbox Spaces off so their Enabled/Disabled indicators
    // are deterministic (the factory otherwise randomizes sandboxSpacesEnabled).
    renderWithQueryClient(
      <LeaseTemplateSummary
        leaseTemplate={createAdvancedLeaseTemplate({
          allowOwnerToShareLease: false,
          sandboxSpacesEnabled: false,
        })}
      />,
    );

    expect(screen.getByText("Estimated cost tracking")).toBeInTheDocument();
    expect(
      screen.getByText("Amazon Bedrock token monitoring"),
    ).toBeInTheDocument();
    expect(screen.getByText("Spend rate thresholds")).toBeInTheDocument();
    // Two feature rows, the sharing indicator, and the Sandbox Spaces indicator.
    expect(screen.getAllByText("Disabled")).toHaveLength(4);
    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.getByText("Cost basis")).toBeInTheDocument();
    expect(screen.getByText("Reported cost")).toBeInTheDocument();
  });

  it("shows the stored monitoring value with the required notice when Sandbox Spaces is enabled", () => {
    renderWithQueryClient(
      <LeaseTemplateSummary
        leaseTemplate={createAdvancedLeaseTemplate({
          allowOwnerToShareLease: false,
          sandboxSpacesEnabled: true,
          bedrockTokenMonitoringEnabled: false,
        })}
        sandboxSpacesEnabled
      />,
    );

    // Only Sandbox Spaces is enabled; monitoring shows its stored value.
    expect(screen.getAllByText("Enabled")).toHaveLength(1);
    expect(
      screen.getByText("Bedrock token monitoring required"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Bedrock token monitoring is required while Sandbox Spaces is enabled for this template.",
      ),
    ).toBeInTheDocument();
  });

  it("shows no monitoring-required notice when Sandbox Spaces is disabled", () => {
    renderWithQueryClient(
      <LeaseTemplateSummary
        leaseTemplate={createAdvancedLeaseTemplate({
          sandboxSpacesEnabled: false,
          bedrockTokenMonitoringEnabled: false,
        })}
        sandboxSpacesEnabled
      />,
    );

    expect(
      screen.queryByText("Bedrock token monitoring required"),
    ).not.toBeInTheDocument();
  });

  it("shows enabled opt-ins, formatted rate caps, and per-threshold triggers on an opted-in template", () => {
    const leaseTemplate = createAdvancedLeaseTemplate({
      allowOwnerToShareLease: false,
      sandboxSpacesEnabled: false,
      predictiveBudgetEnabled: true,
      bedrockTokenMonitoringEnabled: true,
      rateLimits: [
        { basis: "HOURLY", rate: 2.5, action: "ALERT" },
        { basis: "DAILY", rate: 40, action: "ALERT" },
      ],
      budgetThresholds: [
        { dollarsSpent: 50, action: "ALERT", triggerOn: "PREDICTED" },
        { dollarsSpent: 75, action: "ALERT" },
      ],
    });

    renderWithQueryClient(
      <LeaseTemplateSummary leaseTemplate={leaseTemplate} />,
    );

    expect(screen.getAllByText("Enabled")).toHaveLength(2);
    expect(
      screen.getByText("$2.50/hour (Send alert), $40.00/day (Send alert)"),
    ).toBeInTheDocument();
    // A PREDICTED threshold is labelled as such; one without triggerOn reads
    // as reported cost.
    expect(screen.getByText("Estimated cost")).toBeInTheDocument();
    expect(screen.getByText("Reported cost")).toBeInTheDocument();
  });

  it("still labels a stored PREDICTED threshold when predictive controls were switched off", () => {
    // A template can be switched off without its thresholds being rewritten;
    // the stored PREDICTED trigger must stay visible, not read as reported.
    const leaseTemplate = createAdvancedLeaseTemplate({
      allowOwnerToShareLease: false,
      predictiveBudgetEnabled: false,
      budgetThresholds: [
        { dollarsSpent: 50, action: "ALERT", triggerOn: "PREDICTED" },
      ],
    });

    renderWithQueryClient(
      <LeaseTemplateSummary leaseTemplate={leaseTemplate} />,
    );

    expect(screen.getByText("Cost basis")).toBeInTheDocument();
    expect(screen.getByText("Estimated cost")).toBeInTheDocument();
  });

  it("shows only the configured cap when a single rate limit is set", () => {
    const leaseTemplate = createAdvancedLeaseTemplate({
      predictiveBudgetEnabled: true,
      rateLimits: [{ basis: "HOURLY", rate: 5, action: "ALERT" }],
    });

    renderWithQueryClient(
      <LeaseTemplateSummary leaseTemplate={leaseTemplate} />,
    );

    expect(screen.getByText("$5.00/hour (Send alert)")).toBeInTheDocument();
  });

  it("shows no rate limits when the template has no rateLimits list", () => {
    const leaseTemplate = createAdvancedLeaseTemplate({
      predictiveBudgetEnabled: true,
      rateLimits: undefined,
    });

    renderWithQueryClient(
      <LeaseTemplateSummary leaseTemplate={leaseTemplate} />,
    );

    expect(screen.getByText("Spend rate thresholds")).toBeInTheDocument();
    expect(screen.queryByText(/\/hour|\/day/)).not.toBeInTheDocument();
  });

  it("shows every configured rate limit with its action", () => {
    const leaseTemplate = createAdvancedLeaseTemplate({
      predictiveBudgetEnabled: true,
      rateLimits: [
        { basis: "HOURLY", rate: 10, action: "ALERT" },
        { basis: "HOURLY", rate: 15, action: "FREEZE_ACCOUNT" },
      ],
    });

    renderWithQueryClient(
      <LeaseTemplateSummary leaseTemplate={leaseTemplate} />,
    );

    expect(
      screen.getByText("$10.00/hour (Send alert), $15.00/hour (Freeze lease)"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\$5\.00\/hour/)).not.toBeInTheDocument();
  });

  it("shows allowed models by friendly display name, not raw model id", async () => {
    // Matches the SandboxSpacesForm picker, which labels options by displayName.
    mockCatalog([
      catalogRow("anthropic.claude-3-sonnet", "Claude 3 Sonnet", true),
    ]);

    renderWithQueryClient(
      <LeaseTemplateSummary
        leaseTemplate={createAdvancedLeaseTemplate({
          sandboxSpacesEnabled: true,
          allowedModelIds: ["anthropic.claude-3-sonnet"],
          defaultModelId: undefined,
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Claude 3 Sonnet")).toBeInTheDocument();
    });
    expect(
      screen.queryByText("anthropic.claude-3-sonnet"),
    ).not.toBeInTheDocument();
  });

  it("falls back to the raw model id when it is not in the catalog", async () => {
    mockCatalog([]);

    renderWithQueryClient(
      <LeaseTemplateSummary
        leaseTemplate={createAdvancedLeaseTemplate({
          sandboxSpacesEnabled: true,
          allowedModelIds: ["some.unlisted-model"],
          defaultModelId: undefined,
        })}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          SANDBOX_SPACES_CONSTRAINTS.SELECTED_MODELS_DISABLED([
            "some.unlisted-model",
          ]),
        ),
      ).toBeInTheDocument();
    });
  });

  it("shows hydrated permission-set names and descriptions instead of ARNs", () => {
    const defaultPermissionSet = {
      permissionSetArn:
        "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
      permissionSetId: "ps-0123456789abcdef",
      name: "DeveloperAccess",
      description: "Developer sandbox access",
      availability: "AVAILABLE" as const,
    };
    const additionalPermissionSet = {
      permissionSetArn:
        "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1123456789abcdef",
      permissionSetId: "ps-1123456789abcdef",
      name: "AuditorAccess",
      description: "Read-only sandbox access",
      availability: "AVAILABLE" as const,
    };
    const leaseTemplate = {
      ...createAdvancedLeaseTemplate({
        sandboxSpacesEnabled: false,
      }),
      defaultPermissionSet,
      allowedPermissionSets: [defaultPermissionSet, additionalPermissionSet],
    };

    renderWithQueryClient(
      <LeaseTemplateSummary leaseTemplate={leaseTemplate} />,
    );

    expect(screen.getByText("Access and sharing")).toBeInTheDocument();
    expect(screen.getByText("Permission sets")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Description" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Role" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("DeveloperAccess")).toBeInTheDocument();
    expect(screen.getByText("Developer sandbox access")).toBeInTheDocument();
    expect(screen.getByText("AuditorAccess")).toBeInTheDocument();
    expect(screen.getByText("Read-only sandbox access")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.queryByText("Allowed")).not.toBeInTheDocument();
    expect(
      screen.queryByText(defaultPermissionSet.permissionSetArn),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(additionalPermissionSet.permissionSetArn),
    ).not.toBeInTheDocument();
  });

  it("shows the built-in default for a zero-configuration template", () => {
    renderWithQueryClient(
      <LeaseTemplateSummary
        leaseTemplate={createAdvancedLeaseTemplate({
          sandboxSpacesEnabled: false,
        })}
      />,
    );

    expect(screen.getByText("Full sandbox access")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("renders the unavailable state from a hydrated reference", () => {
    const unavailablePermissionSet = {
      permissionSetArn:
        "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
      permissionSetId: "ps-0123456789abcdef",
      availability: "UNAVAILABLE" as const,
    };
    renderWithQueryClient(
      <LeaseTemplateSummary
        leaseTemplate={{
          ...createAdvancedLeaseTemplate({ sandboxSpacesEnabled: false }),
          defaultPermissionSet: unavailablePermissionSet,
          allowedPermissionSets: [unavailablePermissionSet],
        }}
      />,
    );

    expect(
      screen.getByText(unavailablePermissionSet.permissionSetArn),
    ).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });

  describe("allowed models", () => {
    it("lists enabled models and names the disabled ones apart", async () => {
      mockCatalog([
        catalogRow("anthropic.claude-3-sonnet", "Claude 3 Sonnet", true),
        catalogRow("anthropic.claude-3-haiku", "Claude 3 Haiku", false),
        catalogRow("anthropic.claude-3-opus", "Claude 3 Opus", false),
      ]);

      renderWithQueryClient(
        <LeaseTemplateSummary
          leaseTemplate={createAdvancedLeaseTemplate({
            sandboxSpacesEnabled: true,
            allowedModelIds: [
              "anthropic.claude-3-sonnet",
              "anthropic.claude-3-haiku",
              "anthropic.claude-3-opus",
            ],
            defaultModelId: undefined,
          })}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByText(
            SANDBOX_SPACES_CONSTRAINTS.SELECTED_MODELS_DISABLED([
              "Claude 3 Haiku",
              "Claude 3 Opus",
            ]),
          ),
        ).toBeInTheDocument();
      });
      expect(screen.getByText("Claude 3 Sonnet")).toBeInTheDocument();
    });

    it("shows no disabled list when every selected model is enabled", async () => {
      mockCatalog([
        catalogRow("anthropic.claude-3-sonnet", "Claude 3 Sonnet", true),
        catalogRow("anthropic.claude-3-haiku", "Claude 3 Haiku", true),
      ]);

      renderWithQueryClient(
        <LeaseTemplateSummary
          leaseTemplate={createAdvancedLeaseTemplate({
            sandboxSpacesEnabled: true,
            allowedModelIds: [
              "anthropic.claude-3-sonnet",
              "anthropic.claude-3-haiku",
            ],
            defaultModelId: undefined,
          })}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByText("Claude 3 Sonnet, Claude 3 Haiku"),
        ).toBeInTheDocument();
      });
      expect(screen.queryByText(/^Disabled models:/)).not.toBeInTheDocument();
    });
  });

  describe("default model", () => {
    it("names an enabled default", async () => {
      mockCatalog([
        catalogRow("anthropic.claude-3-sonnet", "Claude 3 Sonnet", true),
      ]);

      renderWithQueryClient(
        <LeaseTemplateSummary
          leaseTemplate={createAdvancedLeaseTemplate({
            sandboxSpacesEnabled: true,
            allowedModelIds: ["anthropic.claude-3-sonnet"],
            defaultModelId: "anthropic.claude-3-sonnet",
          })}
        />,
      );

      // Both the allowed list and the default row name the same model.
      await waitFor(() => {
        expect(screen.getAllByText("Claude 3 Sonnet")).toHaveLength(2);
      });
      expect(
        screen.queryByText(
          SANDBOX_SPACES_CONSTRAINTS.DEFAULT_MODEL_DISABLED_HINT,
        ),
      ).not.toBeInTheDocument();
    });

    it("names a default that has been disabled in the catalog and warns", async () => {
      mockCatalog([
        catalogRow("anthropic.claude-3-sonnet", "Claude 3 Sonnet", false),
      ]);

      renderWithQueryClient(
        <LeaseTemplateSummary
          leaseTemplate={createAdvancedLeaseTemplate({
            sandboxSpacesEnabled: true,
            allowedModelIds: ["anthropic.claude-3-sonnet"],
            defaultModelId: "anthropic.claude-3-sonnet",
          })}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByText(
            SANDBOX_SPACES_CONSTRAINTS.DEFAULT_MODEL_DISABLED(
              "Claude 3 Sonnet",
            ),
          ),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByText(
          SANDBOX_SPACES_CONSTRAINTS.DEFAULT_MODEL_DISABLED_HINT,
        ),
      ).toBeInTheDocument();
    });

    it("shows no default when the template has none", async () => {
      mockCatalog([]);

      renderWithQueryClient(
        <LeaseTemplateSummary
          leaseTemplate={createAdvancedLeaseTemplate({
            sandboxSpacesEnabled: true,
            allowedModelIds: [],
            defaultModelId: undefined,
            // A configured rate limit keeps the spend-rate row from also
            // reading "Not set", so the assertion below is the default row.
            predictiveBudgetEnabled: true,
            rateLimits: [{ basis: "HOURLY", rate: 5, action: "ALERT" }],
          })}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Not set")).toBeInTheDocument();
      });
    });
  });
});
