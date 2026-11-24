// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Member parity between the configuration section schemas (Zod) and the Smithy
 * model. See `README.md` in this folder for what this guards, why nothing else
 * catches it, and when it can be deleted.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentModelUpsertBodySchema } from "@amzn/innovation-sandbox-commons/data/config/agent-model-catalog.js";
import {
  ConfigPutBodySchemas,
  ConfigSchemas,
  ConfigWriteSchemas,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";
import { CleanupValidationModeSchema } from "@amzn/innovation-sandbox-shared/types/sandbox-account.js";

import {
  alwaysPresentOnOutput,
  expectMemberTypeParity,
  modelEnum,
  modelMember,
  modelMembers,
  modelMemberSchema,
  modelRequired,
  requiredOnInput,
  zodComparableSchema,
  zodMembers,
} from "./parity-helpers.js";

// Section key -> generated Smithy structure name. This mapping is API design,
// not generic schema mechanics, so it remains explicit in the domain test.
const SECTIONS: Array<[keyof typeof ConfigSchemas, string]> = [
  ["leases", "Leases"],
  ["cleanup", "Cleanup"],
  ["notification", "Notification"],
  ["maintenance", "Maintenance"],
  ["termsOfService", "TermsOfService"],
  ["costReporting", "CostReporting"],
  ["agent", "Agent"],
];

function schemaShape(schema: unknown): Record<string, z.ZodType> {
  return (schema as { shape: Record<string, z.ZodType> }).shape;
}

describe.each(SECTIONS)("%s section", (section, shape) => {
  const responseShape = `${shape}Configuration`;
  const requestContent = `Update${shape}ConfigurationInput`;
  const readShape = schemaShape(ConfigSchemas[section]);
  const writeShape = schemaShape(ConfigWriteSchemas[section]);

  it("response structure declares the runtime fields plus the audit envelope", () => {
    // The audit envelope has no response Zod schema; keep those two model-only
    // members explicit while deriving every section field from production Zod.
    expect(modelMembers(responseShape)).toEqual(
      [...zodMembers(readShape), "lastSavedBy", "meta"].sort(),
    );
    const expectedRequired = alwaysPresentOnOutput(readShape);
    expect(modelRequired(responseShape)).toEqual(expectedRequired);
  });

  it("update request declares the runtime write fields plus concurrency metadata", () => {
    expect(modelMembers(requestContent)).toEqual(
      [...zodMembers(writeShape), "meta"].sort(),
    );
    const expectedRequired = requiredOnInput(writeShape);
    expect(modelRequired(requestContent)).toEqual(expectedRequired);
  });

  it("matches every section field's type on both the response and request", () => {
    // Guards a silent target-type change on a section field (e.g. an integer
    // becoming a string). Union members (e.g. notification.emailFrom) carry no
    // single canonical type and are skipped here — covered by the dedicated
    // email-branch test below.
    expectMemberTypeParity(responseShape, readShape);
    expectMemberTypeParity(requestContent, writeShape);
  });
});

describe("AdminConfiguration", () => {
  it("keeps its explicitly model-only aggregate fields stable", () => {
    // The deploy-time fields and aggregate response have TypeScript contracts,
    // but no runtime Zod schema. Do not create one solely for this test.
    expect(modelMembers("AdminConfiguration")).toEqual(
      [
        ...SECTIONS.map(([section]) => section),
        "isbManagedRegions",
        "awsAccessPortalUrl",
        "bedrockInferenceProfilePatterns",
      ].sort(),
    );
    expect(modelRequired("AdminConfiguration")).toEqual(
      modelMembers("AdminConfiguration"),
    );
  });
});

describe("metadata shapes", () => {
  it("keeps model-only response metadata stable", () => {
    // Response metadata is adapter-owned TypeScript, not a Zod schema. Keep
    // this explicit rather than adding production validation for the test.
    expect(modelMembers("ConfigurationResponseMetadata")).toEqual([
      "createdTime",
      "lastEditTime",
    ]);
    expect(modelRequired("ConfigurationResponseMetadata")).toEqual([
      "createdTime",
      "lastEditTime",
    ]);
  });

  it("derives write metadata from the production PUT schema", () => {
    const meta = ConfigPutBodySchemas.cleanup.shape.meta.unwrap();
    const metaShape = schemaShape(meta);

    expect(modelMembers("ConfigurationWriteMetadata")).toEqual(
      zodMembers(metaShape),
    );
    expect(modelRequired("ConfigurationWriteMetadata")).toEqual(
      requiredOnInput(metaShape),
    );
  });
});

const writeShapes = Object.fromEntries(
  Object.entries(ConfigWriteSchemas).map(([section, schema]) => [
    section,
    schemaShape(schema),
  ]),
) as Record<string, Record<string, z.ZodType>>;

// Structure and member names are the API mapping; expected constraints come
// from the effective production Zod field, not duplicated bound constants.
const CONSTRAINED_FIELDS: Array<
  [section: string, structure: string, field: string]
> = [
  ["leases", "LeasesConfiguration", "maxBudget"],
  ["leases", "LeasesConfiguration", "maxDurationHours"],
  ["leases", "LeasesConfiguration", "maxLeasesPerUser"],
  ["leases", "LeasesConfiguration", "ttl"],
  ["leases", "LeasesConfiguration", "leaseRequestWindowHours"],
  ["leases", "LeasesConfiguration", "maxLeaseRequestsPerWindow"],
  ["cleanup", "CleanupConfiguration", "numberOfFailedAttemptsToCancelCleanup"],
  ["cleanup", "CleanupConfiguration", "waitBeforeRetryFailedAttemptSeconds"],
  [
    "cleanup",
    "CleanupConfiguration",
    "numberOfSuccessfulAttemptsToFinishCleanup",
  ],
  [
    "cleanup",
    "CleanupConfiguration",
    "waitBeforeRerunSuccessfulAttemptSeconds",
  ],
  ["cleanup", "CleanupConfiguration", "cooldownPeriodHours"],
  ["cleanup", "CleanupConfiguration", "reportRetentionDays"],
  ["termsOfService", "TermsOfServiceConfiguration", "content"],
  ["costReporting", "CostReportingConfiguration", "costReportGroups"],
];

describe("field constraints match production Zod schemas", () => {
  it.each(CONSTRAINED_FIELDS)(
    "%s %s.%s mirrors its runtime constraint",
    (section, structure, field) => {
      expect(modelMemberSchema(structure, field)).toEqual(
        zodComparableSchema(writeShapes[section]![field]!),
      );
    },
  );

  it("models the constrained email branch accepted by the runtime union", () => {
    const emailFrom = writeShapes.notification!.emailFrom! as unknown as {
      options: z.ZodType[];
    };
    const constrainedEmail = emailFrom.options.find(
      (option) => zodComparableSchema(option).maxLength !== undefined,
    );

    expect(constrainedEmail).toBeDefined();
    expect(modelMemberSchema("NotificationConfiguration", "emailFrom")).toEqual(
      zodComparableSchema(constrainedEmail!),
    );
  });
});

describe("agent model catalog write", () => {
  it("accepts only the model ID, enabled state, OCC token, and model type", () => {
    expect(modelMembers("PutAgentModelCatalogEntryInput")).toEqual(
      ["modelId", "enabled", "expectedLastEditTime", "modelType"].sort(),
    );
    expect(modelRequired("PutAgentModelCatalogEntryInput")).toEqual([
      "enabled",
      "modelId",
    ]);
    expect(zodMembers(schemaShape(AgentModelUpsertBodySchema))).toEqual([
      "enabled",
      "expectedLastEditTime",
      "modelType",
    ]);
  });
});

describe("CleanupFailureAction", () => {
  it("matches the persisted cleanup validation modes", () => {
    expect(modelEnum("CleanupFailureAction")).toEqual(
      [...CleanupValidationModeSchema.options].sort(),
    );
  });
});

describe("accepted configuration model constraint deviations", () => {
  it("caps integers at int32 on the wire while Zod permits safe integers", () => {
    // Accepted: min-only integer fields (e.g. maxLeasesPerUser) are Smithy
    // `Integer` (int32, enforced by expectInt32), while the Zod field permits up
    // to Number.MAX_SAFE_INTEGER. The comparable-schema normalizer drops Zod's
    // safe-integer pseudo-maximum, so this is deliberately invisible to the bound
    // comparison and asserted here instead. Fails if either side changes: a Zod
    // maximum, or a wider Smithy numeric type.
    const field = writeShapes.leases!.maxLeasesPerUser!;
    expect(zodComparableSchema(field).maximum).toBeUndefined();
    expect(field.safeParse(2147483648).success).toBe(true);
    expect(modelMember("LeasesConfiguration", "maxLeasesPerUser").target).toBe(
      "smithy.api#Integer",
    );
  });

  it("accepts but omits lastSavedBy from the request model", () => {
    // Accepted: the raw PUT body (ConfigPutBodySchemas) tolerates lastSavedBy for
    // backward compatibility and strips it server-side; the Smithy request model
    // does not declare it. Fails if the body schema drops it or the model gains
    // it, forcing the deviation to be revisited.
    expect(ConfigPutBodySchemas.cleanup.shape.lastSavedBy).toBeDefined();
    expect(modelMembers("UpdateCleanupConfigurationInput")).not.toContain(
      "lastSavedBy",
    );
  });

  it("shares one write-metadata envelope across every section", () => {
    // The model has a single ConfigurationWriteMetadata shared by all sections;
    // the per-section metadata test derives from cleanup alone, so pin that the
    // other sections' raw-body meta shape is identical.
    const cleanupMeta = zodMembers(
      schemaShape(ConfigPutBodySchemas.cleanup.shape.meta.unwrap()),
    );
    for (const [section] of SECTIONS) {
      const meta = ConfigPutBodySchemas[section].shape.meta.unwrap();
      expect(zodMembers(schemaShape(meta)), `${section} meta envelope`).toEqual(
        cleanupMeta,
      );
    }
  });
});
