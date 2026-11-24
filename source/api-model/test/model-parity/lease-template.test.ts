// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Member parity between the `LeaseTemplate` persistence schema (Zod) and the
 * Smithy model. See `README.md` in this folder for what this guards, why nothing
 * else catches it, and when it can be deleted.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PersistedLeaseTemplateSchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  BudgetThresholdSchema,
  DurationThresholdSchema,
  LeaseTemplateWritableSchema,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";

import {
  alwaysPresentOnOutput,
  expectMemberTypeParity,
  modelMember,
  modelMembers,
  modelMemberTrait,
  modelQueryParameters,
  modelRequired,
  modelShape,
  requiredOnInput,
  zodMembers,
} from "./parity-helpers.js";

const createRequestShape = LeaseTemplateWritableSchema.shape as Record<
  string,
  z.ZodType
>;

const updateRequestShape = PersistedLeaseTemplateSchema.omit({
  uuid: true,
  createdBy: true,
  blueprintName: true,
}).shape as Record<string, z.ZodType>;

const leaseTemplateShape = PersistedLeaseTemplateSchema.shape as Record<
  string,
  z.ZodType
>;

const rawPermissionProfileMembers = new Set([
  "defaultPermissionSetArn",
  "allowedPermissionSetArns",
]);
const leaseTemplateResponsePersistenceShape = Object.fromEntries(
  Object.entries(leaseTemplateShape).filter(
    ([member]) => !rawPermissionProfileMembers.has(member),
  ),
) as Record<string, z.ZodType>;
const hydratedTemplateProjectionMembers = [
  "defaultPermissionSet",
  "allowedPermissionSets",
] as const;
const additiveTemplateResponseMembers = [
  "sandboxSpacesEnabled",
  "allowedModelIds",
] as const;
const leaseTemplateRequiredResponsePersistenceShape = Object.fromEntries(
  Object.entries(leaseTemplateResponsePersistenceShape).filter(
    ([member]) =>
      !(additiveTemplateResponseMembers as readonly string[]).includes(member),
  ),
) as Record<string, z.ZodType>;
const leaseTemplateOutputMembers = [
  ...zodMembers(leaseTemplateResponsePersistenceShape),
  ...hydratedTemplateProjectionMembers,
].sort();

describe("LeaseTemplate", () => {
  it("declares public persistence-derived members plus hydrated response references", () => {
    expect(modelMembers("LeaseTemplate")).toEqual(leaseTemplateOutputMembers);
  });

  it("keeps hydrated and additive response members optional", () => {
    expect(modelRequired("LeaseTemplate")).toEqual(
      alwaysPresentOnOutput(leaseTemplateRequiredResponsePersistenceShape),
    );
    for (const member of [
      ...hydratedTemplateProjectionMembers,
      ...additiveTemplateResponseMembers,
    ]) {
      expect(modelRequired("LeaseTemplate")).not.toContain(member);
    }
  });

  it("matches every member's type and the visibility enum target", () => {
    // Guards against a silent target-type change (e.g. requiresApproval
    // Boolean -> String) that member-set + requiredness alone would miss.
    expectMemberTypeParity(
      "LeaseTemplate",
      leaseTemplateResponsePersistenceShape,
    );
    expect(modelMember("LeaseTemplate", "defaultPermissionSet").target).toBe(
      "com.amazon.isb#PermissionSetReference",
    );
    expect(modelMember("LeaseTemplate", "allowedPermissionSets").target).toBe(
      "com.amazon.isb#PermissionSetReferenceList",
    );
    expect(modelMember("LeaseTemplate", "visibility").target).toBe(
      "com.amazon.isb#Visibility",
    );
  });

  it("keeps ARN configuration on write inputs and hydrated references on output", () => {
    expect(modelMembers("LeaseTemplate")).not.toContain(
      "defaultPermissionSetArn",
    );
    expect(modelMembers("LeaseTemplate")).not.toContain(
      "allowedPermissionSetArns",
    );

    for (const structure of [
      "CreateLeaseTemplateInput",
      "UpdateLeaseTemplateInput",
    ]) {
      expect(modelRequired(structure)).not.toContain("defaultPermissionSetArn");
      expect(modelRequired(structure)).not.toContain(
        "allowedPermissionSetArns",
      );
      expect(
        modelMemberTrait(
          structure,
          "allowedPermissionSetArns",
          "smithy.api#length",
        ),
      ).toEqual({ max: 20 });
    }
    for (const structure of [
      "CreateLeaseTemplateInput",
      "UpdateLeaseTemplateInput",
    ]) {
      expect(modelMember(structure, "defaultPermissionSetArn").target).toBe(
        "com.amazon.isb#PermissionSetArn",
      );
      expect(modelMember(structure, "allowedPermissionSetArns").target).toBe(
        "com.amazon.isb#PermissionSetArnList",
      );
    }
    expect(modelShape("PermissionSetArnList").member?.target).toBe(
      "com.amazon.isb#PermissionSetArn",
    );
  });
});

describe("CreateLeaseTemplateInput", () => {
  it("declares the same members as the create request schema", () => {
    expect(modelMembers("CreateLeaseTemplateInput")).toEqual(
      zodMembers(createRequestShape),
    );
  });

  it("requires exactly the members the create request schema requires", () => {
    // Fewer than the response shape: `visibility` and `allowOwnerToShareLease`
    // are `.default()`, so a client may omit them.
    expect(modelRequired("CreateLeaseTemplateInput")).toEqual(
      requiredOnInput(createRequestShape),
    );
  });
});

describe("UpdateLeaseTemplateInput", () => {
  it("declares the update request members plus the path identifier", () => {
    expect(modelMembers("UpdateLeaseTemplateInput")).toEqual(
      [...zodMembers(updateRequestShape), "leaseTemplateId"].sort(),
    );
  });

  it("requires exactly the update request members and path identifier", () => {
    expect(modelRequired("UpdateLeaseTemplateInput")).toEqual(
      [...requiredOnInput(updateRequestShape), "leaseTemplateId"].sort(),
    );
  });

  it("matches every update request member's type", () => {
    expectMemberTypeParity("UpdateLeaseTemplateInput", updateRequestShape);
  });
});

describe("threshold shapes", () => {
  it.each([
    ["BudgetThreshold", BudgetThresholdSchema],
    ["DurationThreshold", DurationThresholdSchema],
  ])("%s matches its persistence schema", (name, schema) => {
    const shape = schema.shape as Record<string, z.ZodType>;
    expect(modelMembers(name as string)).toEqual(zodMembers(shape));
    expect(modelRequired(name as string)).toEqual(alwaysPresentOnOutput(shape));
    expectMemberTypeParity(name as string, shape);
    expect(modelMember(name as string, "action").target).toBe(
      "com.amazon.isb#ThresholdAction",
    );
  });
});

describe("ListLeaseTemplates query parameters", () => {
  // Model-only: there is no independent Zod request schema for pagination
  // (the DAO stores use maxResults for their own paging, not the API contract).
  // Pin the query bindings and bounds so a drift in the model fails here.
  it("binds pageIdentifier and a bounded maxResults", () => {
    const params = Object.fromEntries(
      modelQueryParameters("ListLeaseTemplates").map((p) => [p.name, p]),
    );
    expect(Object.keys(params).sort()).toEqual([
      "maxResults",
      "pageIdentifier",
    ]);
    expect(params.maxResults?.target).toBe("smithy.api#Integer");
    expect(
      modelMemberTrait(
        "ListLeaseTemplatesInput",
        "maxResults",
        "smithy.api#range",
      ),
    ).toEqual({ min: 1, max: 2000 });
  });
});

describe("Metadata", () => {
  it("declares the same members as the persisted metadata schema", () => {
    const meta = PersistedLeaseTemplateSchema.shape.meta;
    const inner = (meta as unknown as { unwrap(): z.ZodObject }).unwrap();

    expect(modelMembers("Metadata")).toEqual(
      zodMembers(inner.shape as Record<string, z.ZodType>),
    );
  });
});
