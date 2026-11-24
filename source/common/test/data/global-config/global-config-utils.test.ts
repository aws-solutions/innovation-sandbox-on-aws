// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  ValidationException,
  validateBudgetThresholdsBelowMaxSpend,
  validateLeaseCompliesWithGlobalConfig,
  validateLeaseTemplateCompliesWithGlobalConfig,
  validatePredictiveBudgetFields,
  validateSandboxSpacesFields,
} from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import { PersistedLeaseTemplateSchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  PersistedMonitoredLease,
  PersistedMonitoredLeaseSchema,
  PersistedPendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockGlobalConfig } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";

function template(fields: {
  maxSpend: number | undefined;
  leaseDurationInHours: number | undefined;
}) {
  return generateSchemaData(PersistedLeaseTemplateSchema, {
    predictiveBudgetEnabled: false,
    bedrockTokenMonitoringEnabled: false,
    allowOwnerToShareLease: false,
    sandboxSpacesEnabled: false,
    ...fields,
  });
}

function configRequiring() {
  const config = mockGlobalConfig();
  config.leases.maxBudget = 500;
  config.leases.maxDurationHours = 500;
  config.leases.requireMaxBudget = true;
  config.leases.requireMaxDuration = true;
  return config;
}

describe("validateLeaseTemplateCompliesWithGlobalConfig", () => {
  describe("create semantics (no previous provided)", () => {
    it("throws when a required max budget is missing", () => {
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          template({ maxSpend: undefined, leaseDurationInHours: 24 }),
          configRequiring(),
        ),
      ).toThrow(/max budget must be provided/i);
    });

    it("throws when a required duration is missing", () => {
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          template({ maxSpend: 50, leaseDurationInHours: undefined }),
          configRequiring(),
        ),
      ).toThrow(/duration must be provided/i);
    });
  });

  describe("update semantics (previous provided)", () => {
    it("allows editing other fields when required budget/duration are unchanged-missing", () => {
      // A template that predates the requirement: both fields absent, and the
      // update leaves them absent. Editing an unrelated field must be allowed.
      const previous = template({
        maxSpend: undefined,
        leaseDurationInHours: undefined,
      });
      const updated = template({
        maxSpend: undefined,
        leaseDurationInHours: undefined,
      });
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          updated,
          configRequiring(),
          { previous },
        ),
      ).not.toThrow();
    });

    it("still blocks clearing a previously-set required budget", () => {
      const previous = template({
        maxSpend: 100,
        leaseDurationInHours: undefined,
      });
      const updated = template({
        maxSpend: undefined,
        leaseDurationInHours: undefined,
      });
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          updated,
          configRequiring(),
          { previous },
        ),
      ).toThrow(/max budget must be provided/i);
    });

    it("still enforces the max-budget ceiling on update", () => {
      const previous = template({ maxSpend: 100, leaseDurationInHours: 24 });
      const updated = template({ maxSpend: 9999, leaseDurationInHours: 24 });
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          updated,
          configRequiring(),
          { previous },
        ),
      ).toThrow(ValidationException);
    });
  });

  describe("predictive budget feature gates", () => {
    function gateOffConfig() {
      const config = configRequiring();
      config.leases.allowPredictiveBudgetControls = false;
      config.leases.allowBedrockTokenMonitoring = false;
      return config;
    }

    function enabledTemplate() {
      return {
        ...template({ maxSpend: 50, leaseDurationInHours: 24 }),
        predictiveBudgetEnabled: true,
      };
    }

    it("blocks enabling on create while the gate is off", () => {
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          enabledTemplate(),
          gateOffConfig(),
        ),
      ).toThrow(/predictive budget controls is not available/i);
    });

    it("allows enabling while the gate is on", () => {
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          enabledTemplate(),
          configRequiring(),
        ),
      ).not.toThrow();
    });

    it("allows an unchanged already-enabled template while the gate is off", () => {
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          enabledTemplate(),
          gateOffConfig(),
          { previous: enabledTemplate() },
        ),
      ).not.toThrow();
    });

    it("allows switching off while the gate is off", () => {
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          template({ maxSpend: 50, leaseDurationInHours: 24 }),
          gateOffConfig(),
          { previous: enabledTemplate() },
        ),
      ).not.toThrow();
    });

    it("blocks enabling Bedrock token monitoring while its gate is off", () => {
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          {
            ...template({ maxSpend: 50, leaseDurationInHours: 24 }),
            bedrockTokenMonitoringEnabled: true,
          },
          gateOffConfig(),
        ),
      ).toThrow(/Bedrock token monitoring is not available/i);
    });

    describe("Bedrock token monitoring with template Sandbox Spaces", () => {
      function withSandboxSpaces(
        sandboxSpacesEnabled: boolean,
        bedrockTokenMonitoringEnabled: boolean,
      ) {
        return {
          ...template({ maxSpend: 50, leaseDurationInHours: 24 }),
          sandboxSpacesEnabled,
          bedrockTokenMonitoringEnabled,
        };
      }

      function monitoringGateOffConfig(sandboxSpacesEnabled: boolean) {
        const config = gateOffConfig();
        config.agent.sandboxSpacesEnabled = sandboxSpacesEnabled;
        return config;
      }

      it("allows enabling it while its gate is off when Sandbox Spaces is on globally", () => {
        expect(() =>
          validateLeaseTemplateCompliesWithGlobalConfig(
            withSandboxSpaces(true, true),
            monitoringGateOffConfig(true),
            { previous: withSandboxSpaces(false, false) },
          ),
        ).not.toThrow();
      });

      it("blocks a new template from enabling Sandbox Spaces while both are off globally", () => {
        expect(() =>
          validateLeaseTemplateCompliesWithGlobalConfig(
            withSandboxSpaces(true, true),
            monitoringGateOffConfig(false),
          ),
        ).toThrow(
          "Cannot enable sandboxSpacesEnabled because Sandbox Spaces is not available.",
        );
      });

      it("blocks turning template Sandbox Spaces on while both are off globally", () => {
        expect(() =>
          validateLeaseTemplateCompliesWithGlobalConfig(
            withSandboxSpaces(true, true),
            monitoringGateOffConfig(false),
            { previous: withSandboxSpaces(false, true) },
          ),
        ).toThrow(
          "Cannot enable sandboxSpacesEnabled because Sandbox Spaces is not available.",
        );
      });

      it("keeps it on a template that already has it while its gate and Sandbox Spaces are both off globally", () => {
        expect(() =>
          validateLeaseTemplateCompliesWithGlobalConfig(
            withSandboxSpaces(true, true),
            monitoringGateOffConfig(false),
            { previous: withSandboxSpaces(true, true) },
          ),
        ).not.toThrow();
      });

      it("blocks keeping it on when the save turns template Sandbox Spaces off while its gate is off", () => {
        expect(() =>
          validateLeaseTemplateCompliesWithGlobalConfig(
            withSandboxSpaces(false, true),
            monitoringGateOffConfig(true),
            { previous: withSandboxSpaces(true, true) },
          ),
        ).toThrow(/Bedrock token monitoring is not available/i);
      });

      it("keeps it on when the save turns template Sandbox Spaces off while its gate is on", () => {
        expect(() =>
          validateLeaseTemplateCompliesWithGlobalConfig(
            withSandboxSpaces(false, true),
            configRequiring(),
            { previous: withSandboxSpaces(true, true) },
          ),
        ).not.toThrow();
      });
    });
  });

  describe("lease sharing feature gate", () => {
    function sharingGateOffConfig() {
      const config = configRequiring();
      config.leases.leaseSharingEnabled = false;
      return config;
    }

    function sharingEnabledTemplate() {
      return {
        ...template({ maxSpend: 50, leaseDurationInHours: 24 }),
        allowOwnerToShareLease: true,
      };
    }

    it("blocks enabling sharing while the global gate is off", () => {
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          sharingEnabledTemplate(),
          sharingGateOffConfig(),
        ),
      ).toThrow(/lease sharing is not available/i);
    });

    it("allows an unchanged sharing-enabled template while the global gate is off", () => {
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          sharingEnabledTemplate(),
          sharingGateOffConfig(),
          { previous: sharingEnabledTemplate() },
        ),
      ).not.toThrow();
    });

    it("allows sharing to be switched off while the global gate is off", () => {
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          template({ maxSpend: 50, leaseDurationInHours: 24 }),
          sharingGateOffConfig(),
          { previous: sharingEnabledTemplate() },
        ),
      ).not.toThrow();
    });
  });
});

describe("validateLeaseCompliesWithGlobalConfig", () => {
  it("rejects a pending lease whose configured duration exceeds the global maximum", () => {
    const lease = generateSchemaData(PersistedPendingLeaseSchema, {
      allowOwnerToShareLease: false,
      maxSpend: 50,
      leaseDurationInHours: 24,
      sandboxSpacesEnabled: false,
    });
    const config = mockGlobalConfig();
    config.leases.maxBudget = 500;
    config.leases.maxDurationHours = 12;
    config.leases.requireMaxBudget = false;
    config.leases.requireMaxDuration = false;

    expect(() => validateLeaseCompliesWithGlobalConfig(lease, config)).toThrow(
      "Duration cannot be greater than the global max duration (12).",
    );
  });

  it("uses a pending lease's configured duration to detect an unchanged missing duration", () => {
    const previousWithoutDuration = generateSchemaData(
      PersistedPendingLeaseSchema,
      {
        allowOwnerToShareLease: false,
        maxSpend: 50,
        leaseDurationInHours: undefined,
        sandboxSpacesEnabled: false,
      },
    );
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      allowOwnerToShareLease: false,
      maxSpend: 50,
      startDate: "2026-10-01T00:00:00.000Z",
      expirationDate: undefined,
      sandboxSpacesEnabled: false,
    });
    const config = mockGlobalConfig();
    config.leases.maxBudget = 500;
    config.leases.maxDurationHours = 500;
    config.leases.requireMaxBudget = false;
    config.leases.requireMaxDuration = true;

    expect(() =>
      validateLeaseCompliesWithGlobalConfig(lease, config, {
        previous: previousWithoutDuration,
      }),
    ).not.toThrow();

    const previousWithDuration = {
      ...previousWithoutDuration,
      leaseDurationInHours: 24,
    };
    expect(() =>
      validateLeaseCompliesWithGlobalConfig(lease, config, {
        previous: previousWithDuration,
      }),
    ).toThrow(/A duration must be provided/);
  });

  it("allows an unchanged sharing-enabled lease while the global gate is off", () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      allowOwnerToShareLease: true,
      maxSpend: 50,
    });
    const config = mockGlobalConfig();
    config.leases.leaseSharingEnabled = false;
    config.leases.maxBudget = Number.MAX_SAFE_INTEGER;
    config.leases.maxDurationHours = Number.MAX_SAFE_INTEGER;
    config.leases.requireMaxBudget = false;
    config.leases.requireMaxDuration = false;

    expect(() =>
      validateLeaseCompliesWithGlobalConfig(lease, config, {
        previous: lease,
      }),
    ).not.toThrow();
  });
});

describe("validateLeaseCompliesWithGlobalConfig budget feature gates", () => {
  function lease(
    fields: Partial<
      Pick<
        PersistedMonitoredLease,
        | "predictiveBudgetEnabled"
        | "bedrockTokenMonitoringEnabled"
        | "sandboxSpacesEnabled"
      >
    >,
  ) {
    return generateSchemaData(PersistedMonitoredLeaseSchema, {
      allowOwnerToShareLease: false,
      maxSpend: 50,
      predictiveBudgetEnabled: false,
      bedrockTokenMonitoringEnabled: false,
      sandboxSpacesEnabled: false,
      ...fields,
    });
  }

  function gatesOff() {
    const config = mockGlobalConfig();
    config.leases.allowPredictiveBudgetControls = false;
    config.leases.allowBedrockTokenMonitoring = false;
    config.leases.maxBudget = Number.MAX_SAFE_INTEGER;
    config.leases.maxDurationHours = Number.MAX_SAFE_INTEGER;
    config.leases.requireMaxBudget = false;
    config.leases.requireMaxDuration = false;
    return config;
  }

  it.each([
    [
      "predictive budget controls",
      { predictiveBudgetEnabled: true },
      "Cannot enable predictiveBudgetEnabled because predictive budget controls is not available.",
    ],
    [
      "Bedrock token monitoring",
      { bedrockTokenMonitoringEnabled: true },
      "Cannot enable bedrockTokenMonitoringEnabled because Bedrock token monitoring is not available.",
    ],
  ])("blocks turning %s on while its gate is off", (_name, on, message) => {
    expect(() =>
      validateLeaseCompliesWithGlobalConfig(lease(on), gatesOff(), {
        previous: lease({}),
      }),
    ).toThrow(message);
  });

  it.each([
    ["kept on", true, true],
    ["switched off", true, false],
  ])(
    "allows both features %s while their gates are off",
    (_label, previous, current) => {
      const flags = (enabled: boolean) => ({
        predictiveBudgetEnabled: enabled,
        bedrockTokenMonitoringEnabled: enabled,
      });
      expect(() =>
        validateLeaseCompliesWithGlobalConfig(
          lease(flags(current)),
          gatesOff(),
          { previous: lease(flags(previous)) },
        ),
      ).not.toThrow();
    },
  );

  function gatesOffWithSandboxSpaces(sandboxSpacesEnabled: boolean) {
    const config = gatesOff();
    config.agent.sandboxSpacesEnabled = sandboxSpacesEnabled;
    return config;
  }

  it("allows turning Bedrock token monitoring on while its gate is off when Sandbox Spaces is turned on", () => {
    expect(() =>
      validateLeaseCompliesWithGlobalConfig(
        lease({
          bedrockTokenMonitoringEnabled: true,
          sandboxSpacesEnabled: true,
        }),
        gatesOffWithSandboxSpaces(true),
        { previous: lease({}) },
      ),
    ).not.toThrow();
  });

  it("blocks turning Sandbox Spaces on while it is off globally", () => {
    expect(() =>
      validateLeaseCompliesWithGlobalConfig(
        lease({
          bedrockTokenMonitoringEnabled: true,
          sandboxSpacesEnabled: true,
        }),
        gatesOffWithSandboxSpaces(false),
        { previous: lease({ bedrockTokenMonitoringEnabled: true }) },
      ),
    ).toThrow(
      "Cannot enable sandboxSpacesEnabled because Sandbox Spaces is not available.",
    );
  });

  it("keeps Sandbox Spaces and monitoring on a lease that already has them while both are off globally", () => {
    const using = lease({
      bedrockTokenMonitoringEnabled: true,
      sandboxSpacesEnabled: true,
    });
    expect(() =>
      validateLeaseCompliesWithGlobalConfig(
        using,
        gatesOffWithSandboxSpaces(false),
        { previous: using },
      ),
    ).not.toThrow();
  });

  it.each([
    ["blocks", false],
    ["allows", true],
  ])(
    "%s keeping monitoring on when Sandbox Spaces is turned off, by the monitoring gate",
    (_verb, allowBedrockTokenMonitoring) => {
      const config = gatesOffWithSandboxSpaces(true);
      config.leases.allowBedrockTokenMonitoring = allowBedrockTokenMonitoring;
      const validate = () =>
        validateLeaseCompliesWithGlobalConfig(
          lease({ bedrockTokenMonitoringEnabled: true }),
          config,
          {
            previous: lease({
              bedrockTokenMonitoringEnabled: true,
              sandboxSpacesEnabled: true,
            }),
          },
        );
      if (allowBedrockTokenMonitoring) {
        expect(validate).not.toThrow();
      } else {
        expect(validate).toThrow(
          "Cannot enable bedrockTokenMonitoringEnabled because Bedrock token monitoring is not available.",
        );
      }
    },
  );
});

describe("validatePredictiveBudgetFields", () => {
  const predictedThreshold = {
    dollarsSpent: 25,
    action: "FREEZE_ACCOUNT" as const,
    triggerOn: "PREDICTED" as const,
  };

  it.each([false, undefined])(
    "rejects a PREDICTED threshold when predictiveBudgetEnabled is %s",
    (predictiveBudgetEnabled) => {
      expect(() =>
        validatePredictiveBudgetFields({
          predictiveBudgetEnabled,
          budgetThresholds: [
            { dollarsSpent: 10, action: "ALERT" },
            predictedThreshold,
          ],
        }),
      ).toThrow(
        "triggerOn PREDICTED is only supported when predictiveBudgetEnabled is true.",
      );
    },
  );

  it("allows reported thresholds when predictive budget controls are off", () => {
    expect(() =>
      validatePredictiveBudgetFields({
        predictiveBudgetEnabled: false,
        budgetThresholds: [
          { dollarsSpent: 10, action: "ALERT" },
          { dollarsSpent: 20, action: "FREEZE_ACCOUNT", triggerOn: "REPORTED" },
        ],
      }),
    ).not.toThrow();
  });

  it("allows a PREDICTED threshold when predictive budget controls are on", () => {
    expect(() =>
      validatePredictiveBudgetFields({
        predictiveBudgetEnabled: true,
        budgetThresholds: [predictedThreshold],
      }),
    ).not.toThrow();
  });
});

describe("validateBudgetThresholdsBelowMaxSpend", () => {
  it.each([
    ["equal to", 100],
    ["above", 100.01],
  ])("rejects a threshold %s maxSpend", (_label, dollarsSpent) => {
    expect(() =>
      validateBudgetThresholdsBelowMaxSpend({
        maxSpend: 100,
        budgetThresholds: [
          { dollarsSpent: 50, action: "ALERT" },
          { dollarsSpent, action: "FREEZE_ACCOUNT", triggerOn: "PREDICTED" },
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        name: "ValidationException",
        field: "budgetThresholds",
        message:
          "Every budget threshold dollarsSpent must be less than maxSpend (100).",
      }),
    );
  });

  it("allows thresholds below maxSpend", () => {
    expect(() =>
      validateBudgetThresholdsBelowMaxSpend({
        maxSpend: 100,
        budgetThresholds: [
          { dollarsSpent: 50, action: "ALERT" },
          { dollarsSpent: 99.99, action: "FREEZE_ACCOUNT" },
        ],
      }),
    ).not.toThrow();
  });

  describe("with a previous record", () => {
    const previous = {
      maxSpend: 100,
      budgetThresholds: [{ dollarsSpent: 100, action: "ALERT" as const }],
    };

    it("allows unchanged amounts that break the rule", () => {
      expect(() =>
        validateBudgetThresholdsBelowMaxSpend(
          {
            maxSpend: 100,
            budgetThresholds: [{ dollarsSpent: 100, action: "FREEZE_ACCOUNT" }],
          },
          { previous },
        ),
      ).not.toThrow();
    });

    it.each([
      [
        "a changed maxSpend",
        { maxSpend: 90, budgetThresholds: previous.budgetThresholds },
      ],
      [
        "a changed threshold amount",
        {
          maxSpend: 100,
          budgetThresholds: [{ dollarsSpent: 120, action: "ALERT" as const }],
        },
      ],
      [
        "an added threshold",
        {
          maxSpend: 100,
          budgetThresholds: [
            ...previous.budgetThresholds,
            { dollarsSpent: 50, action: "ALERT" as const },
          ],
        },
      ],
      [
        "a removed threshold",
        {
          maxSpend: 100,
          budgetThresholds: [{ dollarsSpent: 100, action: "ALERT" as const }],
        },
        {
          maxSpend: 100,
          budgetThresholds: [
            { dollarsSpent: 100, action: "ALERT" as const },
            { dollarsSpent: 50, action: "ALERT" as const },
          ],
        },
      ],
    ])("checks %s", (_label, budget, previousBudget = previous) => {
      expect(() =>
        validateBudgetThresholdsBelowMaxSpend(budget, {
          previous: previousBudget,
        }),
      ).toThrow(ValidationException);
    });
  });

  it("allows any threshold when maxSpend is not set", () => {
    expect(() =>
      validateBudgetThresholdsBelowMaxSpend({
        maxSpend: undefined,
        budgetThresholds: [{ dollarsSpent: 1000, action: "ALERT" }],
      }),
    ).not.toThrow();
  });
});

describe("validateSandboxSpacesFields", () => {
  it.each([false, undefined])(
    "rejects Sandbox Spaces when bedrockTokenMonitoringEnabled is %s",
    (bedrockTokenMonitoringEnabled) => {
      expect(() =>
        validateSandboxSpacesFields({
          sandboxSpacesEnabled: true,
          bedrockTokenMonitoringEnabled,
        }),
      ).toThrow(
        expect.objectContaining({
          name: "ValidationException",
          field: "sandboxSpacesEnabled",
          message:
            "Sandbox Spaces requires Bedrock token monitoring. Set bedrockTokenMonitoringEnabled to true to enable Sandbox Spaces.",
        }),
      );
    },
  );

  it("allows Sandbox Spaces with Bedrock token monitoring", () => {
    expect(() =>
      validateSandboxSpacesFields({
        sandboxSpacesEnabled: true,
        bedrockTokenMonitoringEnabled: true,
      }),
    ).not.toThrow();
  });

  it.each([false, true])(
    "allows disabled Sandbox Spaces when bedrockTokenMonitoringEnabled is %s",
    (bedrockTokenMonitoringEnabled) => {
      expect(() =>
        validateSandboxSpacesFields({
          sandboxSpacesEnabled: false,
          bedrockTokenMonitoringEnabled,
        }),
      ).not.toThrow();
    },
  );
});
