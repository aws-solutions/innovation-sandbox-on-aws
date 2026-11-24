// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for visibility-aware pagination in DynamoLeaseTemplateStore.
 *
 * A non-elevated caller must never be able to recover a PRIVATE template's
 * UUID — neither in the result set nor via the pagination token. The token is
 * derived from DynamoDB's LastEvaluatedKey, which points at the last *scanned*
 * item (not the last *returned* item), so a naive FilterExpression alone still
 * leaks the boundary key. These tests pin the leak-free contract.
 */

import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  base64DecodeCompositeKey,
  base64EncodeCompositeKey,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import { DynamoLeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/dynamo-lease-template-store.js";
import { PersistedLeaseTemplateSchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";

const mockDynamoClient = mockClient(DynamoDBDocumentClient);

describe("DynamoLeaseTemplateStore - visibility-aware pagination", () => {
  let store: DynamoLeaseTemplateStore;
  const tableName = "test-lease-template-table";

  beforeEach(() => {
    mockDynamoClient.reset();
    store = new DynamoLeaseTemplateStore({
      leaseTemplateTableName: tableName,
      client: mockDynamoClient as any,
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  test("rejects a pagination cursor whose key is not a lease-template UUID", async () => {
    const pageIdentifier = base64EncodeCompositeKey({ uuid: "not-a-uuid" });

    await expect(
      store.findAllVisible({
        pageIdentifier: pageIdentifier!,
        includePrivate: false,
      }),
    ).rejects.toThrow();
    expect(mockDynamoClient.commandCalls(ScanCommand)).toHaveLength(0);
  });

  test("does not leak a PRIVATE template UUID via nextPageIdentifier when the scan boundary is PRIVATE", async () => {
    const publicTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: "11111111-1111-4111-8111-111111111111",
      visibility: "PUBLIC",
    });
    const privateTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: "99999999-9999-4999-8999-999999999999",
      visibility: "PRIVATE",
    });

    // DynamoDB applies Limit BEFORE FilterExpression: it scans [public, private],
    // returns only the public item (private filtered server-side), but
    // LastEvaluatedKey still points at the private boundary item. With pageSize 1
    // the loop stops after this single scan.
    mockDynamoClient.on(ScanCommand).resolvesOnce({
      Items: [publicTemplate],
      LastEvaluatedKey: { uuid: privateTemplate.uuid },
    });

    const result = await store.findAllVisible({
      pageSize: 1,
      includePrivate: false,
    });

    // No PRIVATE item in the result.
    expect(result.result.map((t) => t.uuid)).not.toContain(
      privateTemplate.uuid,
    );

    // A token IS emitted (LastEvaluatedKey was set), and it must anchor to the
    // returned PUBLIC item, never the PRIVATE boundary item.
    expect(result.nextPageIdentifier).not.toBeNull();
    const decoded = base64DecodeCompositeKey(result.nextPageIdentifier!);
    expect(decoded?.uuid).toBe(publicTemplate.uuid);
    expect(decoded?.uuid).not.toBe(privateTemplate.uuid);

    // The query itself must exclude PRIVATE server-side (defense in depth: the
    // mock can't evaluate the filter, so pin the actual expression sent).
    const scanInput =
      mockDynamoClient.commandCalls(ScanCommand)[0]!.args[0].input;
    expect(scanInput.FilterExpression).toContain("<> :private");
    expect(scanInput.ExpressionAttributeValues).toMatchObject({
      ":private": "PRIVATE",
    });
  });

  test("keeps scanning across pages until pageSize PUBLIC items are collected", async () => {
    const pub1 = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: "11111111-1111-4111-8111-111111111111",
      visibility: "PUBLIC",
    });
    const priv = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: "99999999-9999-4999-8999-999999999999",
      visibility: "PRIVATE",
    });
    const pub2 = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: "22222222-2222-4222-8222-222222222222",
      visibility: "PUBLIC",
    });

    // Scan 1 (Limit 2) reads [pub1, priv] -> returns [pub1], boundary = priv.
    // Scan 2 reads [pub2] -> returns [pub2], table exhausted.
    mockDynamoClient
      .on(ScanCommand)
      .resolvesOnce({
        Items: [pub1],
        LastEvaluatedKey: { uuid: priv.uuid },
      })
      .resolvesOnce({
        Items: [pub2],
        LastEvaluatedKey: undefined,
      });

    const result = await store.findAllVisible({
      pageSize: 2,
      includePrivate: false,
    });

    // Both PUBLIC items collected across the two scans; PRIVATE never appears.
    expect(result.result.map((t) => t.uuid)).toEqual([pub1.uuid, pub2.uuid]);
    // Table exhausted -> no further pages.
    expect(result.nextPageIdentifier).toBeNull();

    // The second scan must resume exactly after scan 1's boundary, otherwise
    // real DynamoDB would skip or duplicate items.
    const scanCalls = mockDynamoClient.commandCalls(ScanCommand);
    expect(scanCalls).toHaveLength(2);
    expect(scanCalls[1]!.args[0].input.ExclusiveStartKey).toEqual({
      uuid: priv.uuid,
    });
  });

  test("returns an empty page with no token when every template is PRIVATE", async () => {
    const priv1 = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: "99999999-9999-4999-8999-999999999999",
      visibility: "PRIVATE",
    });

    // Both scans return zero PUBLIC items (DynamoDB filtered them out); the
    // loop keeps going until the table is exhausted, then terminates cleanly.
    mockDynamoClient
      .on(ScanCommand)
      .resolvesOnce({ Items: [], LastEvaluatedKey: { uuid: priv1.uuid } })
      .resolvesOnce({ Items: [], LastEvaluatedKey: undefined });

    const result = await store.findAllVisible({
      pageSize: 2,
      includePrivate: false,
    });

    expect(result.result).toEqual([]);
    expect(result.nextPageIdentifier).toBeNull();
  });

  test("does not drop PUBLIC items when the final scan overflows pageSize and exhausts the table", async () => {
    const pubA = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: "11111111-1111-4111-8111-111111111111",
      visibility: "PUBLIC",
    });
    const priv = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: "99999999-9999-4999-8999-999999999999",
      visibility: "PRIVATE",
    });
    const pubB = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: "22222222-2222-4222-8222-222222222222",
      visibility: "PUBLIC",
    });
    const pubC = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: "33333333-3333-4333-8333-333333333333",
      visibility: "PUBLIC",
    });

    // pageSize=2, scan order [pubA, priv, pubB, pubC]:
    // Scan 1 (Limit 2) reads [pubA, priv] -> returns [pubA], boundary = priv.
    // Scan 2 reads [pubB, pubC] -> returns both, table exhausted.
    // collected = [pubA, pubB, pubC] (overflows pageSize) at exhaustion.
    mockDynamoClient
      .on(ScanCommand)
      .resolvesOnce({
        Items: [pubA],
        LastEvaluatedKey: { uuid: priv.uuid },
      })
      .resolvesOnce({
        Items: [pubB, pubC],
        LastEvaluatedKey: undefined,
      });

    const result = await store.findAllVisible({
      pageSize: 2,
      includePrivate: false,
    });

    // pubC must not be silently lost: either it is returned in this page, or a
    // token is emitted so the next request can fetch it.
    const returnedUuids = result.result.map((t) => t.uuid);
    if (result.nextPageIdentifier === null) {
      expect(returnedUuids).toContain(pubC.uuid);
    } else {
      const decoded = base64DecodeCompositeKey(result.nextPageIdentifier);
      // The token must anchor to a returned PUBLIC item so pubC is reachable.
      expect(returnedUuids).toContain(decoded?.uuid);
      expect(decoded?.uuid).not.toBe(priv.uuid);
    }
  });

  test("emits a token anchored to a PUBLIC item when more pages remain", async () => {
    const pub1 = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: "11111111-1111-4111-8111-111111111111",
      visibility: "PUBLIC",
    });
    const pub2 = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: "22222222-2222-4222-8222-222222222222",
      visibility: "PUBLIC",
    });

    // One scan fills the page (Limit 2) and more items remain in the table.
    mockDynamoClient.on(ScanCommand).resolvesOnce({
      Items: [pub1, pub2],
      LastEvaluatedKey: { uuid: pub2.uuid },
    });

    const result = await store.findAllVisible({
      pageSize: 2,
      includePrivate: false,
    });

    expect(result.result.map((t) => t.uuid)).toEqual([pub1.uuid, pub2.uuid]);
    expect(result.nextPageIdentifier).not.toBeNull();
    const decoded = base64DecodeCompositeKey(result.nextPageIdentifier!);
    // Token anchors to the last RETURNED public item so the next page resumes
    // exactly after it — no items skipped, no private key leaked.
    expect(decoded?.uuid).toBe(pub2.uuid);
  });

  test("returns legacy templates that predate the visibility attribute", async () => {
    // Templates created before the visibility attribute existed have no
    // visibility field; the schema defaults them to PUBLIC on read, so they
    // must remain visible to non-elevated users.
    const legacyTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: "33333333-3333-4333-8333-333333333333",
    });
    // Simulate a stored item with no visibility attribute at all.
    delete (legacyTemplate as { visibility?: unknown }).visibility;

    mockDynamoClient.on(ScanCommand).resolves({
      Items: [legacyTemplate],
      LastEvaluatedKey: undefined,
    });

    const result = await store.findAllVisible({
      pageSize: 10,
      includePrivate: false,
    });

    expect(result.result.map((t) => t.uuid)).toContain(legacyTemplate.uuid);

    // The mock can't evaluate the FilterExpression, so pin that the query
    // actually uses attribute_not_exists to keep legacy (attribute-less) items.
    // A "#visibility = :public" filter would wrongly exclude them in real DynamoDB.
    const scanInput =
      mockDynamoClient.commandCalls(ScanCommand)[0]!.args[0].input;
    expect(scanInput.FilterExpression).toContain("attribute_not_exists");
  });

  test("elevated caller (includePrivate) still receives PRIVATE templates", async () => {
    const publicTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: "11111111-1111-4111-8111-111111111111",
      visibility: "PUBLIC",
    });
    const privateTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: "99999999-9999-4999-8999-999999999999",
      visibility: "PRIVATE",
    });

    mockDynamoClient.on(ScanCommand).resolves({
      Items: [publicTemplate, privateTemplate],
      LastEvaluatedKey: undefined,
    });

    const result = await store.findAllVisible({
      pageSize: 10,
      includePrivate: true,
    });

    expect(result.result.map((t) => t.uuid)).toContain(privateTemplate.uuid);
  });
});
