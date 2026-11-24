// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type LeaseTemplateView,
  LeaseTemplateViewSchema,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/model";
import { generateSchemaData } from "@amzn/innovation-sandbox-shared/test/generate-schema-data.js";

function defaultLeaseTemplate(
  overrides?: Partial<LeaseTemplateView>,
): LeaseTemplateView {
  return generateSchemaData(LeaseTemplateViewSchema, {
    rateLimits: undefined,
    predictiveBudgetEnabled: false,
    bedrockTokenMonitoringEnabled: false,
    sandboxSpacesEnabled: false,
    requiresApproval: false,
    maxSpend: 100,
    leaseDurationInHours: 48,
    costReportGroup: "default-group",
    defaultPermissionSet: undefined,
    allowedPermissionSets: undefined,
    ...overrides,
  });
}

export function createLeaseTemplate(
  overrides?: Partial<LeaseTemplateView>,
): LeaseTemplateView {
  return defaultLeaseTemplate(overrides);
}

export function createAdvancedLeaseTemplate(
  overrides?: Partial<LeaseTemplateView>,
): LeaseTemplateView {
  return defaultLeaseTemplate({
    requiresApproval: true,
    maxSpend: 500,
    leaseDurationInHours: 72,
    budgetThresholds: [{ dollarsSpent: 250, action: "ALERT" }],
    durationThresholds: [{ hoursRemaining: 24, action: "ALERT" }],
    ...overrides,
  });
}
