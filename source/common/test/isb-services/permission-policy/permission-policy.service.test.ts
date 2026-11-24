// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  GetInlinePolicyForPermissionSetCommand,
  GetPermissionsBoundaryForPermissionSetCommand,
  paginateListCustomerManagedPolicyReferencesInPermissionSet,
  paginateListManagedPoliciesInPermissionSet,
  PermissionsBoundary,
  ResourceNotFoundException,
  SSOAdminClient,
} from "@aws-sdk/client-sso-admin";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  InvalidPermissionSetPolicyError,
  PermissionSetPolicyTooLargeError,
  resolvePermissionSetPolicy,
  UnsupportedPermissionSetBoundaryError,
} from "@amzn/innovation-sandbox-commons/isb-services/permission-policy/index.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@aws-sdk/client-sso-admin", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@aws-sdk/client-sso-admin")>();
  return {
    ...actual,
    paginateListManagedPoliciesInPermissionSet: vi.fn(),
    paginateListCustomerManagedPolicyReferencesInPermissionSet: vi.fn(),
  };
});

const ssoAdminClient = new SSOAdminClient({});
const mockSso = mockClient(ssoAdminClient);

const INSTANCE_ARN = "arn:aws:sso:::instance/ssoins-test";
const PERMISSION_SET_ARN = "arn:aws:sso:::permissionSet/ssoins-test/ps-test";
const SANDBOX_ACCOUNT_ID = "222222222222";

/**
 * Casts an async generator factory to satisfy the Paginator mock signature.
 * Paginators require (config, input, ...rest) => Paginator<T>, which doesn't
 * match a plain generator factory. `as any` is the correct test-only escape
 * hatch here — the mock only needs to yield pages, not match the full signature.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asPaginator<T>(gen: () => AsyncGenerator<T, any, any>): any {
  return gen;
}

beforeEach(() => {
  mockSso.reset();
  // Default: no permissions boundary attached.
  mockSso.on(GetPermissionsBoundaryForPermissionSetCommand).resolves({});
  vi.mocked(paginateListManagedPoliciesInPermissionSet).mockImplementation(
    asPaginator(async function* () {}),
  );
  vi.mocked(
    paginateListCustomerManagedPolicyReferencesInPermissionSet,
  ).mockImplementation(asPaginator(async function* () {}));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockApis({
  inlinePolicy = "",
  managedPolicies = [] as { Arn: string; Name: string }[],
  customerManagedPolicies = [] as { Name: string; Path?: string }[],
  permissionsBoundary = undefined as PermissionsBoundary | undefined,
} = {}) {
  mockSso
    .on(GetInlinePolicyForPermissionSetCommand)
    .resolves({ InlinePolicy: inlinePolicy });
  mockSso
    .on(GetPermissionsBoundaryForPermissionSetCommand)
    .resolves({ PermissionsBoundary: permissionsBoundary });

  vi.mocked(paginateListManagedPoliciesInPermissionSet).mockImplementation(
    asPaginator(async function* () {
      yield { AttachedManagedPolicies: managedPolicies };
    }),
  );

  vi.mocked(
    paginateListCustomerManagedPolicyReferencesInPermissionSet,
  ).mockImplementation(
    asPaginator(async function* () {
      yield { CustomerManagedPolicyReferences: customerManagedPolicies };
    }),
  );
}

const defaultProps = {
  permissionSetArn: PERMISSION_SET_ARN,
  ssoInstanceArn: INSTANCE_ARN,
  sandboxAccountId: SANDBOX_ACCOUNT_ID,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("resolvePermissionSetPolicy", () => {
  it("resolves an inline policy into session policy statements", async () => {
    const inlinePolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }],
    });
    mockApis({ inlinePolicy });

    const result = await resolvePermissionSetPolicy(defaultProps, {
      ssoAdminClient,
    });

    expect(result.sessionPolicy!.Statement).toHaveLength(1);
    expect(result.sessionPolicy!.Statement[0]).toMatchObject({
      Effect: "Allow",
      Action: "s3:GetObject",
    });
    expect(result.managedPolicyArns).toEqual([]);
  });

  it("returns AWS-managed policy ARNs in managedPolicyArns (not inlined)", async () => {
    mockApis({
      managedPolicies: [
        {
          Arn: "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
          Name: "AmazonS3ReadOnlyAccess",
        },
        {
          Arn: "arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess",
          Name: "AmazonEC2ReadOnlyAccess",
        },
      ],
    });

    const result = await resolvePermissionSetPolicy(defaultProps, {
      ssoAdminClient,
    });

    expect(result.managedPolicyArns).toEqual([
      "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
      "arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess",
    ]);
    // No inline statements — sessionPolicy is undefined, not an empty Statement[]
    expect(result.sessionPolicy).toBeUndefined();
  });

  it("constructs customer-managed policy ARN and adds to managedPolicyArns", async () => {
    mockApis({
      customerManagedPolicies: [{ Name: "MyCustomPolicy", Path: "/" }],
    });

    const result = await resolvePermissionSetPolicy(defaultProps, {
      ssoAdminClient,
    });

    expect(result.managedPolicyArns).toContain(
      `arn:aws:iam::${SANDBOX_ACCOUNT_ID}:policy/MyCustomPolicy`,
    );
    // No inline content — sessionPolicy is undefined
    expect(result.sessionPolicy).toBeUndefined();
  });

  it("combines inline + managed + customer-managed policies correctly", async () => {
    const inlinePolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "s3:*", Resource: "*" }],
    });
    mockApis({
      inlinePolicy,
      managedPolicies: [
        {
          Arn: "arn:aws:iam::aws:policy/ReadOnlyAccess",
          Name: "ReadOnlyAccess",
        },
      ],
      customerManagedPolicies: [{ Name: "CustomPolicy", Path: "/custom/" }],
    });

    const result = await resolvePermissionSetPolicy(defaultProps, {
      ssoAdminClient,
    });

    expect(result.sessionPolicy!.Statement).toHaveLength(1);
    expect(result.managedPolicyArns).toHaveLength(2);
    expect(result.managedPolicyArns).toContain(
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
    );
    expect(result.managedPolicyArns).toContain(
      `arn:aws:iam::${SANDBOX_ACCOUNT_ID}:policy/custom/CustomPolicy`,
    );
  });

  it("returns empty Statement[] (not allow-all) when permission set has only managed policies", async () => {
    mockApis({
      managedPolicies: [
        {
          Arn: "arn:aws:iam::aws:policy/ReadOnlyAccess",
          Name: "ReadOnlyAccess",
        },
      ],
    });

    const result = await resolvePermissionSetPolicy(defaultProps, {
      ssoAdminClient,
    });

    // Must NOT return an inline policy — that would dominate PolicyArns
    expect(result.sessionPolicy).toBeUndefined();
    expect(result.managedPolicyArns).toHaveLength(1);
  });

  it("handles multiple pages of managed policies", async () => {
    mockSso
      .on(GetInlinePolicyForPermissionSetCommand)
      .resolves({ InlinePolicy: "" });
    vi.mocked(paginateListManagedPoliciesInPermissionSet).mockImplementation(
      asPaginator(async function* () {
        yield {
          AttachedManagedPolicies: [
            { Arn: "arn:aws:iam::aws:policy/PolicyA", Name: "PolicyA" },
          ],
        };
        yield {
          AttachedManagedPolicies: [
            { Arn: "arn:aws:iam::aws:policy/PolicyB", Name: "PolicyB" },
          ],
        };
      }),
    );
    vi.mocked(
      paginateListCustomerManagedPolicyReferencesInPermissionSet,
    ).mockImplementation(asPaginator(async function* () {}));

    const result = await resolvePermissionSetPolicy(defaultProps, {
      ssoAdminClient,
    });

    expect(result.managedPolicyArns).toHaveLength(2);
    expect(result.managedPolicyArns).toContain(
      "arn:aws:iam::aws:policy/PolicyA",
    );
    expect(result.managedPolicyArns).toContain(
      "arn:aws:iam::aws:policy/PolicyB",
    );
  });

  it("throws PermissionSetPolicyTooLargeError when inline policy exceeds 2048 chars", async () => {
    const largeStatements = Array.from({ length: 30 }, (_, i) => ({
      Effect: "Allow" as const,
      Action: [
        `service${i}:OperationOne`,
        `service${i}:OperationTwo`,
        `service${i}:OperationThree`,
      ],
      Resource: `arn:aws:service${i}:us-east-1:123456789012:resource/very-long-resource-name-${i}`,
    }));
    const inlinePolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: largeStatements,
    });
    mockApis({ inlinePolicy });

    await expect(
      resolvePermissionSetPolicy(defaultProps, { ssoAdminClient }),
    ).rejects.toThrow(PermissionSetPolicyTooLargeError);
  });

  it("throws InvalidPermissionSetPolicyError when inline policy JSON is malformed", async () => {
    mockApis({ inlinePolicy: "not valid json{" });

    await expect(
      resolvePermissionSetPolicy(defaultProps, { ssoAdminClient }),
    ).rejects.toThrow(InvalidPermissionSetPolicyError);
  });

  it("accepts a single-object Statement (non-array IAM shape)", async () => {
    // IAM allows Statement to be a single object, not just an array.
    const inlinePolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: { Effect: "Allow", Action: "s3:GetObject", Resource: "*" },
    });
    mockApis({ inlinePolicy });

    const result = await resolvePermissionSetPolicy(defaultProps, {
      ssoAdminClient,
    });

    expect(result.sessionPolicy!.Statement).toHaveLength(1);
    expect(result.sessionPolicy!.Statement[0]).toMatchObject({
      Effect: "Allow",
      Action: "s3:GetObject",
    });
  });

  it("treats an inline policy with empty Statement[] as no inline policy", async () => {
    // {"Version":"2012-10-17","Statement":[]} is valid JSON and passes schema
    // validation but has no effective statements — must not return a sessionPolicy.
    mockApis({
      inlinePolicy: JSON.stringify({ Version: "2012-10-17", Statement: [] }),
    });

    const result = await resolvePermissionSetPolicy(defaultProps, {
      ssoAdminClient,
    });

    expect(result.sessionPolicy).toBeUndefined();
    expect(result.managedPolicyArns).toEqual([]);
  });

  it("throws InvalidPermissionSetPolicyError when inline policy has no Statement array", async () => {
    mockApis({ inlinePolicy: JSON.stringify({ Version: "2012-10-17" }) });

    await expect(
      resolvePermissionSetPolicy(defaultProps, { ssoAdminClient }),
    ).rejects.toThrow(InvalidPermissionSetPolicyError);
  });

  it("accepts inline policy statements using NotAction/NotResource (deny-except pattern)", async () => {
    const inlinePolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Deny",
          NotAction: ["s3:GetObject", "s3:ListBucket"],
          Resource: "*",
        },
        {
          Effect: "Allow",
          Action: "*",
          NotResource: "arn:aws:s3:::restricted-bucket/*",
        },
      ],
    });
    mockApis({ inlinePolicy });

    const result = await resolvePermissionSetPolicy(defaultProps, {
      ssoAdminClient,
    });

    expect(result.sessionPolicy?.Statement).toHaveLength(2);
    expect(result.sessionPolicy?.Statement[0]).toMatchObject({
      Effect: "Deny",
      NotAction: ["s3:GetObject", "s3:ListBucket"],
    });
    expect(result.sessionPolicy?.Statement[1]).toMatchObject({
      Effect: "Allow",
      NotResource: "arn:aws:s3:::restricted-bucket/*",
    });
  });

  it("throws PermissionSetPolicyTooLargeError when more than 10 managed policy ARNs", async () => {
    // STS AssumeRole accepts at most 10 PolicyArns per session.
    const tooManyPolicies = Array.from({ length: 11 }, (_, i) => ({
      Arn: `arn:aws:iam::aws:policy/Policy${i}`,
      Name: `Policy${i}`,
    }));
    mockApis({ managedPolicies: tooManyPolicies });

    await expect(
      resolvePermissionSetPolicy(defaultProps, { ssoAdminClient }),
    ).rejects.toThrow(PermissionSetPolicyTooLargeError);
  });

  it("throws InvalidPermissionSetPolicyError when permission set ARN is malformed", async () => {
    mockApis();

    await expect(
      resolvePermissionSetPolicy(
        { ...defaultProps, permissionSetArn: "not-an-arn" },
        { ssoAdminClient },
      ),
    ).rejects.toThrow(InvalidPermissionSetPolicyError);
  });

  it("propagates SSO Admin API errors to the caller", async () => {
    mockSso
      .on(GetInlinePolicyForPermissionSetCommand)
      .rejects(new Error("AccessDenied"));
    vi.mocked(paginateListManagedPoliciesInPermissionSet).mockImplementation(
      asPaginator(async function* () {
        yield { AttachedManagedPolicies: [] };
      }),
    );
    vi.mocked(
      paginateListCustomerManagedPolicyReferencesInPermissionSet,
    ).mockImplementation(asPaginator(async function* () {}));

    await expect(
      resolvePermissionSetPolicy(defaultProps, { ssoAdminClient }),
    ).rejects.toThrow("AccessDenied");
  });
});

describe("resolvePermissionSetPolicy — permissions boundary", () => {
  const managedPolicies = [
    { Arn: "arn:aws:iam::aws:policy/ReadOnlyAccess", Name: "ReadOnlyAccess" },
  ];

  it("reads the boundary with the same instance and permission set ARNs and resolves when none is attached", async () => {
    mockApis({ managedPolicies });

    const result = await resolvePermissionSetPolicy(defaultProps, {
      ssoAdminClient,
    });

    const boundaryCalls = mockSso.commandCalls(
      GetPermissionsBoundaryForPermissionSetCommand,
    );
    expect(boundaryCalls).toHaveLength(1);
    expect(boundaryCalls[0]!.args[0].input).toEqual({
      InstanceArn: INSTANCE_ARN,
      PermissionSetArn: PERMISSION_SET_ARN,
    });
    expect(result.managedPolicyArns).toEqual([
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
    ]);
  });

  it.each<[string, PermissionsBoundary]>([
    [
      "an AWS-managed",
      { ManagedPolicyArn: "arn:aws:iam::aws:policy/PowerUserAccess" },
    ],
    [
      "a customer-managed",
      {
        CustomerManagedPolicyReference: {
          Name: "SandboxBoundary",
          Path: "/boundaries/",
        },
      },
    ],
    ["an empty", {}],
  ])(
    "throws UnsupportedPermissionSetBoundaryError when %s boundary is attached",
    async (_label, permissionsBoundary) => {
      mockApis({ managedPolicies, permissionsBoundary });

      await expect(
        resolvePermissionSetPolicy(defaultProps, { ssoAdminClient }),
      ).rejects.toThrow(UnsupportedPermissionSetBoundaryError);
    },
  );

  it("prioritizes a present boundary when the inline-policy read also fails", async () => {
    mockApis({
      managedPolicies,
      permissionsBoundary: {
        ManagedPolicyArn: "arn:aws:iam::aws:policy/PowerUserAccess",
      },
    });
    mockSso
      .on(GetInlinePolicyForPermissionSetCommand)
      .rejects(new Error("ThrottlingException"));

    await expect(
      resolvePermissionSetPolicy(defaultProps, { ssoAdminClient }),
    ).rejects.toBeInstanceOf(UnsupportedPermissionSetBoundaryError);
  });

  it("prioritizes a present boundary when a managed-policy read also fails", async () => {
    mockApis({
      permissionsBoundary: {
        CustomerManagedPolicyReference: {
          Name: "SandboxBoundary",
          Path: "/boundaries/",
        },
      },
    });
    vi.mocked(paginateListManagedPoliciesInPermissionSet).mockImplementation(
      asPaginator(async function* () {
        throw new Error("ThrottlingException");
      }),
    );

    await expect(
      resolvePermissionSetPolicy(defaultProps, { ssoAdminClient }),
    ).rejects.toBeInstanceOf(UnsupportedPermissionSetBoundaryError);
  });

  it("treats ResourceNotFoundException from the boundary lookup as no boundary when the other permission-set reads succeed", async () => {
    const noBoundary = new ResourceNotFoundException({
      message: `PermissionsBoundary not present in permission set ${PERMISSION_SET_ARN}`,
      $metadata: {},
    });
    mockApis({ managedPolicies });
    mockSso
      .on(GetPermissionsBoundaryForPermissionSetCommand)
      .rejects(noBoundary);

    const result = await resolvePermissionSetPolicy(defaultProps, {
      ssoAdminClient,
    });

    expect(result.managedPolicyArns).toEqual([
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
    ]);
  });

  it("still rejects a missing permission set when another permission-set read reports not found", async () => {
    const missingPermissionSet = new ResourceNotFoundException({
      message: `Permission set ${PERMISSION_SET_ARN} not found`,
      $metadata: {},
    });
    mockApis({ managedPolicies });
    mockSso
      .on(GetPermissionsBoundaryForPermissionSetCommand)
      .rejects(missingPermissionSet);
    mockSso
      .on(GetInlinePolicyForPermissionSetCommand)
      .rejects(missingPermissionSet);

    await expect(
      resolvePermissionSetPolicy(defaultProps, { ssoAdminClient }),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it("propagates boundary lookup errors unchanged", async () => {
    mockApis({ managedPolicies });
    mockSso
      .on(GetPermissionsBoundaryForPermissionSetCommand)
      .rejects(new Error("ThrottlingException"));

    const rejection = resolvePermissionSetPolicy(defaultProps, {
      ssoAdminClient,
    });

    await expect(rejection).rejects.toThrow("ThrottlingException");
    await expect(rejection).rejects.not.toBeInstanceOf(
      UnsupportedPermissionSetBoundaryError,
    );
  });
});
