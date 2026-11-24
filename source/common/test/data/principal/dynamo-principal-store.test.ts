// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  base64EncodeCompositeKey,
  InvalidPageIdentifierError,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  BatchUnprocessedItemsError,
  ItemAlreadyExists,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  PERMISSION_SET_CACHE_PK,
  permissionSetCacheSk,
  PermissionSetSchemaVersion,
  PersistedPermissionSetCacheItemSchema,
} from "@amzn/innovation-sandbox-commons/data/permission-set/permission-set.js";
import { DynamoPrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/dynamo-principal-store.js";
import {
  assignmentSk,
  GROUP_MEMBERSHIP_SK,
  groupPk,
  LEASE_SK_PREFIX,
  leaseSk,
  userPk,
} from "@amzn/innovation-sandbox-commons/data/principal/principal-dynamodb-keys.js";
import {
  PersistedGroupAssignmentSchema,
  PersistedGroupMembershipCacheSchema,
  PersistedUserAssignmentSchema,
  PrincipalSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const mockDynamoClient = mockClient(ddbDocClient);

const TABLE_NAME = "test-principal-table";
const VALID_UUID = "00000000-0000-4000-8000-000000000001";
const VALID_UUID_2 = "00000000-0000-4000-8000-000000000002";
const NOW = "2024-01-01T00:00:00.000Z";
const BUILT_IN_PERMISSION_SET_ID = "ps-0123456789abcdef";
const BUILT_IN_PERMISSION_SET_ARN = `arn:aws:sso:::permissionSet/ins-0123456789abcdef/${BUILT_IN_PERMISSION_SET_ID}`;
const CUSTOM_PERMISSION_SET_ID = "ps-fedcba9876543210";
const CUSTOM_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ins-0123456789abcdef/ps-fedcba9876543210";

function makeUserAssignment(overrides: Record<string, unknown> = {}) {
  return generateSchemaData(PersistedUserAssignmentSchema, {
    pk: userPk(VALID_UUID),
    sk: leaseSk(VALID_UUID),
    userId: VALID_UUID,
    principalType: "USER",
    leaseId: VALID_UUID,
    permissionSetArn: BUILT_IN_PERMISSION_SET_ARN,
    meta: {
      schemaVersion: PrincipalSchemaVersion,
      createdTime: NOW,
      lastEditTime: NOW,
    },
    ...overrides,
  });
}

function makeGroupAssignment(overrides: Record<string, unknown> = {}) {
  return generateSchemaData(PersistedGroupAssignmentSchema, {
    pk: groupPk(VALID_UUID),
    sk: leaseSk(VALID_UUID),
    leaseId: VALID_UUID,
    groupId: VALID_UUID,
    principalType: "GROUP",
    permissionSetArn: BUILT_IN_PERMISSION_SET_ARN,
    meta: {
      schemaVersion: PrincipalSchemaVersion,
      createdTime: NOW,
      lastEditTime: NOW,
    },
    ...overrides,
  });
}

function makeGroupMembershipCache(overrides: Record<string, unknown> = {}) {
  return generateSchemaData(PersistedGroupMembershipCacheSchema, {
    pk: userPk(VALID_UUID),
    sk: GROUP_MEMBERSHIP_SK,
    groupIds: [VALID_UUID],
    ttl: Math.floor(Date.now() / 1000) + 86400,
    ...overrides,
  });
}

function makePermissionSetCacheItem(overrides: Record<string, unknown> = {}) {
  const permissionSetId = `ps-${crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 16)}`;
  return generateSchemaData(PersistedPermissionSetCacheItemSchema, {
    pk: PERMISSION_SET_CACHE_PK,
    sk: permissionSetCacheSk(permissionSetId),
    permissionSetId,
    permissionSetArn: `arn:aws:sso:::permissionSet/ins-0123456789abcdef/${permissionSetId}`,
    name: "DeveloperAccess",
    description: undefined,
    sessionDuration: undefined,
    syncedAt: NOW,
    meta: {
      schemaVersion: PermissionSetSchemaVersion,
      createdTime: NOW,
      lastEditTime: NOW,
    },
    ...overrides,
  });
}

describe("DynamoPrincipalStore", () => {
  const store = new DynamoPrincipalStore({
    principalTableName: TABLE_NAME,
    client: ddbDocClient,
  });

  beforeEach(() => {
    mockDynamoClient.reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  describe("createUserAssignment", () => {
    it("should create a user assignment with conditional write", async () => {
      mockDynamoClient.on(PutCommand).resolves({});
      const assignment = makeUserAssignment();

      const result = await store.createUserAssignment(assignment);

      expect(result).toMatchObject(assignment);

      const putCalls = mockDynamoClient.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      const input = putCalls[0]!.args[0].input;
      expect(input.TableName).toBe(TABLE_NAME);
      expect(input.ConditionExpression).toBe(
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      );
    });

    it("should throw ItemAlreadyExists on duplicate", async () => {
      mockDynamoClient.on(PutCommand).rejects(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: "Condition not met",
        }),
      );

      await expect(
        store.createUserAssignment(makeUserAssignment()),
      ).rejects.toThrow(ItemAlreadyExists);
    });

    it("should re-throw non-conditional errors", async () => {
      mockDynamoClient.on(PutCommand).rejects(new Error("Network error"));

      await expect(
        store.createUserAssignment(makeUserAssignment()),
      ).rejects.toThrow("Network error");
    });

    it("should exclude undefined optional fields from DynamoDB write", async () => {
      mockDynamoClient.on(PutCommand).resolves({});
      const assignment = makeUserAssignment();
      delete (assignment as Record<string, unknown>)["accountId"];
      delete (assignment as Record<string, unknown>)["statusMessage"];

      await store.createUserAssignment(assignment);

      const putCalls = mockDynamoClient.commandCalls(PutCommand);
      const writtenItem = putCalls[0]!.args[0].input.Item;
      expect(writtenItem).not.toHaveProperty("accountId");
      expect(writtenItem).toHaveProperty(
        "permissionSetArn",
        BUILT_IN_PERMISSION_SET_ARN,
      );
      expect(writtenItem).not.toHaveProperty("statusMessage");
    });
  });

  describe("createGroupAssignment", () => {
    it("should create a group assignment with conditional write", async () => {
      mockDynamoClient.on(PutCommand).resolves({});
      const assignment = makeGroupAssignment();

      const result = await store.createGroupAssignment(assignment);

      expect(result).toMatchObject(assignment);

      const putCalls = mockDynamoClient.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      const input = putCalls[0]!.args[0].input;
      expect(input.ConditionExpression).toBe(
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      );
    });

    it("should throw ItemAlreadyExists on duplicate", async () => {
      mockDynamoClient.on(PutCommand).rejects(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: "Condition not met",
        }),
      );

      await expect(
        store.createGroupAssignment(makeGroupAssignment()),
      ).rejects.toThrow(ItemAlreadyExists);
    });

    it("should re-throw non-conditional errors", async () => {
      mockDynamoClient.on(PutCommand).rejects(new Error("Network error"));

      await expect(
        store.createGroupAssignment(makeGroupAssignment()),
      ).rejects.toThrow("Network error");
    });
  });

  describe("getUserAssignment", () => {
    it("should return a user assignment by userId and leaseId", async () => {
      const item = makeUserAssignment();
      mockDynamoClient.on(GetCommand).resolves({ Item: item });

      const result = await store.getUserAssignment(VALID_UUID, VALID_UUID);

      expect(result.result).toEqual(item);

      const getCalls = mockDynamoClient.commandCalls(GetCommand);
      expect(getCalls[0]!.args[0].input.Key).toEqual({
        pk: userPk(VALID_UUID),
        sk: leaseSk(VALID_UUID),
      });
    });

    it("should return undefined result when not found", async () => {
      mockDynamoClient.on(GetCommand).resolves({ Item: undefined });

      const result = await store.getUserAssignment(VALID_UUID, VALID_UUID);

      expect(result.result).toBeUndefined();
    });
  });

  describe("getGroupAssignment", () => {
    it("should return a group assignment by groupId and leaseId", async () => {
      const item = makeGroupAssignment();
      mockDynamoClient.on(GetCommand).resolves({ Item: item });

      const result = await store.getGroupAssignment(VALID_UUID, VALID_UUID);

      expect(result.result).toEqual(item);

      const getCalls = mockDynamoClient.commandCalls(GetCommand);
      expect(getCalls[0]!.args[0].input.Key).toEqual({
        pk: groupPk(VALID_UUID),
        sk: leaseSk(VALID_UUID),
      });
    });

    it("should return undefined result when not found", async () => {
      mockDynamoClient.on(GetCommand).resolves({ Item: undefined });

      const result = await store.getGroupAssignment(VALID_UUID, VALID_UUID);

      expect(result.result).toBeUndefined();
    });
  });

  describe("tuple-aware assignment lookups", () => {
    it("returns mixed legacy and tuple-keyed records for one principal and lease", async () => {
      const legacy = makeUserAssignment({
        permissionSetArn: BUILT_IN_PERMISSION_SET_ARN,
      });
      const tuple = makeUserAssignment({
        sk: assignmentSk(VALID_UUID, CUSTOM_PERMISSION_SET_ID),
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      });
      mockDynamoClient
        .on(QueryCommand)
        .resolvesOnce({
          Items: [legacy],
          LastEvaluatedKey: { pk: userPk(VALID_UUID), sk: legacy.sk },
        })
        .resolvesOnce({ Items: [tuple] });

      const result = await store.getAssignmentsForPrincipalAndLease({
        principalId: VALID_UUID,
        principalType: "USER",
        leaseId: VALID_UUID,
      });

      expect(result).toEqual([legacy, tuple]);
      const calls = mockDynamoClient.commandCalls(QueryCommand);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.args[0].input.ConsistentRead).toBe(true);
      expect(calls[1]!.args[0].input.ConsistentRead).toBe(true);
      expect(calls[0]!.args[0].input.ExpressionAttributeValues).toEqual({
        ":pk": userPk(VALID_UUID),
        ":skPrefix": leaseSk(VALID_UUID),
      });
      expect(calls[1]!.args[0].input.ExclusiveStartKey).toEqual({
        pk: userPk(VALID_UUID),
        sk: legacy.sk,
      });
    });

    it("queries group assignments using the group principal key", async () => {
      const groupAssignment = makeGroupAssignment();
      mockDynamoClient.on(QueryCommand).resolves({ Items: [groupAssignment] });

      const result = await store.getAssignmentsForPrincipalAndLease({
        principalId: VALID_UUID,
        principalType: "GROUP",
        leaseId: VALID_UUID,
      });

      expect(result).toEqual([groupAssignment]);
      expect(
        mockDynamoClient.commandCalls(QueryCommand)[0]!.args[0].input
          .ExpressionAttributeValues,
      ).toEqual({
        ":pk": groupPk(VALID_UUID),
        ":skPrefix": leaseSk(VALID_UUID),
      });
    });

    it("deletes one assignment record by its exact principal-table key", async () => {
      const tuple = makeUserAssignment({
        sk: assignmentSk(VALID_UUID, CUSTOM_PERMISSION_SET_ID),
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      });
      mockDynamoClient.on(DeleteCommand).resolves({ Attributes: tuple });

      const deleted = await store.deleteAssignment({
        principalId: VALID_UUID,
        principalType: "USER",
        sk: tuple.sk,
        expectedLastEditTime: NOW,
      });

      expect(deleted).toBe(true);
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
      expect(
        mockDynamoClient.commandCalls(DeleteCommand)[0]!.args[0].input,
      ).toMatchObject({
        Key: {
          pk: userPk(VALID_UUID),
          sk: tuple.sk,
        },
        ConditionExpression: "#meta.#lastEditTime = :expectedLastEditTime",
        ExpressionAttributeValues: {
          ":expectedLastEditTime": NOW,
        },
      });
    });

    it("returns false when an exact assignment record is already absent", async () => {
      mockDynamoClient.on(DeleteCommand).resolves({});

      const deleted = await store.deleteAssignment({
        principalId: VALID_UUID,
        principalType: "GROUP",
        sk: leaseSk(VALID_UUID),
      });

      expect(deleted).toBe(false);
      expect(
        mockDynamoClient.commandCalls(DeleteCommand)[0]!.args[0].input,
      ).toMatchObject({
        Key: {
          pk: groupPk(VALID_UUID),
          sk: leaseSk(VALID_UUID),
        },
      });
      expect(
        mockDynamoClient.commandCalls(DeleteCommand)[0]!.args[0].input
          .ConditionExpression,
      ).toBeUndefined();
    });

    it("guards an exact record that originally had no last-edit timestamp", async () => {
      mockDynamoClient.on(DeleteCommand).resolves({});

      await store.deleteAssignment({
        principalId: VALID_UUID,
        principalType: "USER",
        sk: leaseSk(VALID_UUID),
        expectedLastEditTime: undefined,
      });

      expect(
        mockDynamoClient.commandCalls(DeleteCommand)[0]!.args[0].input,
      ).toMatchObject({
        ConditionExpression: "attribute_not_exists(#meta.#lastEditTime)",
      });
    });

    it("propagates a conditional conflict deleting an exact record", async () => {
      mockDynamoClient.on(DeleteCommand).rejects(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: "Assignment changed",
        }),
      );

      await expect(
        store.deleteAssignment({
          principalId: VALID_UUID,
          principalType: "USER",
          sk: leaseSk(VALID_UUID),
          expectedLastEditTime: NOW,
        }),
      ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    });

    it("returns the first assignment when no permission-set ARN is specified", async () => {
      const legacy = makeUserAssignment();
      const tuple = makeUserAssignment({
        sk: assignmentSk(VALID_UUID, CUSTOM_PERMISSION_SET_ID),
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      });
      mockDynamoClient.on(QueryCommand).resolves({ Items: [legacy, tuple] });

      const result = await store.findAssignment({
        principalId: VALID_UUID,
        principalType: "USER",
        leaseId: VALID_UUID,
      });

      expect(result).toEqual(legacy);
    });

    it("matches an explicit permission set without treating a legacy record as a custom assignment", async () => {
      const legacy = makeUserAssignment();
      const tuple = makeUserAssignment({
        sk: assignmentSk(VALID_UUID, CUSTOM_PERMISSION_SET_ID),
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      });
      mockDynamoClient.on(QueryCommand).resolves({ Items: [legacy, tuple] });

      const result = await store.findAssignment({
        principalId: VALID_UUID,
        principalType: "USER",
        leaseId: VALID_UUID,
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      });

      expect(result).toEqual(tuple);
    });

    it("matches a suffix-less legacy record by its persisted permission set ARN", async () => {
      const legacy = makeUserAssignment();
      mockDynamoClient.on(QueryCommand).resolves({ Items: [legacy] });

      const result = await store.findAssignment({
        principalId: VALID_UUID,
        principalType: "USER",
        leaseId: VALID_UUID,
        permissionSetArn: BUILT_IN_PERMISSION_SET_ARN,
      });

      expect(result).toEqual(legacy);
    });

    it("matches a legacy record only to the built-in permission set when the lease default differs", async () => {
      const legacy = makeUserAssignment({ permissionSetArn: undefined });
      mockDynamoClient.on(QueryCommand).resolves({ Items: [legacy] });

      const builtInResult = await store.findAssignment({
        principalId: VALID_UUID,
        principalType: "USER",
        leaseId: VALID_UUID,
        permissionSetArn: BUILT_IN_PERMISSION_SET_ARN,
        builtInPermissionSetArn: BUILT_IN_PERMISSION_SET_ARN,
      });
      const customResult = await store.findAssignment({
        principalId: VALID_UUID,
        principalType: "USER",
        leaseId: VALID_UUID,
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
        builtInPermissionSetArn: BUILT_IN_PERMISSION_SET_ARN,
      });

      expect(builtInResult).toEqual(legacy);
      expect(customResult).toBeUndefined();
    });

    it("does not treat a legacy record as a custom permission set", async () => {
      const legacy = makeUserAssignment({ permissionSetArn: undefined });
      mockDynamoClient.on(QueryCommand).resolves({ Items: [legacy] });

      const result = await store.findAssignment({
        principalId: VALID_UUID,
        principalType: "USER",
        leaseId: VALID_UUID,
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
        builtInPermissionSetArn: BUILT_IN_PERMISSION_SET_ARN,
      });

      expect(result).toBeUndefined();
    });

    it("does not treat a bare-key record with a different stored ARN as the built-in permission set", async () => {
      const legacy = makeUserAssignment({
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      });
      mockDynamoClient.on(QueryCommand).resolves({ Items: [legacy] });

      const result = await store.findAssignment({
        principalId: VALID_UUID,
        principalType: "USER",
        leaseId: VALID_UUID,
        permissionSetArn: BUILT_IN_PERMISSION_SET_ARN,
        builtInPermissionSetArn: BUILT_IN_PERMISSION_SET_ARN,
      });

      expect(result).toBeUndefined();
    });

    it("deletes a matched record using its real tuple-keyed sort key", async () => {
      const tuple = makeUserAssignment({
        sk: assignmentSk(VALID_UUID, CUSTOM_PERMISSION_SET_ID),
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      });
      mockDynamoClient
        .on(QueryCommand)
        .resolves({ Items: [makeUserAssignment(), tuple] });
      mockDynamoClient.on(DeleteCommand).resolves({ Attributes: tuple });

      const count = await store.deleteAssignmentsByLeasePrincipal({
        principalId: VALID_UUID,
        principalType: "USER",
        leaseId: VALID_UUID,
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      });

      expect(count).toBe(1);
      expect(
        mockDynamoClient.commandCalls(DeleteCommand)[0]!.args[0].input.Key,
      ).toEqual({
        pk: userPk(VALID_UUID),
        sk: assignmentSk(VALID_UUID, CUSTOM_PERMISSION_SET_ID),
      });
    });

    it("deletes both explicit and legacy records for the built-in permission set", async () => {
      const legacy = makeUserAssignment({ permissionSetArn: undefined });
      const explicitBuiltIn = makeUserAssignment({
        sk: assignmentSk(VALID_UUID, BUILT_IN_PERMISSION_SET_ID),
        permissionSetArn: BUILT_IN_PERMISSION_SET_ARN,
      });
      mockDynamoClient
        .on(QueryCommand)
        .resolves({ Items: [legacy, explicitBuiltIn] });
      mockDynamoClient
        .on(DeleteCommand)
        .resolvesOnce({ Attributes: explicitBuiltIn })
        .resolvesOnce({ Attributes: legacy });

      const count = await store.deleteAssignmentsByLeasePrincipal({
        principalId: VALID_UUID,
        principalType: "USER",
        leaseId: VALID_UUID,
        permissionSetArn: BUILT_IN_PERMISSION_SET_ARN,
        builtInPermissionSetArn: BUILT_IN_PERMISSION_SET_ARN,
      });

      expect(count).toBe(2);
      expect(
        mockDynamoClient
          .commandCalls(DeleteCommand)
          .map((call) => call.args[0].input.Key),
      ).toEqual([
        {
          pk: userPk(VALID_UUID),
          sk: assignmentSk(VALID_UUID, BUILT_IN_PERMISSION_SET_ID),
        },
        { pk: userPk(VALID_UUID), sk: leaseSk(VALID_UUID) },
      ]);
    });

    it("deletes every assignment when the permission-set ARN is omitted", async () => {
      const legacy = makeUserAssignment();
      const tuple = makeUserAssignment({
        sk: assignmentSk(VALID_UUID, CUSTOM_PERMISSION_SET_ID),
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      });
      mockDynamoClient.on(QueryCommand).resolves({ Items: [legacy, tuple] });
      mockDynamoClient
        .on(DeleteCommand)
        .resolvesOnce({ Attributes: legacy })
        .resolvesOnce({ Attributes: tuple });

      const count = await store.deleteAssignmentsByLeasePrincipal({
        principalId: VALID_UUID,
        principalType: "USER",
        leaseId: VALID_UUID,
      });

      expect(count).toBe(2);
      expect(
        mockDynamoClient
          .commandCalls(DeleteCommand)
          .map((call) => call.args[0].input.Key),
      ).toEqual([
        { pk: userPk(VALID_UUID), sk: leaseSk(VALID_UUID) },
        {
          pk: userPk(VALID_UUID),
          sk: assignmentSk(VALID_UUID, CUSTOM_PERMISSION_SET_ID),
        },
      ]);
    });

    it("counts only assignments that were actually deleted", async () => {
      const tuple = makeUserAssignment({
        sk: assignmentSk(VALID_UUID, CUSTOM_PERMISSION_SET_ID),
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      });
      mockDynamoClient.on(QueryCommand).resolves({ Items: [tuple] });
      mockDynamoClient.on(DeleteCommand).resolves({});

      const count = await store.deleteAssignmentsByLeasePrincipal({
        principalId: VALID_UUID,
        principalType: "USER",
        leaseId: VALID_UUID,
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      });

      expect(count).toBe(0);
    });

    it("does not delete an assignment that changed after it was queried", async () => {
      const tuple = makeUserAssignment({
        sk: assignmentSk(VALID_UUID, CUSTOM_PERMISSION_SET_ID),
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      });
      mockDynamoClient.on(QueryCommand).resolves({ Items: [tuple] });
      mockDynamoClient.on(DeleteCommand).rejects(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: "Assignment changed",
        }),
      );

      const count = await store.deleteAssignmentsByLeasePrincipal({
        principalId: VALID_UUID,
        principalType: "USER",
        leaseId: VALID_UUID,
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      });

      expect(count).toBe(0);
      expect(
        mockDynamoClient.commandCalls(DeleteCommand)[0]!.args[0].input,
      ).toMatchObject({
        ConditionExpression: "#meta.#lastEditTime = :expectedLastEditTime",
        ExpressionAttributeValues: {
          ":expectedLastEditTime": NOW,
        },
      });
    });

    it("does not delete a legacy record when targeting a custom permission set without the built-in ARN", async () => {
      const legacy = makeUserAssignment({ permissionSetArn: undefined });
      mockDynamoClient.on(QueryCommand).resolves({ Items: [legacy] });

      const count = await store.deleteAssignmentsByLeasePrincipal({
        principalId: VALID_UUID,
        principalType: "USER",
        leaseId: VALID_UUID,
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      });

      expect(count).toBe(0);
      expect(mockDynamoClient.commandCalls(DeleteCommand)).toHaveLength(0);
    });
  });

  describe("getAssignmentsForLease (LeaseIndex GSI)", () => {
    it("should query LeaseIndex GSI with leaseId", async () => {
      const userItem = makeUserAssignment();
      const groupItem = makeGroupAssignment();
      mockDynamoClient
        .on(QueryCommand)
        .resolves({ Items: [userItem, groupItem] });

      const result = await store.getAssignmentsForLease({
        leaseId: VALID_UUID,
      });

      expect(result.result).toEqual([userItem, groupItem]);
      expect(result.nextPageIdentifier).toBeNull();

      const queryCalls = mockDynamoClient.commandCalls(QueryCommand);
      const input = queryCalls[0]!.args[0].input;
      expect(input.IndexName).toBe("LeaseIndex");
      expect(input.ExpressionAttributeValues).toEqual({
        ":leaseId": VALID_UUID,
      });
    });

    it("should handle pagination across two pages", async () => {
      const page1Item = makeUserAssignment();
      const page2Item = makeGroupAssignment();

      mockDynamoClient
        .on(QueryCommand)
        .resolvesOnce({
          Items: [page1Item],
          LastEvaluatedKey: {
            leaseId: VALID_UUID,
            pk: page1Item.pk,
            sk: page1Item.sk,
          },
        })
        .resolvesOnce({
          Items: [page2Item],
        });

      const page1 = await store.getAssignmentsForLease({
        leaseId: VALID_UUID,
        pageSize: 1,
      });

      expect(page1.result).toHaveLength(1);
      expect(page1.result[0]).toEqual(page1Item);
      expect(page1.nextPageIdentifier).not.toBeNull();

      const page2 = await store.getAssignmentsForLease({
        leaseId: VALID_UUID,
        pageSize: 1,
        pageIdentifier: page1.nextPageIdentifier!,
      });

      expect(page2.result).toHaveLength(1);
      expect(page2.result[0]).toEqual(page2Item);
      expect(page2.nextPageIdentifier).toBeNull();

      const queryCalls = mockDynamoClient.commandCalls(QueryCommand);
      expect(queryCalls).toHaveLength(2);
      expect(queryCalls[1]!.args[0].input.ExclusiveStartKey).toBeDefined();
    });

    it("should return empty results when no assignments exist", async () => {
      mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

      const result = await store.getAssignmentsForLease({
        leaseId: VALID_UUID,
      });

      expect(result.result).toHaveLength(0);
    });

    it("should reject a cursor for another lease", async () => {
      const pageIdentifier = base64EncodeCompositeKey({
        leaseId: VALID_UUID_2,
        pk: userPk(VALID_UUID),
        sk: leaseSk(VALID_UUID_2),
      })!;

      await expect(
        store.getAssignmentsForLease({
          leaseId: VALID_UUID,
          pageIdentifier,
        }),
      ).rejects.toThrow(InvalidPageIdentifierError);
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
    });
  });

  describe("getDirectAssignmentsForUser", () => {
    it("should query by user pk with lease# sk prefix", async () => {
      const item = makeUserAssignment();
      mockDynamoClient.on(QueryCommand).resolves({ Items: [item] });

      const result = await store.getDirectAssignmentsForUser({
        userId: VALID_UUID,
      });

      expect(result.result).toEqual([item]);

      const queryCalls = mockDynamoClient.commandCalls(QueryCommand);
      const input = queryCalls[0]!.args[0].input;
      expect(input.ExpressionAttributeValues).toEqual({
        ":pk": userPk(VALID_UUID),
        ":skPrefix": LEASE_SK_PREFIX,
      });
      expect(input.KeyConditionExpression).toContain("begins_with");
    });

    it("should handle pagination across two pages", async () => {
      const page1Item = makeUserAssignment();
      const page2Item = makeUserAssignment({
        sk: leaseSk(VALID_UUID_2),
        leaseId: VALID_UUID_2,
      });

      mockDynamoClient
        .on(QueryCommand)
        .resolvesOnce({
          Items: [page1Item],
          LastEvaluatedKey: {
            pk: userPk(VALID_UUID),
            sk: leaseSk(VALID_UUID),
          },
        })
        .resolvesOnce({
          Items: [page2Item],
        });

      const page1 = await store.getDirectAssignmentsForUser({
        userId: VALID_UUID,
        pageSize: 1,
      });

      expect(page1.result).toHaveLength(1);
      expect(page1.nextPageIdentifier).not.toBeNull();

      const page2 = await store.getDirectAssignmentsForUser({
        userId: VALID_UUID,
        pageSize: 1,
        pageIdentifier: page1.nextPageIdentifier!,
      });

      expect(page2.result).toHaveLength(1);
      expect(page2.nextPageIdentifier).toBeNull();

      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(2);
    });

    it("should reject a cursor for another user", async () => {
      const pageIdentifier = base64EncodeCompositeKey({
        pk: userPk(VALID_UUID_2),
        sk: leaseSk(VALID_UUID),
      })!;

      await expect(
        store.getDirectAssignmentsForUser({
          userId: VALID_UUID,
          pageIdentifier,
        }),
      ).rejects.toThrow(InvalidPageIdentifierError);
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
    });
  });

  describe("getGroupMembershipCache", () => {
    it("should get cache by userId with groupMembership sk", async () => {
      const cache = makeGroupMembershipCache();
      mockDynamoClient.on(GetCommand).resolves({ Item: cache });

      const result = await store.getGroupMembershipCache(VALID_UUID);

      expect(result.result).toEqual(cache);

      const getCalls = mockDynamoClient.commandCalls(GetCommand);
      expect(getCalls[0]!.args[0].input.Key).toEqual({
        pk: userPk(VALID_UUID),
        sk: GROUP_MEMBERSHIP_SK,
      });
    });

    it("should return undefined when cache does not exist", async () => {
      mockDynamoClient.on(GetCommand).resolves({ Item: undefined });

      const result = await store.getGroupMembershipCache(VALID_UUID);

      expect(result.result).toBeUndefined();
    });
  });

  describe("putGroupMembershipCache", () => {
    it("should put cache record to DynamoDB", async () => {
      mockDynamoClient.on(PutCommand).resolves({});
      const cache = makeGroupMembershipCache();

      await store.putGroupMembershipCache(cache);

      const putCalls = mockDynamoClient.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0]!.args[0].input.TableName).toBe(TABLE_NAME);
    });
  });

  describe("deleteUserAssignment", () => {
    it("should delete by pk and sk and return old item", async () => {
      const item = makeUserAssignment();
      mockDynamoClient.on(DeleteCommand).resolves({ Attributes: item });

      const result = await store.deleteUserAssignment(VALID_UUID, VALID_UUID);

      expect(result).toEqual(item);

      const deleteCalls = mockDynamoClient.commandCalls(DeleteCommand);
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0]!.args[0].input.Key).toEqual({
        pk: userPk(VALID_UUID),
        sk: leaseSk(VALID_UUID),
      });
      expect(deleteCalls[0]!.args[0].input.ReturnValues).toBe("ALL_OLD");
    });

    it("should return undefined when item does not exist", async () => {
      mockDynamoClient.on(DeleteCommand).resolves({ Attributes: undefined });

      const result = await store.deleteUserAssignment(VALID_UUID, VALID_UUID);

      expect(result).toBeUndefined();
    });
  });

  describe("deleteGroupAssignment", () => {
    it("should delete group assignment with correct group# key prefix", async () => {
      const item = makeGroupAssignment();
      mockDynamoClient.on(DeleteCommand).resolves({ Attributes: item });

      const result = await store.deleteGroupAssignment(VALID_UUID, VALID_UUID);

      expect(result).toEqual(item);

      const deleteCalls = mockDynamoClient.commandCalls(DeleteCommand);
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0]!.args[0].input.Key).toEqual({
        pk: groupPk(VALID_UUID),
        sk: leaseSk(VALID_UUID),
      });
    });
  });

  describe("batchPutAssignments", () => {
    it("should batch write assignments", async () => {
      mockDynamoClient.on(BatchWriteCommand).resolves({});

      const assignments = [makeUserAssignment(), makeGroupAssignment()];

      await store.batchPutAssignments(assignments);

      const batchCalls = mockDynamoClient.commandCalls(BatchWriteCommand);
      expect(batchCalls).toHaveLength(1);
      const requestItems = batchCalls[0]!.args[0].input.RequestItems!;
      expect(requestItems[TABLE_NAME]).toHaveLength(2);
    });

    it("should throw when given more than 25 items", async () => {
      const assignments = Array.from({ length: 30 }, (_, i) => {
        const userId = `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
        return makeUserAssignment({
          pk: userPk(userId),
          userId: userId,
          sk: leaseSk(VALID_UUID),
          assigneeEmail: `user${i}@example.com`,
        });
      });

      await expect(store.batchPutAssignments(assignments)).rejects.toThrow(
        "batchPutAssignments accepts at most 25 items, received 30",
      );

      expect(mockDynamoClient.commandCalls(BatchWriteCommand)).toHaveLength(0);
    });

    it("should handle empty assignments array", async () => {
      await store.batchPutAssignments([]);

      const batchCalls = mockDynamoClient.commandCalls(BatchWriteCommand);
      expect(batchCalls).toHaveLength(0);
    });

    it("should accept exactly 25 items", async () => {
      mockDynamoClient.on(BatchWriteCommand).resolves({});

      const assignments = Array.from({ length: 25 }, (_, i) => {
        const userId = `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
        return makeUserAssignment({
          pk: userPk(userId),
          userId: userId,
          sk: leaseSk(VALID_UUID),
        });
      });

      await store.batchPutAssignments(assignments);

      const batchCalls = mockDynamoClient.commandCalls(BatchWriteCommand);
      expect(batchCalls).toHaveLength(1);
      expect(
        batchCalls[0]!.args[0].input.RequestItems![TABLE_NAME],
      ).toHaveLength(25);
    });

    it("should retry unprocessed items with backoff", async () => {
      vi.useRealTimers();

      const userId = "00000000-0000-4000-8000-000000000002";
      const unprocessedItem = {
        PutRequest: {
          Item: makeUserAssignment({
            pk: userPk(userId),
            userId: userId,
            assigneeEmail: "user2@example.com",
          }),
        },
      };

      mockDynamoClient
        .on(BatchWriteCommand)
        .resolvesOnce({
          UnprocessedItems: { [TABLE_NAME]: [unprocessedItem] },
        })
        .resolvesOnce({
          UnprocessedItems: {},
        });

      await store.batchPutAssignments([
        makeUserAssignment(),
        makeUserAssignment({
          pk: userPk(userId),
          userId: userId,
          assigneeEmail: "user2@example.com",
        }),
      ]);

      const batchCalls = mockDynamoClient.commandCalls(BatchWriteCommand);
      expect(batchCalls).toHaveLength(2);
      expect(
        batchCalls[1]!.args[0].input.RequestItems![TABLE_NAME],
      ).toHaveLength(1);
    });

    it("should throw after max retries with unprocessed items", async () => {
      vi.useRealTimers();

      const unprocessedItem = {
        PutRequest: { Item: makeUserAssignment() },
      };

      mockDynamoClient.on(BatchWriteCommand).resolves({
        UnprocessedItems: { [TABLE_NAME]: [unprocessedItem] },
      });

      await expect(
        store.batchPutAssignments([makeUserAssignment()]),
      ).rejects.toThrow(BatchUnprocessedItemsError);

      // 4 attempts total (numOfAttempts: 4)
      expect(mockDynamoClient.commandCalls(BatchWriteCommand)).toHaveLength(4);
    });
  });

  describe("getAllGroupAssignmentKeys (GroupIndex GSI scan)", () => {
    it("should scan GroupIndex GSI and return group IDs, lease IDs, and real sort keys", async () => {
      mockDynamoClient.on(ScanCommand).resolves({
        Items: [
          {
            groupId: VALID_UUID,
            pk: groupPk(VALID_UUID),
            sk: leaseSk(VALID_UUID),
          },
          {
            groupId: VALID_UUID_2,
            pk: groupPk(VALID_UUID_2),
            sk: leaseSk(VALID_UUID_2),
          },
        ],
      });

      const result = await store.getAllGroupAssignmentKeys();

      expect(result).toHaveLength(2);
      expect(result).toContainEqual({
        groupId: VALID_UUID,
        leaseId: VALID_UUID,
        sk: leaseSk(VALID_UUID),
      });
      expect(result).toContainEqual({
        groupId: VALID_UUID_2,
        leaseId: VALID_UUID_2,
        sk: leaseSk(VALID_UUID_2),
      });

      const scanCalls = mockDynamoClient.commandCalls(ScanCommand);
      expect(scanCalls[0]!.args[0].input.IndexName).toBe("GroupIndex");
    });

    it("should preserve duplicate (groupId, leaseId) tuples for caller dedup", async () => {
      // The same groupId can appear multiple times if it's assigned to multiple
      // leases (different leaseIds). Same (groupId, leaseId) should not happen
      // in practice but the scan does no dedup.
      mockDynamoClient.on(ScanCommand).resolves({
        Items: [
          {
            groupId: VALID_UUID,
            pk: groupPk(VALID_UUID),
            sk: leaseSk(VALID_UUID),
          },
          {
            groupId: VALID_UUID,
            pk: groupPk(VALID_UUID),
            sk: leaseSk(VALID_UUID_2),
          },
        ],
      });

      const result = await store.getAllGroupAssignmentKeys();

      expect(result).toHaveLength(2);
      expect(result).toContainEqual({
        groupId: VALID_UUID,
        leaseId: VALID_UUID,
        sk: leaseSk(VALID_UUID),
      });
      expect(result).toContainEqual({
        groupId: VALID_UUID,
        leaseId: VALID_UUID_2,
        sk: leaseSk(VALID_UUID_2),
      });
    });

    it("should handle paginated scan results", async () => {
      mockDynamoClient
        .on(ScanCommand)
        .resolvesOnce({
          Items: [
            {
              groupId: VALID_UUID,
              pk: groupPk(VALID_UUID),
              sk: leaseSk(VALID_UUID),
            },
          ],
          LastEvaluatedKey: { groupId: VALID_UUID },
        })
        .resolvesOnce({
          Items: [
            {
              groupId: VALID_UUID_2,
              pk: groupPk(VALID_UUID_2),
              sk: leaseSk(VALID_UUID_2),
            },
          ],
        });

      const result = await store.getAllGroupAssignmentKeys();

      expect(result).toEqual([
        { groupId: VALID_UUID, leaseId: VALID_UUID, sk: leaseSk(VALID_UUID) },
        {
          groupId: VALID_UUID_2,
          leaseId: VALID_UUID_2,
          sk: leaseSk(VALID_UUID_2),
        },
      ]);
      expect(mockDynamoClient.commandCalls(ScanCommand)).toHaveLength(2);
    });

    it("should return empty array when no group assignments exist", async () => {
      mockDynamoClient.on(ScanCommand).resolves({ Items: [] });

      const result = await store.getAllGroupAssignmentKeys();

      expect(result).toHaveLength(0);
    });

    it("should drop records that fail PersistedGroupIndexProjectionSchema validation", async () => {
      // Each input record fails one or more schema constraints: bad groupId
      // format, pk pointing at the wrong principal type, and sk that isn't
      // `lease#<UUID>`. Only the first record passes and survives.
      mockDynamoClient.on(ScanCommand).resolves({
        Items: [
          {
            groupId: VALID_UUID,
            pk: groupPk(VALID_UUID),
            sk: leaseSk(VALID_UUID),
          },
          // groupId is not a valid IDC principal ID
          {
            groupId: "not-an-idc-id",
            pk: groupPk(VALID_UUID),
            sk: leaseSk(VALID_UUID),
          },
          // pk is for a user, not a group
          {
            groupId: VALID_UUID,
            pk: userPk(VALID_UUID),
            sk: leaseSk(VALID_UUID),
          },
          // sk has lease# prefix but the UUID portion is malformed
          {
            groupId: VALID_UUID,
            pk: groupPk(VALID_UUID),
            sk: "lease#not-a-uuid",
          },
          // sk doesn't start with lease# at all
          {
            groupId: VALID_UUID,
            pk: groupPk(VALID_UUID),
            sk: "groupMembership",
          },
          // groupId is missing entirely
          { pk: groupPk(VALID_UUID), sk: leaseSk(VALID_UUID) },
        ],
      });

      const result = await store.getAllGroupAssignmentKeys();

      expect(result).toEqual([
        { groupId: VALID_UUID, leaseId: VALID_UUID, sk: leaseSk(VALID_UUID) },
      ]);
    });

    it("preserves tuple-keyed sort keys while parsing their lease IDs", async () => {
      const sk = assignmentSk(VALID_UUID, CUSTOM_PERMISSION_SET_ID);
      mockDynamoClient.on(ScanCommand).resolves({
        Items: [{ groupId: VALID_UUID, pk: groupPk(VALID_UUID), sk }],
      });

      await expect(store.getAllGroupAssignmentKeys()).resolves.toEqual([
        { groupId: VALID_UUID, leaseId: VALID_UUID, sk },
      ]);
    });
  });

  describe("listAllAssignments (LeaseIndex GSI scan)", () => {
    it("should return empty result when no items in GSI", async () => {
      mockDynamoClient.on(ScanCommand).resolves({ Items: [] });

      const result = await store.listAllAssignments({});

      expect(result.result).toHaveLength(0);
      expect(result.nextPageIdentifier).toBeNull();

      const scanCalls = mockDynamoClient.commandCalls(ScanCommand);
      expect(scanCalls).toHaveLength(1);
      expect(scanCalls[0]!.args[0].input.IndexName).toBe("LeaseIndex");
    });

    it("should parse user and group assignments correctly from a single page", async () => {
      const userItem = makeUserAssignment({
        leaseId: VALID_UUID,
        userId: VALID_UUID,
        pk: userPk(VALID_UUID),
        sk: leaseSk(VALID_UUID),
      });
      const groupItem = makeGroupAssignment({
        leaseId: VALID_UUID_2,
        groupId: VALID_UUID_2,
        pk: groupPk(VALID_UUID_2),
        sk: leaseSk(VALID_UUID_2),
      });

      mockDynamoClient.on(ScanCommand).resolves({
        Items: [userItem, groupItem],
      });

      const result = await store.listAllAssignments({});

      expect(result.result).toHaveLength(2);
      expect(result.result[0]!.principalType).toBe("USER");
      expect(result.result[0]!.leaseId).toBe(VALID_UUID);
      expect(result.result[1]!.principalType).toBe("GROUP");
      expect(result.result[1]!.leaseId).toBe(VALID_UUID_2);
      expect(result.nextPageIdentifier).toBeNull();
    });

    it("should handle pagination via ExclusiveStartKey/LastEvaluatedKey", async () => {
      const userItem = makeUserAssignment({
        leaseId: VALID_UUID,
        userId: VALID_UUID,
        pk: userPk(VALID_UUID),
        sk: leaseSk(VALID_UUID),
      });

      const lastEvaluatedKey = {
        pk: userPk(VALID_UUID),
        sk: leaseSk(VALID_UUID),
        leaseId: VALID_UUID,
      };
      mockDynamoClient.on(ScanCommand).resolves({
        Items: [userItem],
        LastEvaluatedKey: lastEvaluatedKey,
      });

      // First call without pageIdentifier
      const result = await store.listAllAssignments({});

      expect(result.result).toHaveLength(1);
      expect(result.nextPageIdentifier).not.toBeNull();

      // Second call with the pageIdentifier from the first response
      const secondUserItem = makeUserAssignment({
        leaseId: VALID_UUID_2,
        userId: VALID_UUID_2,
        pk: userPk(VALID_UUID_2),
        sk: leaseSk(VALID_UUID_2),
      });

      mockDynamoClient.on(ScanCommand).resolves({
        Items: [secondUserItem],
      });

      const result2 = await store.listAllAssignments({
        pageIdentifier: result.nextPageIdentifier!,
      });

      expect(result2.result).toHaveLength(1);
      expect(result2.result[0]!.leaseId).toBe(VALID_UUID_2);
      expect(result2.nextPageIdentifier).toBeNull();

      // Verify ExclusiveStartKey was passed on the second call
      const scanCalls = mockDynamoClient.commandCalls(ScanCommand);
      expect(scanCalls[1]!.args[0].input.ExclusiveStartKey).toBeDefined();
    });

    it("should skip items that fail Zod schema validation", async () => {
      const validUserItem = makeUserAssignment({
        leaseId: VALID_UUID,
        userId: VALID_UUID,
        pk: userPk(VALID_UUID),
        sk: leaseSk(VALID_UUID),
      });

      mockDynamoClient.on(ScanCommand).resolves({
        Items: [
          validUserItem,
          // Missing required fields (e.g., no principalType discriminator)
          { pk: "invalid", sk: "invalid", leaseId: VALID_UUID },
          // Invalid principalType value
          {
            pk: userPk(VALID_UUID),
            sk: leaseSk(VALID_UUID_2),
            userId: VALID_UUID,
            principalType: "INVALID",
            leaseId: VALID_UUID_2,
          },
        ],
      });

      const result = await store.listAllAssignments({});

      expect(result.result).toHaveLength(1);
      expect(result.result[0]!.leaseId).toBe(VALID_UUID);
    });
  });

  describe("batchGetGroupAssignments", () => {
    it("should return empty array for empty input without calling DynamoDB", async () => {
      const result = await store.batchGetGroupAssignments([]);

      expect(result).toEqual([]);
      expect(mockDynamoClient.commandCalls(BatchGetCommand)).toHaveLength(0);
    });

    it("should fetch assignments by (groupId, sk) using the base table", async () => {
      const tupleSk = assignmentSk(VALID_UUID, CUSTOM_PERMISSION_SET_ID);
      const item1 = makeGroupAssignment({
        sk: tupleSk,
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      });
      const item2 = makeGroupAssignment({
        sk: leaseSk(VALID_UUID_2),
        leaseId: VALID_UUID_2,
        groupId: VALID_UUID_2,
        pk: groupPk(VALID_UUID_2),
      });

      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [item1, item2] },
      });

      const result = await store.batchGetGroupAssignments([
        { groupId: VALID_UUID, sk: tupleSk },
        { groupId: VALID_UUID_2, sk: leaseSk(VALID_UUID_2) },
      ]);

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(item1);
      expect(result).toContainEqual(item2);

      const calls = mockDynamoClient.commandCalls(BatchGetCommand);
      expect(calls).toHaveLength(1);
      const sentKeys = calls[0]!.args[0].input.RequestItems![TABLE_NAME]!.Keys!;
      expect(sentKeys).toHaveLength(2);
      expect(sentKeys).toContainEqual({
        pk: groupPk(VALID_UUID),
        sk: tupleSk,
      });
      expect(sentKeys).toContainEqual({
        pk: groupPk(VALID_UUID_2),
        sk: leaseSk(VALID_UUID_2),
      });
    });

    it("should silently omit assignments that don't exist in the table", async () => {
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [] },
      });

      const result = await store.batchGetGroupAssignments([
        { groupId: VALID_UUID, sk: leaseSk(VALID_UUID) },
      ]);

      expect(result).toEqual([]);
    });

    it("should drop records that fail PersistedGroupAssignmentSchema validation", async () => {
      // BatchGetItem can return records that exist physically but don't
      // satisfy the application-level schema (e.g., legacy records, partial
      // writes from a failed transaction, or attribute-level corruption).
      // parseResults validates every item and drops the bad ones.
      const validItem = makeGroupAssignment();
      const wrongPrincipalType = makeGroupAssignment({
        sk: leaseSk(VALID_UUID_2),
        leaseId: VALID_UUID_2,
        principalType: "USER", // PersistedGroupAssignmentSchema requires "GROUP"
      });
      // Record missing required `displayName` field.
      const missingGroupName = {
        ...makeGroupAssignment({
          sk: leaseSk(VALID_UUID),
          leaseId: VALID_UUID,
          groupId: VALID_UUID_2,
          pk: groupPk(VALID_UUID_2),
        }),
      };
      delete (missingGroupName as Record<string, unknown>)["displayName"];

      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: {
          [TABLE_NAME]: [validItem, wrongPrincipalType, missingGroupName],
        },
      });

      const result = await store.batchGetGroupAssignments([
        { groupId: VALID_UUID, sk: leaseSk(VALID_UUID) },
        { groupId: VALID_UUID, sk: leaseSk(VALID_UUID_2) },
        { groupId: VALID_UUID_2, sk: leaseSk(VALID_UUID) },
      ]);

      expect(result).toEqual([validItem]);
    });

    it("should dedupe input keys before sending to BatchGetItem", async () => {
      const item = makeGroupAssignment();
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [item] },
      });

      await store.batchGetGroupAssignments([
        { groupId: VALID_UUID, sk: leaseSk(VALID_UUID) },
        { groupId: VALID_UUID, sk: leaseSk(VALID_UUID) },
        { groupId: VALID_UUID, sk: leaseSk(VALID_UUID) },
      ]);

      const calls = mockDynamoClient.commandCalls(BatchGetCommand);
      expect(calls).toHaveLength(1);
      const sentKeys = calls[0]!.args[0].input.RequestItems![TABLE_NAME]!.Keys!;
      expect(sentKeys).toHaveLength(1);
    });

    it("should chunk inputs in batches of 100 keys", async () => {
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [] },
      });

      const keys = Array.from({ length: 250 }, (_, i) => ({
        groupId: VALID_UUID,
        sk: leaseSk(
          `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
        ),
      }));

      await store.batchGetGroupAssignments(keys);

      const calls = mockDynamoClient.commandCalls(BatchGetCommand);
      // 250 keys → 100 + 100 + 50 = 3 calls
      expect(calls).toHaveLength(3);
      const sizes = calls
        .map((c) => c.args[0].input.RequestItems![TABLE_NAME]!.Keys!.length)
        .sort((a, b) => a - b);
      expect(sizes).toEqual([50, 100, 100]);
    });

    it("should retry unprocessed keys with backoff", async () => {
      vi.useRealTimers();

      const item = makeGroupAssignment();
      mockDynamoClient
        .on(BatchGetCommand)
        .resolvesOnce({
          Responses: { [TABLE_NAME]: [] },
          UnprocessedKeys: {
            [TABLE_NAME]: {
              Keys: [{ pk: groupPk(VALID_UUID), sk: leaseSk(VALID_UUID) }],
            },
          },
        })
        .resolvesOnce({
          Responses: { [TABLE_NAME]: [item] },
        });

      const result = await store.batchGetGroupAssignments([
        { groupId: VALID_UUID, sk: leaseSk(VALID_UUID) },
      ]);

      expect(result).toEqual([item]);
      expect(mockDynamoClient.commandCalls(BatchGetCommand)).toHaveLength(2);
    });

    it("should give up after 4 retry attempts", async () => {
      vi.useRealTimers();

      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [] },
        UnprocessedKeys: {
          [TABLE_NAME]: {
            Keys: [{ pk: groupPk(VALID_UUID), sk: leaseSk(VALID_UUID) }],
          },
        },
      });

      await expect(
        store.batchGetGroupAssignments([
          { groupId: VALID_UUID, sk: leaseSk(VALID_UUID) },
        ]),
      ).rejects.toThrow(BatchUnprocessedItemsError);

      expect(mockDynamoClient.commandCalls(BatchGetCommand)).toHaveLength(4);
    });
  });

  function testCacheItem(index: number, overrides = {}) {
    const id = crypto.randomUUID();
    return {
      pk: "principalCache" as const,
      sk: `user#${id}`,
      principalId: id,
      principalType: "USER" as const,
      displayName: `User ${index}`,
      syncedAt: NOW,
      ttl: Math.floor(Date.now() / 1000) + 172800,
      ...overrides,
    };
  }

  describe("batchPutCacheItems", () => {
    it("should do nothing for empty array", async () => {
      await store.batchPutCacheItems([]);
      expect(mockDynamoClient.commandCalls(BatchWriteCommand)).toHaveLength(0);
    });

    it("should write items in chunks of 25", async () => {
      mockDynamoClient.on(BatchWriteCommand).resolves({});

      const items = Array.from({ length: 30 }, (_, i) => testCacheItem(i));

      await store.batchPutCacheItems(items);

      const calls = mockDynamoClient.commandCalls(BatchWriteCommand);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.args[0].input.RequestItems![TABLE_NAME]).toHaveLength(
        25,
      );
      expect(calls[1]!.args[0].input.RequestItems![TABLE_NAME]).toHaveLength(5);
    });

    it("should deduplicate puts by sort key", async () => {
      mockDynamoClient.on(BatchWriteCommand).resolves({});
      const first = testCacheItem(1, { displayName: "First" });
      const replacement = { ...first, displayName: "Replacement" };

      await store.batchPutCacheItems([first, replacement]);

      const requests =
        mockDynamoClient.commandCalls(BatchWriteCommand)[0]!.args[0].input
          .RequestItems![TABLE_NAME];
      expect(requests).toHaveLength(1);
      expect(requests![0]!.PutRequest!.Item!.displayName).toBe("Replacement");
    });

    it("should retry on unprocessed items", async () => {
      vi.useRealTimers();
      const item = testCacheItem(1);

      mockDynamoClient
        .on(BatchWriteCommand)
        .resolvesOnce({
          UnprocessedItems: {
            [TABLE_NAME]: [{ PutRequest: { Item: item } }],
          },
        })
        .resolvesOnce({});

      await store.batchPutCacheItems([item]);

      expect(mockDynamoClient.commandCalls(BatchWriteCommand)).toHaveLength(2);
    });
  });

  describe("getCacheItems", () => {
    it("should return items filtered by type", async () => {
      const userItem = testCacheItem(1, { email: "u1@example.com" });
      mockDynamoClient.on(QueryCommand).resolves({ Items: [userItem] });

      const result = await store.getCacheItems({ type: "USER" });

      expect(result).toHaveLength(1);
      expect(result[0]!.principalId).toBe(userItem.principalId);
    });

    it("should paginate through multiple query pages", async () => {
      const item1 = testCacheItem(1);
      const item2 = testCacheItem(2);

      mockDynamoClient
        .on(QueryCommand)
        .resolvesOnce({
          Items: [item1],
          LastEvaluatedKey: { pk: item1.pk, sk: item1.sk },
        })
        .resolvesOnce({
          Items: [item2],
        });

      const result = await store.getCacheItems({});

      expect(result).toHaveLength(2);
    });

    it("should skip items that fail schema validation", async () => {
      mockDynamoClient.on(QueryCommand).resolves({
        Items: [
          testCacheItem(1, { displayName: "Valid" }),
          { pk: "principalCache", sk: "user#bad", principalId: "" }, // invalid
        ],
      });

      const result = await store.getCacheItems({});

      expect(result).toHaveLength(1);
    });
  });

  describe("batchDeleteCacheItemsBySk", () => {
    it("should do nothing for empty array", async () => {
      await store.batchDeleteCacheItemsBySk([]);
      expect(mockDynamoClient.commandCalls(BatchWriteCommand)).toHaveLength(0);
    });

    it("should deduplicate deletes by sort key", async () => {
      mockDynamoClient.on(BatchWriteCommand).resolves({});
      const sk = `user#${crypto.randomUUID()}`;

      await store.batchDeleteCacheItemsBySk([sk, sk]);

      expect(
        mockDynamoClient.commandCalls(BatchWriteCommand)[0]!.args[0].input
          .RequestItems![TABLE_NAME],
      ).toEqual([
        {
          DeleteRequest: { Key: { pk: "principalCache", sk } },
        },
      ]);
    });

    it("should delete items in chunks of 25", async () => {
      mockDynamoClient.on(BatchWriteCommand).resolves({});

      const sks = Array.from(
        { length: 30 },
        () => `user#${crypto.randomUUID()}`,
      );
      await store.batchDeleteCacheItemsBySk(sks);

      const calls = mockDynamoClient.commandCalls(BatchWriteCommand);
      expect(calls).toHaveLength(2);
    });
  });

  describe("permission set cache CRUD", () => {
    it("writes permission set cache items in batches and retries unprocessed items", async () => {
      vi.useRealTimers();
      const item = makePermissionSetCacheItem();
      mockDynamoClient
        .on(BatchWriteCommand)
        .resolvesOnce({
          UnprocessedItems: {
            [TABLE_NAME]: [{ PutRequest: { Item: item } }],
          },
        })
        .resolvesOnce({});

      await store.batchPutPermissionSetCacheItems([item]);

      expect(mockDynamoClient.commandCalls(BatchWriteCommand)).toHaveLength(2);
    });

    it("deduplicates permission set cache puts by sort key", async () => {
      mockDynamoClient.on(BatchWriteCommand).resolves({});
      const first = makePermissionSetCacheItem({ name: "First" });
      const replacement = { ...first, name: "Replacement" };

      await store.batchPutPermissionSetCacheItems([first, replacement]);

      const requests =
        mockDynamoClient.commandCalls(BatchWriteCommand)[0]!.args[0].input
          .RequestItems![TABLE_NAME];
      expect(requests).toHaveLength(1);
      expect(requests![0]!.PutRequest!.Item!.name).toBe("Replacement");
    });

    it("chunks permission set cache puts into batches of 25", async () => {
      mockDynamoClient.on(BatchWriteCommand).resolves({});
      const items = Array.from({ length: 26 }, () =>
        makePermissionSetCacheItem(),
      );

      await store.batchPutPermissionSetCacheItems(items);

      const sizes = mockDynamoClient
        .commandCalls(BatchWriteCommand)
        .map((call) => call.args[0].input.RequestItems![TABLE_NAME]!.length)
        .sort((a, b) => a - b);
      expect(sizes).toEqual([1, 25]);
    });

    it("reads one registration consistently from its canonical key", async () => {
      const item = makePermissionSetCacheItem();
      mockDynamoClient.on(GetCommand).resolves({ Item: item });
      await expect(
        store.getPermissionSetCacheItem(item.permissionSetId),
      ).resolves.toEqual(item);
      expect(
        mockDynamoClient.commandCalls(GetCommand)[0]!.args[0].input,
      ).toEqual({
        TableName: TABLE_NAME,
        Key: { pk: PERMISSION_SET_CACHE_PK, sk: item.sk },
        ConsistentRead: true,
      });
    });

    it.each([undefined, { pk: PERMISSION_SET_CACHE_PK }])(
      "does not authorize missing or invalid registration metadata",
      async (Item) => {
        mockDynamoClient.on(GetCommand).resolves({ Item });
        await expect(
          store.getPermissionSetCacheItem(CUSTOM_PERMISSION_SET_ID),
        ).resolves.toBeUndefined();
      },
    );

    it("propagates transient registration read failures", async () => {
      mockDynamoClient.on(GetCommand).rejects(new Error("read unavailable"));
      await expect(
        store.getPermissionSetCacheItem(CUSTOM_PERMISSION_SET_ID),
      ).rejects.toThrow("read unavailable");
    });

    it("uses consistent reads for every catalog page when authorizing API grants", async () => {
      const item = makePermissionSetCacheItem();
      mockDynamoClient
        .on(QueryCommand)
        .resolvesOnce({
          Items: [item],
          LastEvaluatedKey: { pk: item.pk, sk: item.sk },
        })
        .resolvesOnce({ Items: [] });
      await store.getPermissionSetCacheItems({ consistentRead: true });
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(2);
      for (const call of mockDynamoClient.commandCalls(QueryCommand))
        expect(call.args[0].input.ConsistentRead).toBe(true);
    });

    it("queries and validates every item in the permission set cache partition", async () => {
      const first = makePermissionSetCacheItem();
      const second = makePermissionSetCacheItem();
      mockDynamoClient
        .on(QueryCommand)
        .resolvesOnce({
          Items: [first],
          LastEvaluatedKey: { pk: first.pk, sk: first.sk },
        })
        .resolvesOnce({ Items: [second] });

      const result = await store.getPermissionSetCacheItems();

      expect(result).toEqual([first, second]);
      const calls = mockDynamoClient.commandCalls(QueryCommand);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.args[0].input.ExpressionAttributeValues).toEqual({
        ":pk": PERMISSION_SET_CACHE_PK,
      });
      expect(calls[1]!.args[0].input.ExclusiveStartKey).toEqual({
        pk: first.pk,
        sk: first.sk,
      });
    });

    it("drops and warns about invalid permission set cache records", async () => {
      const valid = makePermissionSetCacheItem();
      const warn = vi
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      mockDynamoClient.on(QueryCommand).resolves({
        Items: [valid, { pk: PERMISSION_SET_CACHE_PK }],
      });

      await expect(store.getPermissionSetCacheItems()).resolves.toEqual([
        valid,
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(LogPatterns.DataValidationWarning.pattern),
        {
          invalidRecordCount: 1,
          error: expect.stringContaining("1 invalid records found"),
        },
      );
    });

    it("deletes permission set cache entries by their supplied sort keys", async () => {
      mockDynamoClient.on(BatchWriteCommand).resolves({});
      const first = makePermissionSetCacheItem();
      const second = makePermissionSetCacheItem();

      await store.batchDeletePermissionSetCacheItemsBySk([first.sk, second.sk]);

      expect(
        mockDynamoClient.commandCalls(BatchWriteCommand)[0]!.args[0].input
          .RequestItems![TABLE_NAME],
      ).toEqual([
        {
          DeleteRequest: { Key: { pk: PERMISSION_SET_CACHE_PK, sk: first.sk } },
        },
        {
          DeleteRequest: {
            Key: { pk: PERMISSION_SET_CACHE_PK, sk: second.sk },
          },
        },
      ]);
    });

    it("deduplicates permission set cache deletes by sort key", async () => {
      mockDynamoClient.on(BatchWriteCommand).resolves({});
      const item = makePermissionSetCacheItem();

      await store.batchDeletePermissionSetCacheItemsBySk([item.sk, item.sk]);

      expect(
        mockDynamoClient.commandCalls(BatchWriteCommand)[0]!.args[0].input
          .RequestItems![TABLE_NAME],
      ).toHaveLength(1);
    });

    it("chunks permission set cache deletes into batches of 25", async () => {
      mockDynamoClient.on(BatchWriteCommand).resolves({});
      const sks = Array.from(
        { length: 26 },
        () => makePermissionSetCacheItem().sk,
      );

      await store.batchDeletePermissionSetCacheItemsBySk(sks);

      const sizes = mockDynamoClient
        .commandCalls(BatchWriteCommand)
        .map((call) => call.args[0].input.RequestItems![TABLE_NAME]!.length)
        .sort((a, b) => a - b);
      expect(sizes).toEqual([1, 25]);
    });

    it("retries only unprocessed permission set cache deletes", async () => {
      vi.useRealTimers();
      const first = makePermissionSetCacheItem();
      const second = makePermissionSetCacheItem();
      const unprocessedDelete = {
        DeleteRequest: {
          Key: { pk: PERMISSION_SET_CACHE_PK, sk: second.sk },
        },
      };
      mockDynamoClient
        .on(BatchWriteCommand)
        .resolvesOnce({
          UnprocessedItems: {
            [TABLE_NAME]: [unprocessedDelete],
          },
        })
        .resolvesOnce({});

      await store.batchDeletePermissionSetCacheItemsBySk([first.sk, second.sk]);

      const calls = mockDynamoClient.commandCalls(BatchWriteCommand);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.args[0].input.RequestItems![TABLE_NAME]).toEqual([
        unprocessedDelete,
      ]);
    });
  });

  describe("batchGetCacheItems", () => {
    it("should return empty array for empty input", async () => {
      const result = await store.batchGetCacheItems([]);
      expect(result).toEqual([]);
      expect(mockDynamoClient.commandCalls(BatchGetCommand)).toHaveLength(0);
    });

    it("should retrieve cache items by principalId and type", async () => {
      const item = testCacheItem(1);

      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [item] },
      });

      const result = await store.batchGetCacheItems([
        { principalId: item.principalId, principalType: "USER" },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0]!.principalId).toBe(item.principalId);
      expect(result[0]!.displayName).toBe(item.displayName);

      const calls = mockDynamoClient.commandCalls(BatchGetCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input.RequestItems![TABLE_NAME]!.Keys).toEqual([
        { pk: "principalCache", sk: `user#${item.principalId}` },
      ]);
    });

    it("should construct correct sk prefix for GROUP type", async () => {
      const groupId = crypto.randomUUID();
      const groupItem = testCacheItem(1, {
        sk: `group#${groupId}`,
        principalId: groupId,
        principalType: "GROUP",
        displayName: "Engineering",
      });

      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [groupItem] },
      });

      const result = await store.batchGetCacheItems([
        { principalId: groupId, principalType: "GROUP" },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0]!.displayName).toBe("Engineering");

      const calls = mockDynamoClient.commandCalls(BatchGetCommand);
      expect(calls[0]!.args[0].input.RequestItems![TABLE_NAME]!.Keys).toEqual([
        { pk: "principalCache", sk: `group#${groupId}` },
      ]);
    });

    it("should retry unprocessed keys", async () => {
      vi.useRealTimers();
      const item = testCacheItem(1);

      mockDynamoClient
        .on(BatchGetCommand)
        .resolvesOnce({
          Responses: { [TABLE_NAME]: [] },
          UnprocessedKeys: {
            [TABLE_NAME]: {
              Keys: [{ pk: "principalCache", sk: item.sk }],
            },
          },
        })
        .resolvesOnce({
          Responses: { [TABLE_NAME]: [item] },
        });

      const result = await store.batchGetCacheItems([
        { principalId: item.principalId, principalType: "USER" },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0]!.principalId).toBe(item.principalId);
      expect(mockDynamoClient.commandCalls(BatchGetCommand)).toHaveLength(2);
    });

    it("should return empty array when items do not exist in cache", async () => {
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [] },
      });

      const result = await store.batchGetCacheItems([
        { principalId: crypto.randomUUID(), principalType: "USER" },
      ]);

      expect(result).toEqual([]);
    });
  });
});
