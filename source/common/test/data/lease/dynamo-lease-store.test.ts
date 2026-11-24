// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ZodError } from "zod";

import {
  base64EncodeCompositeKey,
  InvalidPageIdentifierError,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  BatchUnprocessedItemsError,
  ConcurrentDataModificationException,
  ResourceLockConflictError,
  UnknownItem,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import { LeaseAssignmentWriteSnapshot } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import {
  PersistedMonitoredLeaseSchema,
  PersistedPendingLeaseSchema,
  type PersistedMonitoredLease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { LeaseKey } from "@amzn/innovation-sandbox-shared/types/lease.js";

import { randomUUID } from "node:crypto";

const mockDynamoClient = mockClient(DynamoDBDocumentClient);

const NOW = "2024-06-01T12:00:00.000Z";
const TABLE_NAME = "test-lease-table";
const USER_EMAIL = "user@example.com";
const LEASE_ID = "550e8400-e29b-41d4-a716-446655440000";
const OWNER_ID = "owner-1";
const PROFILE_A =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-aaaaaaaaaaaaaaaa";
const PROFILE_B =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-bbbbbbbbbbbbbbbb";

const conditionalCheckFailed = new ConditionalCheckFailedException({
  message: "The conditional request failed",
  $metadata: {},
});

/**
 * Applies a SET-only UpdateExpression to a plain object the way DynamoDB
 * would, so a test can read the row back after a sequence of scoped writes.
 */
function applySetExpression(
  row: Record<string, any>,
  input: UpdateCommandInput,
): void {
  const clauses = input.UpdateExpression!.replace(/^SET /, "").split(", ");
  for (const clause of clauses) {
    const [path, placeholder] = clause.split(" = ") as [string, string];
    const segments = path.split(".");
    const leaf = segments.pop()!;
    const target = segments.reduce((obj, segment) => obj[segment], row);
    target[leaf] = input.ExpressionAttributeValues![placeholder];
  }
}

describe("DynamoLeaseStore", () => {
  let store: DynamoLeaseStore;

  beforeEach(() => {
    mockDynamoClient.reset();
    store = new DynamoLeaseStore({
      leaseTableName: TABLE_NAME,
      client: mockDynamoClient as any,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  describe("acquireLock()", () => {
    test("builds correct UpdateCommand without critical override", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.acquireLock({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        ownerId: OWNER_ID,
        timeoutSeconds: 300,
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

      // Override clause absent when no intent is supplied at all
      expect(input.ConditionExpression).not.toContain("resourceLock.meta");
      expect(input.ExpressionAttributeValues).not.toHaveProperty(":terminate");
      expect(input.ExpressionAttributeValues).not.toHaveProperty(":freeze");
    });

    test("TERMINATE is blocked only by another termination, so it preempts a freeze", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.acquireLock({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        ownerId: OWNER_ID,
        timeoutSeconds: 900,
        meta: { intent: "TERMINATE" },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

      // Only :terminate is in the blocking set — terminate is the escape hatch
      // and must not be stopped by an in-flight freeze.
      expect(input.ConditionExpression).toContain(
        "OR (attribute_not_exists(resourceLock.meta.intent) OR NOT resourceLock.meta.intent IN (:terminate))",
      );
      expect(input.ExpressionAttributeValues).toMatchObject({
        ":terminate": "TERMINATE",
      });
      // DynamoDB rejects unused ExpressionAttributeValues, so :freeze must not
      // be declared when the expression does not reference it.
      expect(input.ExpressionAttributeValues).not.toHaveProperty(":freeze");
    });

    test("FREEZE is blocked by a termination or another freeze", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.acquireLock({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        ownerId: OWNER_ID,
        timeoutSeconds: 900,
        meta: { intent: "FREEZE" },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

      expect(input.ConditionExpression).toContain(
        "OR (attribute_not_exists(resourceLock.meta.intent) OR NOT resourceLock.meta.intent IN (:terminate, :freeze))",
      );
      expect(input.ExpressionAttributeValues).toMatchObject({
        ":terminate": "TERMINATE",
        ":freeze": "FREEZE",
      });
    });

    test.each(["UPDATE", "PUBLISH", "UNFREEZE"] as const)(
      "%s gets no override clause, so any live lock blocks it",
      async (intent) => {
        mockDynamoClient.on(UpdateCommand).resolves({});

        await store.acquireLock({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
          timeoutSeconds: 300,
          meta: { intent },
        });

        const input =
          mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

        expect(input.ConditionExpression).not.toContain("resourceLock.meta");
        expect(input.ExpressionAttributeValues).not.toHaveProperty(
          ":terminate",
        );
      },
    );

    test("returns the persisted lock so callers can carry it onto a full-item put", async () => {
      // update()/transactionalUpdate() replace the whole item, so a caller that
      // holds this lock must write it back or the put erases it.
      mockDynamoClient.on(UpdateCommand).resolves({});

      const lock = await store.acquireLock({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        ownerId: OWNER_ID,
        timeoutSeconds: 900,
        meta: { intent: "FREEZE" },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(lock).toEqual(input.ExpressionAttributeValues![":lock"]);
      expect(lock).toEqual({
        ownerId: OWNER_ID,
        acquiredAt: NOW,
        expiresAt: "2024-06-01T12:15:00.000Z",
        meta: { intent: "FREEZE" },
      });
    });

    test("maps ConditionalCheckFailedException to ResourceLockConflictError", async () => {
      mockDynamoClient.on(UpdateCommand).rejects(conditionalCheckFailed);

      await expect(
        store.acquireLock({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
          timeoutSeconds: 300,
        }),
      ).rejects.toThrow(ResourceLockConflictError);
    });

    test("propagates non-conditional errors", async () => {
      mockDynamoClient
        .on(UpdateCommand)
        .rejects(new Error("ServiceUnavailable"));

      await expect(
        store.acquireLock({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
          timeoutSeconds: 300,
        }),
      ).rejects.toThrow("ServiceUnavailable");
    });
  });

  describe("acquireLockWithDesiredAssignments()", () => {
    const desiredAssignments = [
      {
        principalId: "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
        principalType: "USER" as const,
        displayName: "Alice Smith",
        email: "alice@example.com",
      },
    ];

    async function acquireWithDesired(meta?: {
      intent: "UPDATE" | "PUBLISH" | "FREEZE" | "UNFREEZE" | "TERMINATE";
    }) {
      mockDynamoClient.on(UpdateCommand).resolves({});
      const lock = await store.acquireLockWithDesiredAssignments({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        ownerId: OWNER_ID,
        timeoutSeconds: 900,
        desiredAssignments,
        meta,
      });
      return {
        lock,
        input: mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input,
      };
    }

    test("writes the lock and the desired set in one update", async () => {
      const { input } = await acquireWithDesired({ intent: "UPDATE" });

      // Both attributes must land in the same conditional write — that
      // atomicity is the point of this method existing alongside acquireLock.
      expect(input.UpdateExpression).toBe(
        "SET resourceLock = :lock, desiredAssignments = :desiredAssignments",
      );
      expect(input.ExpressionAttributeValues).toHaveProperty(":lock");
      expect(input.ExpressionAttributeValues![":desiredAssignments"]).toEqual(
        desiredAssignments,
      );
    });

    test("returns the persisted lock so callers can carry it onto a full-item put", async () => {
      const { lock, input } = await acquireWithDesired({ intent: "FREEZE" });

      expect(lock).toEqual(input.ExpressionAttributeValues![":lock"]);
      expect(lock).toEqual({
        ownerId: OWNER_ID,
        acquiredAt: NOW,
        expiresAt: "2024-06-01T12:15:00.000Z",
        meta: { intent: "FREEZE" },
      });
    });

    test.each([
      "TERMINATE",
      "FREEZE",
      "UPDATE",
      "PUBLISH",
      "UNFREEZE",
    ] as const)(
      "builds the same condition as acquireLock for %s",
      async (intent) => {
        // Both paths share buildLockAcquisitionCondition. Asserting they agree
        // is what stops one from silently reverting to a hand-rolled condition.
        const { input: withDesired } = await acquireWithDesired({ intent });

        mockDynamoClient.reset();
        mockDynamoClient.on(UpdateCommand).resolves({});
        await store.acquireLock({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
          timeoutSeconds: 900,
          meta: { intent },
        });
        const lockOnly =
          mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

        expect(withDesired.ConditionExpression).toBe(
          lockOnly.ConditionExpression,
        );
        // Same intent placeholders, and no extras that DynamoDB would reject.
        const intentValues = (i: Record<string, unknown>) =>
          Object.fromEntries(
            Object.entries(i).filter(
              ([k]) => k !== ":lock" && k !== ":desiredAssignments",
            ),
          );
        expect(intentValues(withDesired.ExpressionAttributeValues!)).toEqual(
          intentValues(lockOnly.ExpressionAttributeValues!),
        );
      },
    );

    test("maps ConditionalCheckFailedException to ResourceLockConflictError", async () => {
      mockDynamoClient.on(UpdateCommand).rejects(conditionalCheckFailed);

      await expect(
        store.acquireLockWithDesiredAssignments({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
          timeoutSeconds: 300,
          desiredAssignments,
        }),
      ).rejects.toThrow(ResourceLockConflictError);
    });

    test("propagates non-conditional errors", async () => {
      mockDynamoClient
        .on(UpdateCommand)
        .rejects(new Error("ProvisionedThroughputExceeded"));

      await expect(
        store.acquireLockWithDesiredAssignments({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
          timeoutSeconds: 300,
          desiredAssignments,
        }),
      ).rejects.toThrow("ProvisionedThroughputExceeded");
    });

    test("rejects a desired assignment that fails schema validation", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await expect(
        store.acquireLockWithDesiredAssignments({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
          timeoutSeconds: 300,
          desiredAssignments: [
            {
              principalId: "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
              principalType: "USER",
              email: "not-an-email",
            },
          ],
        }),
      ).rejects.toThrow();
      // Validation must happen before the write, not after.
      expect(mockDynamoClient.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    describe("validated lease state", () => {
      const snapshot: LeaseAssignmentWriteSnapshot = {
        status: "Active",
        defaultPermissionSetArn: PROFILE_A,
        allowedPermissionSetArns: [PROFILE_B],
        allowOwnerToShareLease: true,
        desiredAssignments: [
          {
            principalId: LEASE_ID,
            principalType: "USER",
            permissionSetArn: PROFILE_A,
          },
        ],
      };
      const replacementAssignments = [
        {
          principalId: LEASE_ID,
          principalType: "USER" as const,
          permissionSetArn: PROFILE_B,
        },
      ];
      const currentLease = {
        ...snapshot,
        userEmail: USER_EMAIL,
        uuid: LEASE_ID,
        // Unrelated monitoring state must not be diagnosed as validation drift.
        meta: { schemaVersion: 5, lastEditTime: "2024-06-01T12:00:01.000Z" },
        totalCostAccrued: 42,
      };
      const lockedLease = {
        ...currentLease,
        resourceLock: {
          ownerId: "another-operation",
          acquiredAt: NOW,
          expiresAt: "2024-06-01T12:15:00.000Z",
          meta: { intent: "UPDATE" },
        },
      };
      const committedLock = { ...lockedLease.resourceLock, ownerId: OWNER_ID };
      const committedLease = {
        ...currentLease,
        resourceLock: committedLock,
        desiredAssignments: replacementAssignments,
      };

      function writeAssignments(expectedLease = snapshot) {
        return store.acquireLockWithDesiredAssignments({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
          timeoutSeconds: 900,
          meta: { intent: "UPDATE" },
          desiredAssignments: replacementAssignments,
          expectedLease,
        });
      }

      test("guards only assignment validation fields when passed a full lease", async () => {
        const { input: lockOnly } = await acquireWithDesired({
          intent: "UPDATE",
        });
        const lock = await writeAssignments(currentLease);
        const input =
          mockDynamoClient.commandCalls(UpdateCommand)[1]!.args[0].input;
        const validationChecks = [
          "#expected_status = :expected_status",
          "#expected_defaultPermissionSetArn = :expected_defaultPermissionSetArn",
          "#expected_allowedPermissionSetArns = :expected_allowedPermissionSetArns",
          "#expected_allowOwnerToShareLease = :expected_allowOwnerToShareLease",
          "#expected_desiredAssignments = :expected_desiredAssignments",
        ].join(" AND ");

        expect(input.ConditionExpression).toBe(
          `(${lockOnly.ConditionExpression}) AND ${validationChecks}`,
        );
        expect(input.ExpressionAttributeNames).toEqual({
          "#expected_status": "status",
          "#expected_defaultPermissionSetArn": "defaultPermissionSetArn",
          "#expected_allowedPermissionSetArns": "allowedPermissionSetArns",
          "#expected_allowOwnerToShareLease": "allowOwnerToShareLease",
          "#expected_desiredAssignments": "desiredAssignments",
        });
        expect(input.ExpressionAttributeValues).toEqual({
          ":ownerId": OWNER_ID,
          ":acquiredAt": NOW,
          ":lock": lock,
          ":desiredAssignments": replacementAssignments,
          ":expected_status": "Active",
          ":expected_defaultPermissionSetArn": PROFILE_A,
          ":expected_allowedPermissionSetArns": [PROFILE_B],
          ":expected_allowOwnerToShareLease": true,
          ":expected_desiredAssignments": snapshot.desiredAssignments,
        });
        expect(input.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD");
      });

      test("checks legacy field absence without unused value placeholders", async () => {
        mockDynamoClient.on(UpdateCommand).resolves({});
        const lock = await writeAssignments({ status: "Active" });
        const input =
          mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

        expect(input.ConditionExpression).toContain(
          ") AND #expected_status = :expected_status AND attribute_not_exists(#expected_defaultPermissionSetArn) AND attribute_not_exists(#expected_allowedPermissionSetArns) AND attribute_not_exists(#expected_allowOwnerToShareLease) AND attribute_not_exists(#expected_desiredAssignments)",
        );
        expect(input.ExpressionAttributeValues).toEqual({
          ":ownerId": OWNER_ID,
          ":acquiredAt": NOW,
          ":lock": lock,
          ":desiredAssignments": replacementAssignments,
          ":expected_status": "Active",
        });
      });

      test.each([
        { name: "a configured lease", expectedLease: snapshot },
        {
          name: "a legacy lease with absent validation fields",
          expectedLease: { status: "Active" as const },
        },
      ])(
        "recognizes its already committed write on $name without another read or write",
        async ({ expectedLease }) => {
          mockDynamoClient.on(UpdateCommand).rejects(
            new ConditionalCheckFailedException({
              message: "The conditional request failed",
              $metadata: {},
              Item: marshall({
                ...expectedLease,
                userEmail: USER_EMAIL,
                uuid: LEASE_ID,
                resourceLock: committedLock,
                desiredAssignments: replacementAssignments,
                totalCostAccrued: 42,
              }),
            }),
          );

          await expect(writeAssignments(expectedLease)).resolves.toEqual(
            committedLock,
          );
          expect(mockDynamoClient.calls()).toHaveLength(1);
        },
      );

      test.each([
        {
          reason: "another operation wrote the same assignments",
          storedLease: {
            ...committedLease,
            resourceLock: lockedLease.resourceLock,
          },
        },
        {
          reason: "the same owner has a different lock",
          storedLease: {
            ...committedLease,
            resourceLock: {
              ...committedLock,
              acquiredAt: "2024-06-01T11:59:00.000Z",
            },
          },
        },
        {
          reason: "the permission profile changed",
          storedLease: { ...committedLease, allowedPermissionSetArns: [] },
        },
        {
          reason: "the lease status changed",
          storedLease: { ...committedLease, status: "Frozen" },
        },
        {
          reason: "the assignments differ from this write",
          storedLease: { ...committedLease, desiredAssignments: [] },
        },
      ])("rejects an apparent replay when $reason", async ({ storedLease }) => {
        mockDynamoClient.on(UpdateCommand).rejects(
          new ConditionalCheckFailedException({
            message: "The conditional request failed",
            $metadata: {},
            Item: marshall(storedLease),
          }),
        );

        await expect(writeAssignments()).rejects.toMatchObject({
          name: "ConcurrentDataModificationException",
        });
        expect(mockDynamoClient.calls()).toHaveLength(1);
      });

      test.each([
        {
          reason: "a changed permission profile",
          storedLease: { ...currentLease, allowedPermissionSetArns: [] },
          errorName: "ConcurrentDataModificationException",
          message: `Assignment validation conflict on lease ${LEASE_ID}: allowedPermissionSetArns changed after validation`,
        },
        {
          reason: "changed assignments even when the lock is also held",
          storedLease: { ...lockedLease, desiredAssignments: [] },
          errorName: "ConcurrentDataModificationException",
          message: `Assignment validation conflict on lease ${LEASE_ID}: desiredAssignments changed after validation`,
        },
        {
          reason: "a held lock with matching validated fields",
          storedLease: lockedLease,
          errorName: "ResourceLockConflictError",
          message: `Lock conflict on lease ${LEASE_ID}: resource lock is unavailable`,
        },
        {
          reason: "a deleted lease",
          storedLease: undefined,
          errorName: "UnknownItem",
          message: `Lease ${LEASE_ID} no longer exists.`,
        },
      ])(
        "reports $reason from the failed write image",
        async ({ storedLease, errorName, message }) => {
          mockDynamoClient.on(UpdateCommand).rejects(
            new ConditionalCheckFailedException({
              message: "The conditional request failed",
              $metadata: {},
              Item: storedLease ? marshall(storedLease) : undefined,
            }),
          );

          await expect(writeAssignments()).rejects.toMatchObject({
            name: errorName,
            message,
          });
          expect(mockDynamoClient.calls()).toHaveLength(1);
        },
      );
    });
  });

  describe("releaseLock()", () => {
    test("no-ops on ConditionalCheckFailedException (lock held by different owner or item missing)", async () => {
      mockDynamoClient.on(UpdateCommand).rejects(conditionalCheckFailed);

      await expect(
        store.releaseLock({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
        }),
      ).resolves.toBeUndefined();
    });

    test("propagates non-conditional errors", async () => {
      mockDynamoClient
        .on(UpdateCommand)
        .rejects(new Error("InternalServerError"));

      await expect(
        store.releaseLock({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
        }),
      ).rejects.toThrow("InternalServerError");
    });
  });

  describe("update()", () => {
    let lease: PersistedMonitoredLease;

    beforeEach(() => {
      lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Active",
        desiredAssignments: [
          {
            principalId: LEASE_ID,
            principalType: "USER",
            permissionSetArn: PROFILE_A,
          },
        ],
        resourceLock: {
          ownerId: OWNER_ID,
          acquiredAt: NOW,
          expiresAt: "2024-06-01T12:15:00.000Z",
          meta: { intent: "UPDATE" },
        },
        meta: { schemaVersion: 5, lastEditTime: "2024-06-01T11:59:00.000Z" },
      });
      mockDynamoClient.on(PutCommand).resolves({});
    });

    test("updates without an expected snapshot and returns the replaced item", async () => {
      mockDynamoClient.on(PutCommand).resolves({ Attributes: lease });

      const result = await store.update({ ...lease, comments: "updated" });

      expect(result.oldItem).toEqual(lease);
      expect(result.newItem.comments).toBe("updated");
      const calls = mockDynamoClient.commandCalls(PutCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input.ConditionExpression).toBe(
        "attribute_exists(userEmail)",
      );
      expect(calls[0]!.args[0].input.ExpressionAttributeValues).toBeUndefined();
    });

    test("reports a missing lease when updating without an expected snapshot", async () => {
      mockDynamoClient.on(PutCommand).rejects(conditionalCheckFailed);

      await expect(store.update(lease)).rejects.toThrow(UnknownItem);
    });

    test("guards the previous assignments and lock alongside the metadata timestamp", async () => {
      await store.update({ ...lease, comments: "updated" }, lease);
      const input = mockDynamoClient.commandCalls(PutCommand)[0]!.args[0].input;

      expect(input.ConditionExpression).toBe(
        "attribute_exists(userEmail) AND meta.lastEditTime = :expectedTime AND #expected_desiredAssignments = :expected_desiredAssignments AND #expected_resourceLock = :expected_resourceLock",
      );
      expect(input.ExpressionAttributeNames).toEqual({
        "#expected_desiredAssignments": "desiredAssignments",
        "#expected_resourceLock": "resourceLock",
      });
      expect(input.ExpressionAttributeValues).toEqual({
        ":expectedTime": "2024-06-01T11:59:00.000Z",
        ":expected_desiredAssignments": lease.desiredAssignments,
        ":expected_resourceLock": lease.resourceLock,
      });
      expect(input.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD");
    });

    test("recovers a committed replacement after its response is lost", async () => {
      mockDynamoClient.on(PutCommand).callsFake(async (input) => {
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: "The retry no longer matches the original snapshot",
          Item: marshall(input.Item, { removeUndefinedValues: true }),
        });
      });

      const result = await store.update(
        {
          ...lease,
          comments: "updated",
          desiredAssignments: [],
          resourceLock: null,
        },
        lease,
      );

      expect(result.oldItem).toEqual(lease);
      expect(result.newItem).toEqual({
        ...lease,
        comments: "updated",
        desiredAssignments: [],
        resourceLock: null,
        meta: { schemaVersion: 5, createdTime: NOW, lastEditTime: NOW },
      });
      expect(lease.meta?.lastEditTime).toBe("2024-06-01T11:59:00.000Z");
      const calls = mockDynamoClient.commandCalls(PutCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input.Item).not.toHaveProperty("resourceLock");
      expect(mockDynamoClient.calls()).toHaveLength(1);
    });

    test.each([
      {
        description: "a different write timestamp",
        storedChanges: {
          meta: { schemaVersion: 5, lastEditTime: "2024-06-01T12:01:00.000Z" },
        },
      },
      {
        description: "changed content despite matching metadata",
        storedChanges: { comments: "another update" },
      },
    ])("rejects a replacement with $description", async ({ storedChanges }) => {
      mockDynamoClient.on(PutCommand).callsFake(async (input) => {
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: "The conditional request failed",
          Item: marshall(
            { ...input.Item, ...storedChanges },
            { removeUndefinedValues: true },
          ),
        });
      });

      await expect(
        store.update({ ...lease, comments: "updated" }, lease),
      ).rejects.toThrow(ConcurrentDataModificationException);
    });

    test("preserves the conflict when the failed-write image is unavailable", async () => {
      mockDynamoClient.on(PutCommand).rejects(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: "The conditional request failed",
        }),
      );

      await expect(
        store.update({ ...lease, comments: "updated" }, lease),
      ).rejects.toThrow(ConcurrentDataModificationException);
    });

    test.each([
      {
        lock: undefined,
        condition: "attribute_not_exists(#expected_resourceLock)",
        values: {},
      },
      {
        lock: null,
        condition:
          "(attribute_not_exists(#expected_resourceLock) OR #expected_resourceLock = :expected_resourceLock)",
        values: { ":expected_resourceLock": null },
      },
    ])(
      "guards legacy absent assignments and a $lock lock",
      async ({ lock, condition, values }) => {
        delete lease.desiredAssignments;
        if (lock === undefined) {
          delete lease.resourceLock;
        } else {
          lease.resourceLock = lock;
        }

        await store.update({ ...lease, comments: "updated" }, lease);
        const input =
          mockDynamoClient.commandCalls(PutCommand)[0]!.args[0].input;

        expect(input.ConditionExpression).toBe(
          `attribute_exists(userEmail) AND meta.lastEditTime = :expectedTime AND attribute_not_exists(#expected_desiredAssignments) AND ${condition}`,
        );
        expect(input.ExpressionAttributeValues).toEqual({
          ":expectedTime": "2024-06-01T11:59:00.000Z",
          ...values,
        });
        expect(input.Item).not.toHaveProperty("resourceLock");
      },
    );
  });

  describe("updateTokenPollOwnedFields()", () => {
    const pollScalars = {
      lastEvaluatedSpend: 42.5,
      lastPredictedSpend: 45.25,
      lastEvaluatedHourlySpendRate: 1.5,
      lastEvaluatedDailySpendRate: 36,
    };

    test("sets only the four poll-owned scalars and meta.lastEditTime on an existing lease", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.updateTokenPollOwnedFields({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        ...pollScalars,
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

      expect(input.TableName).toBe(TABLE_NAME);
      expect(input.Key).toEqual({ userEmail: USER_EMAIL, uuid: LEASE_ID });
      expect(input.UpdateExpression).toBe(
        "SET lastEvaluatedSpend = :lastEvaluatedSpend, lastPredictedSpend = :lastPredictedSpend, lastEvaluatedHourlySpendRate = :lastEvaluatedHourlySpendRate, lastEvaluatedDailySpendRate = :lastEvaluatedDailySpendRate, meta.lastEditTime = :lastEditTime",
      );
      expect(input.ConditionExpression).toBe("attribute_exists(userEmail)");
      expect(input.ExpressionAttributeValues).toEqual({
        ":lastEvaluatedSpend": 42.5,
        ":lastPredictedSpend": 45.25,
        ":lastEvaluatedHourlySpendRate": 1.5,
        ":lastEvaluatedDailySpendRate": 36,
        ":lastEditTime": NOW,
      });
    });

    test("writes null through for scalars that have no value yet", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.updateTokenPollOwnedFields({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        lastEvaluatedSpend: 42.5,
        lastPredictedSpend: null,
        lastEvaluatedHourlySpendRate: null,
        lastEvaluatedDailySpendRate: null,
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

      expect(input.ExpressionAttributeValues).toMatchObject({
        ":lastPredictedSpend": null,
        ":lastEvaluatedHourlySpendRate": null,
        ":lastEvaluatedDailySpendRate": null,
      });
    });

    test("rejects a scalar the lease schema would not accept and sends nothing", async () => {
      await expect(
        store.updateTokenPollOwnedFields({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ...pollScalars,
          lastEvaluatedHourlySpendRate: Number.NaN,
        }),
      ).rejects.toThrow(ZodError);

      expect(mockDynamoClient.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test("maps ConditionalCheckFailedException to UnknownItem", async () => {
      mockDynamoClient.on(UpdateCommand).rejects(conditionalCheckFailed);

      await expect(
        store.updateTokenPollOwnedFields({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ...pollScalars,
        }),
      ).rejects.toThrow(UnknownItem);
    });

    test("propagates non-conditional errors", async () => {
      mockDynamoClient
        .on(UpdateCommand)
        .rejects(new Error("InternalServerError"));

      await expect(
        store.updateTokenPollOwnedFields({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ...pollScalars,
        }),
      ).rejects.toThrow("InternalServerError");
    });
  });

  describe("recordLifecycleDispatch()", () => {
    test("sets only lifecycleDispatch and meta.lastEditTime on an existing lease", async () => {
      // Attribute-scoped, so it cannot erase a resource lock written meanwhile.
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.recordLifecycleDispatch({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        intent: "TERMINATE",
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.Key).toEqual({ userEmail: USER_EMAIL, uuid: LEASE_ID });
      expect(input.UpdateExpression).toBe(
        "SET lifecycleDispatch = :lifecycleDispatch, meta.lastEditTime = :lastEditTime",
      );
      expect(input.ConditionExpression).toBe("attribute_exists(userEmail)");
      expect(input.ExpressionAttributeValues).toEqual({
        ":lifecycleDispatch": { intent: "TERMINATE", dispatchedAt: NOW },
        ":lastEditTime": NOW,
      });
    });

    test("maps ConditionalCheckFailedException to UnknownItem", async () => {
      mockDynamoClient.on(UpdateCommand).rejects(conditionalCheckFailed);

      await expect(
        store.recordLifecycleDispatch({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          intent: "FREEZE",
        }),
      ).rejects.toThrow(UnknownItem);
    });
  });

  describe("updateMonitoringCostFields()", () => {
    const monitoringScalars = {
      totalCostAccrued: 40.1,
      lastCheckedDate: NOW,
    };

    test("sets only totalCostAccrued, lastCheckedDate and meta.lastEditTime on an existing lease", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.updateMonitoringCostFields({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        ...monitoringScalars,
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

      expect(input.TableName).toBe(TABLE_NAME);
      expect(input.Key).toEqual({ userEmail: USER_EMAIL, uuid: LEASE_ID });
      expect(input.UpdateExpression).toBe(
        "SET totalCostAccrued = :totalCostAccrued, lastCheckedDate = :lastCheckedDate, meta.lastEditTime = :lastEditTime",
      );
      expect(input.ConditionExpression).toBe("attribute_exists(userEmail)");
      expect(input.ExpressionAttributeValues).toEqual({
        ":totalCostAccrued": 40.1,
        ":lastCheckedDate": NOW,
        ":lastEditTime": NOW,
      });
    });

    test("rejects a lastCheckedDate that is not a UTC ISO datetime and sends nothing", async () => {
      await expect(
        store.updateMonitoringCostFields({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          totalCostAccrued: 40.1,
          lastCheckedDate: "2024-06-01T12:00:00.000+00:00",
        }),
      ).rejects.toThrow(ZodError);

      expect(mockDynamoClient.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test("maps ConditionalCheckFailedException to UnknownItem", async () => {
      mockDynamoClient.on(UpdateCommand).rejects(conditionalCheckFailed);

      await expect(
        store.updateMonitoringCostFields({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ...monitoringScalars,
        }),
      ).rejects.toThrow(UnknownItem);
    });

    test("propagates non-conditional errors", async () => {
      mockDynamoClient
        .on(UpdateCommand)
        .rejects(new Error("InternalServerError"));

      await expect(
        store.updateMonitoringCostFields({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ...monitoringScalars,
        }),
      ).rejects.toThrow("InternalServerError");
    });
  });

  describe("updateMonitoringOwnedFields()", () => {
    const monitoringScalars = {
      totalCostAccrued: 40.1,
      lastCheckedDate: NOW,
      lastEvaluatedSpend: 42.5,
    };

    test("sets only the cost scalars, lastEvaluatedSpend and meta.lastEditTime when no projection is given", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.updateMonitoringOwnedFields({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        ...monitoringScalars,
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

      expect(input.TableName).toBe(TABLE_NAME);
      expect(input.Key).toEqual({ userEmail: USER_EMAIL, uuid: LEASE_ID });
      expect(input.UpdateExpression).toBe(
        "SET totalCostAccrued = :totalCostAccrued, lastCheckedDate = :lastCheckedDate, lastEvaluatedSpend = :lastEvaluatedSpend, meta.lastEditTime = :lastEditTime",
      );
      expect(input.ConditionExpression).toBe("attribute_exists(userEmail)");
      expect(input.ExpressionAttributeValues).toEqual({
        ":totalCostAccrued": 40.1,
        ":lastCheckedDate": NOW,
        ":lastEvaluatedSpend": 42.5,
        ":lastEditTime": NOW,
      });
    });

    test("also sets the projection scalars, null included, when a projection is given", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.updateMonitoringOwnedFields({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        ...monitoringScalars,
        projection: {
          lastPredictedSpend: 45.25,
          lastEvaluatedHourlySpendRate: 1.5,
          lastEvaluatedDailySpendRate: null,
        },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

      expect(input.UpdateExpression).toBe(
        "SET totalCostAccrued = :totalCostAccrued, lastCheckedDate = :lastCheckedDate, lastEvaluatedSpend = :lastEvaluatedSpend, lastPredictedSpend = :lastPredictedSpend, lastEvaluatedHourlySpendRate = :lastEvaluatedHourlySpendRate, lastEvaluatedDailySpendRate = :lastEvaluatedDailySpendRate, meta.lastEditTime = :lastEditTime",
      );
      expect(input.ExpressionAttributeValues).toEqual({
        ":totalCostAccrued": 40.1,
        ":lastCheckedDate": NOW,
        ":lastEvaluatedSpend": 42.5,
        ":lastPredictedSpend": 45.25,
        ":lastEvaluatedHourlySpendRate": 1.5,
        ":lastEvaluatedDailySpendRate": null,
        ":lastEditTime": NOW,
      });
    });

    test("rejects a lastCheckedDate that is not a UTC ISO datetime and sends nothing", async () => {
      await expect(
        store.updateMonitoringOwnedFields({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ...monitoringScalars,
          lastCheckedDate: "2024-06-01T12:00:00.000+00:00",
        }),
      ).rejects.toThrow(ZodError);

      expect(mockDynamoClient.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test("rejects a projection scalar the lease schema would not accept and sends nothing", async () => {
      await expect(
        store.updateMonitoringOwnedFields({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ...monitoringScalars,
          projection: {
            lastPredictedSpend: 45.25,
            lastEvaluatedHourlySpendRate: Number.NaN,
            lastEvaluatedDailySpendRate: null,
          },
        }),
      ).rejects.toThrow(ZodError);

      expect(mockDynamoClient.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test("maps ConditionalCheckFailedException to UnknownItem", async () => {
      mockDynamoClient.on(UpdateCommand).rejects(conditionalCheckFailed);

      await expect(
        store.updateMonitoringOwnedFields({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ...monitoringScalars,
        }),
      ).rejects.toThrow(UnknownItem);
    });
  });

  describe("scoped cost-scalar writes interleaved", () => {
    test("a poll write followed by a monitoring write preserves both writers' scalars", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      // The row as it stood before either writer ran.
      const row = {
        userEmail: USER_EMAIL,
        uuid: LEASE_ID,
        totalCostAccrued: 10,
        lastCheckedDate: "2024-06-01T11:00:00.000Z",
        lastEvaluatedSpend: 11,
        lastPredictedSpend: 12,
        lastEvaluatedHourlySpendRate: 0.5,
        lastEvaluatedDailySpendRate: 12,
        meta: { schemaVersion: 5, lastEditTime: "2024-06-01T11:00:00.000Z" },
      };

      await store.updateTokenPollOwnedFields({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        lastEvaluatedSpend: 42.5,
        lastPredictedSpend: 45.25,
        lastEvaluatedHourlySpendRate: 1.5,
        lastEvaluatedDailySpendRate: 36,
      });
      // A scoped write carries only the two attributes monitoring owns, so the
      // poll's advance above survives even though monitoring never saw it.
      await store.updateMonitoringCostFields({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        totalCostAccrued: 40.1,
        lastCheckedDate: NOW,
      });

      for (const call of mockDynamoClient.commandCalls(UpdateCommand)) {
        applySetExpression(row, call.args[0].input);
      }

      expect(row).toEqual({
        userEmail: USER_EMAIL,
        uuid: LEASE_ID,
        totalCostAccrued: 40.1,
        lastCheckedDate: NOW,
        lastEvaluatedSpend: 42.5,
        lastPredictedSpend: 45.25,
        lastEvaluatedHourlySpendRate: 1.5,
        lastEvaluatedDailySpendRate: 36,
        meta: { schemaVersion: 5, lastEditTime: NOW },
      });
    });
  });

  describe("get()", () => {
    test("should pass ConsistentRead: true when consistentRead option is set", async () => {
      mockDynamoClient.on(GetCommand).resolves({ Item: undefined });

      await store.get(
        { userEmail: USER_EMAIL, uuid: LEASE_ID },
        { consistentRead: true },
      );

      const calls = mockDynamoClient.commandCalls(GetCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input.ConsistentRead).toBe(true);
    });

    test("should not set ConsistentRead when option is not provided", async () => {
      mockDynamoClient.on(GetCommand).resolves({ Item: undefined });

      await store.get({ userEmail: USER_EMAIL, uuid: LEASE_ID });

      const calls = mockDynamoClient.commandCalls(GetCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input.ConsistentRead).toBeUndefined();
    });
  });

  describe("batchGet()", () => {
    function makeLease(overrides: Partial<LeaseKey> = {}) {
      return generateSchemaData(PersistedPendingLeaseSchema, {
        status: "PendingApproval",
        userEmail: overrides.userEmail ?? USER_EMAIL,
        uuid: overrides.uuid ?? LEASE_ID,
      });
    }

    test("returns empty array without calling DynamoDB when keys is empty", async () => {
      const result = await store.batchGet([]);
      expect(result).toEqual([]);
      expect(mockDynamoClient.commandCalls(BatchGetCommand)).toHaveLength(0);
    });

    test("issues a single BatchGetCommand for keys within the chunk size", async () => {
      const lease1 = makeLease({
        userEmail: "a@example.com",
        uuid: randomUUID(),
      });
      const lease2 = makeLease({
        userEmail: "b@example.com",
        uuid: randomUUID(),
      });
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [lease1, lease2] },
      });

      const result = await store.batchGet([
        { userEmail: lease1.userEmail, uuid: lease1.uuid },
        { userEmail: lease2.userEmail, uuid: lease2.uuid },
      ]);

      expect(result).toHaveLength(2);
      expect(result.map((l) => l.uuid).sort()).toEqual(
        [lease1.uuid, lease2.uuid].sort(),
      );

      const calls = mockDynamoClient.commandCalls(BatchGetCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input.RequestItems?.[TABLE_NAME]?.Keys).toEqual([
        { userEmail: lease1.userEmail, uuid: lease1.uuid },
        { userEmail: lease2.userEmail, uuid: lease2.uuid },
      ]);
    });

    test("deduplicates input keys before calling BatchGet", async () => {
      const lease = makeLease();
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [lease] },
      });

      await store.batchGet([
        { userEmail: lease.userEmail, uuid: lease.uuid },
        { userEmail: lease.userEmail, uuid: lease.uuid },
      ]);

      const calls = mockDynamoClient.commandCalls(BatchGetCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input.RequestItems?.[TABLE_NAME]?.Keys).toEqual([
        { userEmail: lease.userEmail, uuid: lease.uuid },
      ]);
    });

    test("chunks at 100 keys", async () => {
      const leases = Array.from({ length: 105 }, (_, i) =>
        makeLease({
          userEmail: `u${i}@example.com`,
          uuid: randomUUID(),
        }),
      );
      mockDynamoClient
        .on(BatchGetCommand)
        .callsFakeOnce(() => ({
          Responses: { [TABLE_NAME]: leases.slice(0, 100) },
        }))
        .callsFakeOnce(() => ({
          Responses: { [TABLE_NAME]: leases.slice(100) },
        }));

      const result = await store.batchGet(
        leases.map((l) => ({ userEmail: l.userEmail, uuid: l.uuid })),
      );

      expect(result).toHaveLength(105);
      const calls = mockDynamoClient.commandCalls(BatchGetCommand);
      expect(calls).toHaveLength(2);
      expect(
        calls[0]!.args[0].input.RequestItems?.[TABLE_NAME]?.Keys,
      ).toHaveLength(100);
      expect(
        calls[1]!.args[0].input.RequestItems?.[TABLE_NAME]?.Keys,
      ).toHaveLength(5);
    });

    test("retries unprocessed keys until they succeed", async () => {
      vi.useRealTimers(); // backOff uses real setTimeout
      const lease1 = makeLease({
        userEmail: "a@example.com",
        uuid: randomUUID(),
      });
      const lease2 = makeLease({
        userEmail: "b@example.com",
        uuid: randomUUID(),
      });

      mockDynamoClient
        .on(BatchGetCommand)
        .callsFakeOnce(() => ({
          Responses: { [TABLE_NAME]: [lease1] },
          UnprocessedKeys: {
            [TABLE_NAME]: {
              Keys: [{ userEmail: lease2.userEmail, uuid: lease2.uuid }],
            },
          },
        }))
        .callsFakeOnce(() => ({
          Responses: { [TABLE_NAME]: [lease2] },
        }));

      const result = await store.batchGet([
        { userEmail: lease1.userEmail, uuid: lease1.uuid },
        { userEmail: lease2.userEmail, uuid: lease2.uuid },
      ]);

      expect(result).toHaveLength(2);
      expect(mockDynamoClient.commandCalls(BatchGetCommand)).toHaveLength(2);
    });

    test("silently omits keys that DynamoDB does not return", async () => {
      const lease = makeLease();
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [lease] },
      });

      const result = await store.batchGet([
        { userEmail: lease.userEmail, uuid: lease.uuid },
        {
          userEmail: "missing@example.com",
          uuid: randomUUID(),
        },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0]!.uuid).toBe(lease.uuid);
    });

    test("gives up after 4 retry attempts when UnprocessedKeys never clear", async () => {
      vi.useRealTimers(); // backOff uses real setTimeout

      const lease = makeLease();
      const key = { userEmail: lease.userEmail, uuid: lease.uuid };
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [] },
        UnprocessedKeys: {
          [TABLE_NAME]: { Keys: [key] },
        },
      });

      await expect(store.batchGet([key])).rejects.toThrow(
        BatchUnprocessedItemsError,
      );

      expect(mockDynamoClient.commandCalls(BatchGetCommand)).toHaveLength(4);
    });
  });

  describe("pagination cursor binding", () => {
    const TEMPLATE_ID = "00000000-0000-4000-8000-000000000003";

    test("findByStatus rejects a cursor for another status", async () => {
      const pageIdentifier = base64EncodeCompositeKey({
        userEmail: USER_EMAIL,
        uuid: LEASE_ID,
        status: "Expired",
        originalLeaseTemplateUuid: TEMPLATE_ID,
      })!;

      await expect(
        store.findByStatus({
          status: "Active",
          pageIdentifier,
        }),
      ).rejects.toThrow(InvalidPageIdentifierError);
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
    });

    test("findByStatusAndAccountID rejects a cursor for another status", async () => {
      const pageIdentifier = base64EncodeCompositeKey({
        userEmail: USER_EMAIL,
        uuid: LEASE_ID,
        status: "Expired",
        originalLeaseTemplateUuid: TEMPLATE_ID,
      })!;

      await expect(
        store.findByStatusAndAccountID({
          status: "Active",
          awsAccountId: "123456789012",
          pageIdentifier,
        }),
      ).rejects.toThrow(InvalidPageIdentifierError);
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
    });

    test("findByUserEmail rejects a cursor for another user", async () => {
      const pageIdentifier = base64EncodeCompositeKey({
        userEmail: "another-user@example.com",
        uuid: LEASE_ID,
      })!;

      await expect(
        store.findByUserEmail({
          userEmail: USER_EMAIL,
          pageIdentifier,
        }),
      ).rejects.toThrow(InvalidPageIdentifierError);
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
    });

    test("findByLeaseTemplateUuid rejects a cursor for another template", async () => {
      const pageIdentifier = base64EncodeCompositeKey({
        userEmail: USER_EMAIL,
        uuid: LEASE_ID,
        status: "Active",
        originalLeaseTemplateUuid: "00000000-0000-4000-8000-000000000004",
      })!;

      await expect(
        store.findByLeaseTemplateUuid({
          status: "Active",
          uuid: TEMPLATE_ID,
          pageIdentifier,
        }),
      ).rejects.toThrow(InvalidPageIdentifierError);
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
    });
  });
});
