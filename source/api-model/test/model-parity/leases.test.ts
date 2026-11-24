// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Member parity between the lease persistence schemas (Zod) and the Smithy model.
 * See `README.md` for what this guards and the accepted-deviations pattern.
 *
 * The persisted `Lease` is a Zod discriminatedUnion (Pending / ApprovalDenied /
 * Monitored / Expired). Smithy cannot express per-variant requiredness, so the
 * wire `Lease` is modeled as the UNION of every variant's members with ONLY the
 * always-present intersection `@required` (the flattened-requiredness deviation).
 * These tests assert exactly that shape and document the deviation.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  PersistedApprovalDeniedLeaseSchema,
  PersistedExpiredLeaseSchema,
  PersistedMonitoredLeaseSchema,
  PersistedPendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { AssignmentSyncStatusSchema } from "@amzn/innovation-sandbox-commons/isb-services/lease-assignment/lease-assignment.types.js";
import {
  AllLeaseStatusSchema,
  DesiredAssignmentSchema,
  DesiredAssignmentWithDisplaySchema,
  LeaseLockIntentSchema,
  LeaseLockMetaSchema,
  LeaseResourceLockSchema,
  MAX_ASSIGNMENTS,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import { PermissionSetReferenceSchema } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

import {
  alwaysPresentOnOutput,
  expectMemberTypeParity,
  modelEnum,
  modelHttpOperation,
  modelMember,
  modelMembers,
  modelMemberTrait,
  modelOperationErrors,
  modelRequired,
  modelShape,
  zodMembers,
} from "./parity-helpers.js";

// The four Zod lease variants, in discriminatedUnion order.
const variantShapes = [
  PersistedPendingLeaseSchema.shape,
  PersistedApprovalDeniedLeaseSchema.shape,
  PersistedMonitoredLeaseSchema.shape,
  PersistedExpiredLeaseSchema.shape,
] as Record<string, z.ZodType>[];

// The flattened superset: the union of every variant's members. Later variants
// override earlier ones for shared members (e.g. `status`), matching how the
// Smithy superset carries one member per name.
const leaseSuperset: Record<string, z.ZodType> = Object.assign(
  {},
  ...variantShapes,
);

const additiveLeaseResponseMembers = new Set([
  "sandboxSpacesEnabled",
  "allowedModelIds",
]);

// The always-present intersection: members that every variant produces on output.
// This is the ONLY set the flattened `Lease` marks `@required`.
const requiredIntersection = variantShapes
  .map(alwaysPresentOnOutput)
  .reduce((acc, cur) => acc.filter((member) => cur.includes(member)))
  .filter((member) => !additiveLeaseResponseMembers.has(member));

const lockShape = LeaseResourceLockSchema.shape as Record<string, z.ZodType>;
const lockMetaShape = LeaseLockMetaSchema.shape as Record<string, z.ZodType>;
const desiredWithDisplayShape =
  DesiredAssignmentWithDisplaySchema.shape as Record<string, z.ZodType>;
const desiredShape = DesiredAssignmentSchema.shape as Record<string, z.ZodType>;

const permissionSetReferenceShape =
  PermissionSetReferenceSchema.shape as Record<string, z.ZodType>;

const rawPermissionProfileMembers = new Set([
  "defaultPermissionSetArn",
  "allowedPermissionSetArns",
]);
// Lifecycle bookkeeping the account lifecycle manager reads; never on the wire.
const persistenceOnlyMembers = new Set(["lifecycleDispatch"]);
const leaseResponsePersistenceShape = Object.fromEntries(
  Object.entries(leaseSuperset).filter(
    ([member]) =>
      !rawPermissionProfileMembers.has(member) &&
      !persistenceOnlyMembers.has(member),
  ),
) as Record<string, z.ZodType>;
const hydratedLeaseProjectionMembers = [
  "defaultPermissionSet",
  "allowedPermissionSets",
] as const;
const hydratedLeaseOutputMembers = [
  ...zodMembers(leaseResponsePersistenceShape),
  ...hydratedLeaseProjectionMembers,
].sort();

// The lease `meta` on the wire keeps the timestamps and drops `schemaVersion`.
const leaseMetaShape = (
  PersistedPendingLeaseSchema.shape.meta as unknown as { unwrap(): z.ZodObject }
).unwrap().shape as Record<string, z.ZodType>;

describe("Lease model parity", () => {
  it("Lease projects public persistence-derived members plus hydrated response references", () => {
    expect(modelMembers("Lease")).toEqual(hydratedLeaseOutputMembers);
  });

  it("Lease requires the non-additive always-present intersection (flattened requiredness)", () => {
    // Documents accepted deviation #1: status-conditional requiredness is lost;
    // only members present-and-required in ALL four variants stay `@required`.
    expect(modelRequired("Lease")).toEqual([...requiredIntersection].sort());
    // Pin the intersection so a schema change that widens/narrows it is caught.
    expect(modelRequired("Lease")).toEqual([
      "originalLeaseTemplateName",
      "originalLeaseTemplateUuid",
      "status",
      "userEmail",
      "uuid",
    ]);
  });

  it("matches every superset member's target type (guards silent type drift)", () => {
    // `approvedBy` is a Zod union (email | "AUTO_APPROVED") with no single
    // canonical type; the helper skips it, and it is modeled as an open String.
    // The nullable `blueprintId`/`blueprintName` also carry no comparable scalar
    // type and are skipped.
    expectMemberTypeParity("Lease", leaseResponsePersistenceShape);
  });

  it("LeaseWithId and SharedLease carry public persistence-derived members, hydrated references, and injected members", () => {
    expect(modelMembers("LeaseWithId")).toEqual(
      [...hydratedLeaseOutputMembers, "leaseId", "selectableModels"].sort(),
    );
    expect(modelMembers("SharedLease")).toEqual(
      [
        ...hydratedLeaseOutputMembers,
        "accessType",
        "leaseId",
        "selectableModels",
        "sourceGroupName",
      ].sort(),
    );
    expect(modelMember("LeaseWithId", "leaseId").target).toBe(
      "com.amazon.isb#LeaseId",
    );
    for (const structure of ["LeaseWithId", "SharedLease"]) {
      expect(modelMember(structure, "selectableModels").target).toBe(
        "com.amazon.isb#SelectableModelList",
      );
      expect(modelRequired(structure)).not.toContain("selectableModels");
    }
    expect(modelRequired("LeaseWithId")).toEqual(
      [...requiredIntersection, "leaseId"].sort(),
    );
    expect(modelRequired("SharedLease")).toEqual(
      [...requiredIntersection, "accessType", "leaseId"].sort(),
    );
  });

  it("omits raw ARN configuration and keeps hydrated and additive response members optional", () => {
    for (const structure of ["Lease", "LeaseWithId", "SharedLease"]) {
      expect(modelMembers(structure)).not.toContain("defaultPermissionSetArn");
      expect(modelMembers(structure)).not.toContain("allowedPermissionSetArns");
      expect(modelMember(structure, "defaultPermissionSet").target).toBe(
        "com.amazon.isb#PermissionSetReference",
      );
      expect(modelMember(structure, "allowedPermissionSets").target).toBe(
        "com.amazon.isb#PermissionSetReferenceList",
      );
      for (const member of [
        ...hydratedLeaseProjectionMembers,
        ...additiveLeaseResponseMembers,
      ]) {
        expect(modelRequired(structure)).not.toContain(member);
      }
    }
  });

  it("ttl is a Long, not an Integer (Unix epoch seconds cross the 32-bit ceiling)", () => {
    // Model-contract pin: `ttl` is a Unix-epoch-second timestamp that crosses the
    // signed 32-bit ceiling (2,147,483,647 → Jan 2038). A regression to `Integer`
    // would silently truncate/overflow valid persisted records; pin the target so
    // that cannot happen without failing this test. See leases.smithy deviation
    // note on `ttl` and the handler round-trip test in leases-handler.test.ts.
    expect(modelMember("Lease", "ttl").target).toBe("smithy.api#Long");
  });

  it("lease metadata carries the timestamps (schemaVersion dropped)", () => {
    // Accepted deviation #2, mirroring AccountMetadata.
    expect(modelMembers("LeaseMetadata")).toEqual(
      zodMembers(leaseMetaShape).filter((m) => m !== "schemaVersion"),
    );
  });
});

describe("LeaseResourceLock model parity", () => {
  it("mirrors the persisted lock shape", () => {
    expect(modelMembers("LeaseResourceLock")).toEqual(zodMembers(lockShape));
    expect(modelRequired("LeaseResourceLock")).toEqual(
      alwaysPresentOnOutput(lockShape),
    );
  });

  it("matches the lock's member target types (meta compared separately)", () => {
    // `meta` is a typed structure (LeaseLockMeta), covered by its own test below;
    // the timestamp members are raw String (deviation #3).
    expectMemberTypeParity(
      "LeaseResourceLock",
      LeaseResourceLockSchema.omit({ meta: true }).shape as Record<
        string,
        z.ZodType
      >,
    );
  });

  it("LeaseLockMeta mirrors the typed lock meta", () => {
    expect(modelMembers("LeaseLockMeta")).toEqual(zodMembers(lockMetaShape));
    expect(modelRequired("LeaseLockMeta")).toEqual(
      alwaysPresentOnOutput(lockMetaShape),
    );
    expect(modelMember("LeaseLockMeta", "intent").target).toBe(
      "com.amazon.isb#LeaseLockIntent",
    );
  });
});

describe("assignment shapes", () => {
  it("DesiredAssignmentWithDisplay mirrors the persisted desired assignment", () => {
    expect(modelMembers("DesiredAssignmentWithDisplay")).toEqual(
      zodMembers(desiredWithDisplayShape),
    );
    expect(modelRequired("DesiredAssignmentWithDisplay")).toEqual(
      alwaysPresentOnOutput(desiredWithDisplayShape),
    );
    expect(
      modelMember("DesiredAssignmentWithDisplay", "permissionSetArn").target,
    ).toBe("com.amazon.isb#PermissionSetArn");
    expect(
      modelMember("DesiredAssignmentWithDisplay", "principalType").target,
    ).toBe("com.amazon.isb#PrincipalType");
  });

  it("DesiredAssignment (request body) mirrors the caller-supplied shape", () => {
    expect(modelMembers("DesiredAssignment")).toEqual(zodMembers(desiredShape));
    expect(modelRequired("DesiredAssignment")).toEqual(
      alwaysPresentOnOutput(desiredShape),
    );
    expect(modelMember("DesiredAssignment", "permissionSetArn").target).toBe(
      "com.amazon.isb#PermissionSetArn",
    );
  });

  it("PermissionSetReference mirrors the backend-hydrated projection schema", () => {
    expect(modelMembers("PermissionSetReference")).toEqual(
      zodMembers(permissionSetReferenceShape),
    );
    expect(modelRequired("PermissionSetReference")).toEqual(
      alwaysPresentOnOutput(permissionSetReferenceShape),
    );
    expectMemberTypeParity(
      "PermissionSetReference",
      permissionSetReferenceShape,
    );
    expect(modelEnum("PermissionSetAvailability")).toEqual([
      "AVAILABLE",
      "UNAVAILABLE",
    ]);
  });

  it("pins the shared permission-set scalar constraints to the public IDC contract", () => {
    expect(modelShape("PermissionSetArn").traits).toMatchObject({
      "smithy.api#length": { min: 10, max: 1224 },
      "smithy.api#pattern":
        "^arn:aws(?:-[a-z]{1,5}){0,3}:sso:::permissionSet/(?:sso)?ins-[a-zA-Z0-9.-]{16}/ps-[a-zA-Z0-9./-]{16}$",
    });
    expect(modelShape("PermissionSetId").traits?.["smithy.api#pattern"]).toBe(
      "^ps-[a-zA-Z0-9./-]{16}$",
    );
    expect(modelShape("PermissionSetName").traits).toMatchObject({
      "smithy.api#length": { min: 1, max: 32 },
      "smithy.api#pattern": "^[a-zA-Z0-9_+=,.@-]+$",
    });
    expect(modelShape("PermissionSetDescription").traits).toMatchObject({
      "smithy.api#length": { min: 1, max: 700 },
      "smithy.api#pattern":
        "^[\\u0009\\u000a\\u000d\\u0020-\\u007e\\u00a1-\\u00ff]*$",
    });
    expect(modelShape("PermissionSetSessionDuration").traits).toMatchObject({
      "smithy.api#length": { min: 1, max: 100 },
      "smithy.api#pattern":
        "^-?P(?=\\d|T\\d)(?:(\\d+)Y)?(?:(\\d+)M)?(?:(\\d+)([DW]))?(?:T(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+(?:\\.\\d+)?)S)?)?$",
    });
  });
});

describe("assignment view shapes (TS-interface-only contracts, no Zod schema)", () => {
  // `AssignmentView` and `LeaseAssignmentsView` correspond to the TypeScript
  // interfaces in `common/isb-services/lease-assignment/lease-assignment.types.ts`
  // (`AssignmentView` / `LeaseAssignmentsView`), which have NO runtime Zod schema.
  // The expected member sets are therefore hardcoded here (not derived from a
  // schema); these guard Smithy-model drift only — a divergence between the TS
  // interface and the model would not be caught at runtime (see README).
  it("AssignmentView pins the reconciliation-row member set", () => {
    expect(modelMembers("AssignmentView")).toEqual([
      "addedBy",
      "addedDate",
      "assigneeEmail",
      "displayName",
      "isDesired",
      "isOwner",
      "permissionSet",
      "principalId",
      "principalType",
      "syncStatus",
    ]);
    expect(modelRequired("AssignmentView")).toEqual([
      "displayName",
      "isDesired",
      "isOwner",
      "permissionSet",
      "principalId",
      "principalType",
      "syncStatus",
    ]);
    expect(modelMember("AssignmentView", "permissionSet").target).toBe(
      "com.amazon.isb#PermissionSetReference",
    );
  });

  it("LeaseAssignmentsView pins the view-plus-operation member set", () => {
    expect(modelMembers("LeaseAssignmentsView")).toEqual([
      "assignments",
      "operationInProgress",
    ]);
    expect(modelRequired("LeaseAssignmentsView")).toEqual(["assignments"]);
  });
});

describe("assignments list-length cap ties to MAX_ASSIGNMENTS", () => {
  it("RequestLease and UpdateLeaseAssignments cap `assignments` at the total-assignment constant (20)", () => {
    // The model can cap the list length (`@length(max: 20)`) but not enforce the
    // cross-item distinctness rule (that is the Zod supplement). Pin the modeled
    // cap to the shared production constant so the two cannot silently diverge.
    expect(MAX_ASSIGNMENTS).toBe(20);
    expect(
      modelMemberTrait("RequestLeaseInput", "assignments", "smithy.api#length"),
    ).toEqual({ max: MAX_ASSIGNMENTS });
    expect(
      modelMemberTrait(
        "UpdateLeaseAssignmentsInput",
        "assignments",
        "smithy.api#length",
      ),
    ).toEqual({ max: MAX_ASSIGNMENTS });
  });
});

describe("lease enums", () => {
  it("LeaseStatus matches every production lease status", () => {
    expect(modelEnum("LeaseStatus")).toEqual(
      [...AllLeaseStatusSchema.options].sort(),
    );
  });

  it("LeaseLockIntent matches the production lock-intent enum", () => {
    expect(modelEnum("LeaseLockIntent")).toEqual(
      [...LeaseLockIntentSchema.options].sort(),
    );
  });

  it("AssignmentSyncStatus matches the production sync-status enum", () => {
    expect(modelEnum("AssignmentSyncStatus")).toEqual(
      [...AssignmentSyncStatusSchema.options].sort(),
    );
  });

  it("ReviewAction matches the Approve/Deny decision enum", () => {
    // TS-interface / handler-literal contract (no Zod enum schema); hardcoded.
    expect(modelEnum("ReviewAction")).toEqual(["Approve", "Deny"]);
  });

  it("SharedLeaseAccessType matches the direct/group access-path enum", () => {
    // The modeled enum is deliberately narrow (direct|group) — the server only
    // ever receives these two values (the query adapter narrows its accessType
    // parameter to direct|group). Hardcoded; no Zod enum schema.
    expect(modelEnum("SharedLeaseAccessType")).toEqual(["direct", "group"]);
  });
});

describe("lease operations", () => {
  it("RequestLease returns the lease WITHOUT a leaseId (201)", () => {
    expect(modelHttpOperation("RequestLease")).toEqual({
      method: "POST",
      uri: "/leases",
      code: 201,
    });
    // Body data is the flat `Lease` (no injected leaseId on the request path);
    // `UnfreezeLease` (with leaseId) proves the two output shapes really differ.
    expect(modelMember("RequestLeaseOutput", "data").target).toBe(
      "com.amazon.isb#Lease",
    );
    expect(modelMember("UnfreezeLeaseOutput", "data").target).toBe(
      "com.amazon.isb#LeaseWithId",
    );
  });

  it("UpdateLeaseAssignments is an accepted (202) PUT returning desiredCount", () => {
    expect(modelHttpOperation("UpdateLeaseAssignments")).toEqual({
      method: "PUT",
      uri: "/leases/{leaseId}/assignments",
      code: 202,
    });
    expect(modelMembers("UpdateLeaseAssignmentsResult")).toEqual([
      "desiredCount",
    ]);
    expect(modelRequired("UpdateLeaseAssignmentsResult")).toEqual([
      "desiredCount",
    ]);
  });

  it("the list operations carry the pre-Smithy pagination bounds", () => {
    expect(
      modelMemberTrait("ListLeasesInput", "maxResults", "smithy.api#range"),
    ).toEqual({ min: 1, max: 2000 });
    expect(
      modelMemberTrait(
        "ListSharedLeasesInput",
        "maxResults",
        "smithy.api#range",
      ),
    ).toEqual({ min: 1, max: 100 });
  });

  it("the list envelopes forward the store's optional error diagnostic", () => {
    // Model-only: pre-Smithy forwarded the raw store result, which can include a
    // top-level `error` string; kept byte-faithful. Each item carries a leaseId.
    expect(modelMembers("ListLeasesResult")).toEqual([
      "error",
      "nextPageIdentifier",
      "result",
    ]);
    expect(modelRequired("ListLeasesResult")).toEqual(["result"]);
    expect(modelMembers("ListSharedLeasesResult")).toEqual([
      "error",
      "nextPageIdentifier",
      "result",
    ]);
    expect(modelRequired("ListSharedLeasesResult")).toEqual(["result"]);
  });
  it("models lease profile edits and their narrowing conflict", () => {
    expect(modelMembers("UpdateLeaseInput")).toEqual(
      expect.arrayContaining([
        "defaultPermissionSetArn",
        "allowedPermissionSetArns",
      ]),
    );
    expect(modelRequired("UpdateLeaseInput")).not.toContain(
      "defaultPermissionSetArn",
    );
    expect(modelRequired("UpdateLeaseInput")).not.toContain(
      "allowedPermissionSetArns",
    );
    expect(
      modelMember("UpdateLeaseInput", "defaultPermissionSetArn").target,
    ).toBe("com.amazon.isb#PermissionSetArn");
    expect(
      modelMember("UpdateLeaseInput", "allowedPermissionSetArns").target,
    ).toBe("com.amazon.isb#PermissionSetArnList");
    expect(
      modelMemberTrait(
        "UpdateLeaseInput",
        "allowedPermissionSetArns",
        "smithy.api#length",
      ),
    ).toEqual({ max: 20 });
    expect(modelOperationErrors("UpdateLease")).toEqual([
      "ConflictError",
      "NotFoundError",
      "ValidationError",
    ]);
  });
});

describe("accepted Lease model constraint deviations", () => {
  it("data-null actions omit the data member (freeze/review/terminate)", () => {
    // Accepted: the pre-Smithy runtime body was `{status, data: null}`. Smithy
    // cannot model a member whose only value is null, so `data` is absent from the
    // model AND the restJson1 serializer drops the explicit `null` — the wire body
    // is `{status}`, the null is DROPPED (not restored), same as DeleteLeaseTemplate.
    for (const op of ["FreezeLease", "ReviewLease", "TerminateLease"]) {
      expect(
        modelMembers(`${op}Output`),
        `${op} keeps a status-only output`,
      ).toEqual(["status"]);
    }
  });

  it("approvedBy is modeled as an open String, not a closed enum/union", () => {
    // Accepted: the runtime value is `email | "AUTO_APPROVED"`, a union that no
    // single Smithy scalar or enum captures; modeled as String.
    expect(modelMember("Lease", "approvedBy").target).toBe("smithy.api#String");
  });

  it("all lease timestamps are raw String, not @timestamp (byte-faithful)", () => {
    // Accepted deviation #3.
    for (const member of [
      "startDate",
      "expirationDate",
      "lastCheckedDate",
      "endDate",
    ]) {
      expect(modelMember("Lease", member).target).toBe("smithy.api#String");
    }
    expect(modelMember("LeaseResourceLock", "expiresAt").target).toBe(
      "smithy.api#String",
    );
  });
});
