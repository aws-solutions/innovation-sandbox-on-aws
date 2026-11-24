// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PermissionSetSummarySchema } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

import {
  alwaysPresentOnOutput,
  expectMemberTypeParity,
  modelHttpOperation,
  modelMember,
  modelMemberTrait,
  modelMembers,
  modelQueryParameters,
  modelRequired,
  modelShape,
  zodMembers,
} from "./parity-helpers.js";

const permissionSetSummaryShape = PermissionSetSummarySchema.shape as Record<
  string,
  z.ZodType
>;

describe("PermissionSetSummary", () => {
  it("matches the internal permission-set summary projection", () => {
    expect(modelMembers("PermissionSetSummary")).toEqual(
      zodMembers(permissionSetSummaryShape),
    );
    expect(modelRequired("PermissionSetSummary")).toEqual(
      alwaysPresentOnOutput(permissionSetSummaryShape),
    );
    expectMemberTypeParity("PermissionSetSummary", permissionSetSummaryShape);
  });

  it("uses the shared constrained permission-set scalar shapes", () => {
    expect(modelMember("PermissionSetSummary", "permissionSetArn").target).toBe(
      "com.amazon.isb#PermissionSetArn",
    );
    expect(modelMember("PermissionSetSummary", "permissionSetId").target).toBe(
      "com.amazon.isb#PermissionSetId",
    );
    expect(modelMember("PermissionSetSummary", "name").target).toBe(
      "com.amazon.isb#PermissionSetName",
    );
    expect(modelMember("PermissionSetSummary", "description").target).toBe(
      "com.amazon.isb#PermissionSetDescription",
    );
    expect(modelMember("PermissionSetSummary", "sessionDuration").target).toBe(
      "com.amazon.isb#PermissionSetSessionDuration",
    );
  });

  it("pins every public permission-set scalar constraint", () => {
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

describe("ListPermissionSets", () => {
  it("owns the permission-set catalog route", () => {
    expect(modelHttpOperation("ListPermissionSets")).toEqual({
      method: "GET",
      uri: "/permissionSets",
      code: 200,
    });
  });

  it("preserves the established list query contract", () => {
    const params = Object.fromEntries(
      modelQueryParameters("ListPermissionSets").map((param) => [
        param.name,
        param,
      ]),
    );
    expect(Object.keys(params).sort()).toEqual([
      "maxResults",
      "pageIdentifier",
      "q",
    ]);
    expect(params.pageIdentifier?.target).toBe(
      "com.amazon.isb#ContinuationToken",
    );
    expect(params.maxResults?.target).toBe("smithy.api#Integer");
    expect(params.q?.target).toBe("smithy.api#String");
    expect(
      modelMemberTrait(
        "ListPermissionSetsInput",
        "maxResults",
        "smithy.api#range",
      ),
    ).toEqual({ min: 1, max: 100 });
    expect(
      modelMemberTrait("ListPermissionSetsInput", "q", "smithy.api#length"),
    ).toEqual({ max: 200 });
  });

  it("pins the generated paginator paths", () => {
    expect(
      modelShape("ListPermissionSets").traits?.["smithy.api#paginated"],
    ).toEqual({
      inputToken: "pageIdentifier",
      pageSize: "maxResults",
      outputToken: "data.nextPageIdentifier",
      items: "data.result",
    });
  });

  it("models the JSend page envelope", () => {
    expect(modelRequired("ListPermissionSetsOutput")).toEqual([
      "data",
      "status",
    ]);
    expect(modelMember("ListPermissionSetsOutput", "data").target).toBe(
      "com.amazon.isb#PermissionSetPage",
    );
    expect(modelRequired("PermissionSetPage")).toEqual(["result"]);
    expect(modelMember("PermissionSetPage", "result").target).toBe(
      "com.amazon.isb#PermissionSetSummaryList",
    );
    expect(modelMember("PermissionSetPage", "nextPageIdentifier").target).toBe(
      "com.amazon.isb#ContinuationToken",
    );
  });
});
