// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { DynamoConfigStore } from "@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js";
import type { PersistedPermissionSetCacheItem } from "@amzn/innovation-sandbox-commons/data/permission-set/permission-set.js";
import { PermissionSetsLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/permission-sets-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createAPIGatewayProxyEvent,
  isbAuthorizedUser,
  isbAuthorizedUserUserRoleOnly,
  mockAuthorizedContext,
  mockGlobalConfig,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { IsbUser } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

const testEnv = generateSchemaData(PermissionSetsLambdaEnvironmentSchema);
const ssoInstanceArn = "arn:aws:sso:::instance/ins-1234567890abcdef";
const adminPermissionSetArn =
  "arn:aws:sso:::permissionSet/ins-1234567890abcdef/ps-aaaaaaaaaaaaaaaa";
const managerPermissionSetArn =
  "arn:aws:sso:::permissionSet/ins-1234567890abcdef/ps-bbbbbbbbbbbbbbbb";

const mockPrincipalStore = {
  getPermissionSetCacheItems: vi.fn(),
};
const mockIdcStackConfigStore = {
  get: vi.fn(),
};

vi.mock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
  IsbServices: {
    principalStore: vi.fn().mockReturnValue(mockPrincipalStore),
    idcStackConfigStore: vi.fn().mockReturnValue(mockIdcStackConfigStore),
    configStore: vi.fn().mockReturnValue(new DynamoConfigStore({} as never)),
  },
}));

let handler: typeof import("@amzn/innovation-sandbox-permission-sets-handler/permission-sets-handler.js").handler;

const managerUser: IsbUser = {
  type: "user",
  email: "manager@example.com",
  userId: "manager-id",
  roles: ["Manager"],
};

function permissionSet(
  index: number,
  name: string,
  description?: string,
): PersistedPermissionSetCacheItem {
  const suffix = index.toString().padStart(16, "0");
  const permissionSetId = `ps-${suffix}`;
  return {
    pk: "permissionSetCache",
    sk: `ps#${permissionSetId}`,
    permissionSetArn: `arn:aws:sso:::permissionSet/ins-1234567890abcdef/${permissionSetId}`,
    permissionSetId,
    name,
    ...(description === undefined ? {} : { description }),
    sessionDuration: "PT4H",
    syncedAt: "2026-09-21T12:00:00.000Z",
    meta: {
      schemaVersion: 1,
      createdTime: "2026-09-21T12:00:00.000Z",
      lastEditTime: "2026-09-21T12:00:00.000Z",
    },
  };
}

function event(
  queryStringParameters?: Record<string, string>,
  user: IsbUser = isbAuthorizedUser.user,
) {
  return createAPIGatewayProxyEvent({
    httpMethod: "GET",
    path: "/permissionSets",
    queryStringParameters,
    isbUser: user,
  });
}

async function invoke(
  queryStringParameters?: Record<string, string>,
  user: IsbUser = isbAuthorizedUser.user,
) {
  return handler(
    event(queryStringParameters, user),
    mockAuthorizedContext(testEnv, mockGlobalConfig()),
  );
}

beforeAll(async () => {
  bulkStubEnv(testEnv);
  handler = (
    await import("@amzn/innovation-sandbox-permission-sets-handler/permission-sets-handler.js")
  ).handler;
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  mockAppConfigMiddleware(mockGlobalConfig());
  mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue([]);
  mockIdcStackConfigStore.get.mockResolvedValue({
    ssoInstanceArn,
    adminPermissionSetArn,
    managerPermissionSetArn,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /permissionSets", () => {
  it("returns the generated JSend page shape for an empty cache", async () => {
    const response = await invoke();

    expect(response.statusCode).toBe(200);
    expect(
      mockPrincipalStore.getPermissionSetCacheItems,
    ).toHaveBeenCalledExactlyOnceWith({});
    expect(JSON.parse(response.body)).toEqual({
      status: "success",
      data: { result: [] },
    });
    expect(response.headers?.["Content-Type"]).toBe("application/json");
  });

  it("permits a Manager and rejects a User", async () => {
    const managerResponse = await invoke(undefined, managerUser);
    const userResponse = await invoke(
      undefined,
      isbAuthorizedUserUserRoleOnly.user,
    );

    expect(managerResponse.statusCode).toBe(200);
    expect(userResponse.statusCode).toBe(403);
  });

  it("filters by normalized name or description and excludes system roles", async () => {
    const nameMatch = permissionSet(1, "HackathonDev", "General development");
    const descriptionMatch = permissionSet(
      2,
      "DataScience",
      "HACKATHON analytics",
    );
    const unrelated = permissionSet(3, "ReadOnly", "Production support");
    const foreignInstance = {
      ...permissionSet(6, "Foreign", "Hackathon from another deployment"),
      permissionSetArn:
        "arn:aws:sso:::permissionSet/ins-fedcba9876543210/ps-0000000000000006",
    };
    mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue([
      unrelated,
      foreignInstance,
      {
        ...permissionSet(4, "Administrator", "Hackathon administration"),
        permissionSetArn: adminPermissionSetArn,
      },
      descriptionMatch,
      {
        ...permissionSet(5, "Manager", "Hackathon management"),
        permissionSetArn: managerPermissionSetArn,
      },
      nameMatch,
    ]);

    const response = await invoke({ q: "  hackathon  " });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.data.result).toEqual([
      {
        permissionSetArn: descriptionMatch.permissionSetArn,
        permissionSetId: descriptionMatch.permissionSetId,
        name: descriptionMatch.name,
        description: descriptionMatch.description,
        sessionDuration: "PT4H",
      },
      {
        permissionSetArn: nameMatch.permissionSetArn,
        permissionSetId: nameMatch.permissionSetId,
        name: nameMatch.name,
        description: nameMatch.description,
        sessionDuration: "PT4H",
      },
    ]);
  });

  it("sorts by normalized name and then permission set ID", async () => {
    const laterId = permissionSet(20, "alpha");
    const firstId = permissionSet(10, "Alpha");
    const beta = permissionSet(1, "Beta");
    mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue([
      beta,
      laterId,
      firstId,
    ]);

    const response = await invoke();
    const ids = JSON.parse(response.body).data.result.map(
      (item: { permissionSetId: string }) => item.permissionSetId,
    );

    expect(ids).toEqual([
      firstId.permissionSetId,
      laterId.permissionSetId,
      beta.permissionSetId,
    ]);
  });

  it("defaults maxResults to 50 and emits a cursor only when more results exist", async () => {
    mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue(
      Array.from({ length: 51 }, (_, index) =>
        permissionSet(index + 1, `Set${index.toString().padStart(2, "0")}`),
      ),
    );

    const firstResponse = await invoke();
    const firstBody = JSON.parse(firstResponse.body);
    const secondResponse = await invoke({
      pageIdentifier: firstBody.data.nextPageIdentifier,
    });
    const secondBody = JSON.parse(secondResponse.body);

    expect(firstBody.data.result).toHaveLength(50);
    expect(firstBody.data.nextPageIdentifier).toEqual(expect.any(String));
    expect(secondBody.data.result).toHaveLength(1);
    expect(secondBody.data).not.toHaveProperty("nextPageIdentifier");
  });

  it("traverses multiple pages without duplicates", async () => {
    const items = Array.from({ length: 5 }, (_, index) =>
      permissionSet(index + 1, `Set${index}`),
    );
    mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue(items);

    const visited: string[] = [];
    let pageIdentifier: string | undefined;
    do {
      const response = await invoke({
        maxResults: "2",
        ...(pageIdentifier === undefined ? {} : { pageIdentifier }),
      });
      const body = JSON.parse(response.body);
      visited.push(
        ...body.data.result.map(
          (item: { permissionSetId: string }) => item.permissionSetId,
        ),
      );
      pageIdentifier = body.data.nextPageIdentifier;
    } while (pageIdentifier !== undefined);

    expect(visited).toEqual(items.map((item) => item.permissionSetId));
    expect(new Set(visited).size).toBe(visited.length);
  });

  it("paginates equal normalized names using permission set ID as a tie-breaker", async () => {
    const first = permissionSet(1, "Alpha");
    const second = permissionSet(2, "alpha");
    mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue([
      second,
      first,
    ]);

    const firstResponse = await invoke({ maxResults: "1" });
    const firstBody = JSON.parse(firstResponse.body);
    const secondResponse = await invoke({
      maxResults: "1",
      pageIdentifier: firstBody.data.nextPageIdentifier,
    });
    const secondBody = JSON.parse(secondResponse.body);

    expect(firstBody.data.result[0].permissionSetId).toBe(
      first.permissionSetId,
    );
    expect(secondBody.data.result[0].permissionSetId).toBe(
      second.permissionSetId,
    );
    expect(secondBody.data).not.toHaveProperty("nextPageIdentifier");
  });

  it("supports pagination when NFKC expands the search query", async () => {
    const rawQuery = "ﬀ".repeat(200);
    const normalizedQuery = "ff".repeat(200);
    const first = permissionSet(1, "First", normalizedQuery);
    const second = permissionSet(2, "Second", normalizedQuery);
    mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue([
      first,
      second,
    ]);

    const firstResponse = await invoke({
      q: rawQuery,
      maxResults: "1",
    });
    const firstBody = JSON.parse(firstResponse.body);
    const secondResponse = await invoke({
      q: rawQuery,
      maxResults: "1",
      pageIdentifier: firstBody.data.nextPageIdentifier,
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(firstBody.data.nextPageIdentifier).toEqual(expect.any(String));
    expect(secondResponse.statusCode).toBe(200);
    expect(JSON.parse(secondResponse.body).data.result).toHaveLength(1);
  });

  it("rejects a cursor after the matching catalog changes", async () => {
    const first = permissionSet(1, "Alpha");
    const second = permissionSet(2, "Beta");
    mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue([
      first,
      second,
    ]);
    const firstResponse = await invoke({ maxResults: "1" });
    const cursor = JSON.parse(firstResponse.body).data.nextPageIdentifier;

    mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue([
      { ...first, name: "Zulu" },
      second,
    ]);
    const staleCursorResponse = await invoke({
      maxResults: "1",
      pageIdentifier: cursor,
    });

    expect(staleCursorResponse.statusCode).toBe(400);
    expect(JSON.parse(staleCursorResponse.body).data.errors[0].field).toBe(
      "pageIdentifier",
    );
  });

  it("rejects malformed and query-mismatched cursors", async () => {
    mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue([
      permissionSet(1, "Alpha"),
      permissionSet(2, "Alpine"),
    ]);
    const firstPage = await invoke({ q: "al", maxResults: "1" });
    const cursor = JSON.parse(firstPage.body).data.nextPageIdentifier;

    const malformed = await invoke({ pageIdentifier: "not+base64" });
    const mismatched = await invoke({ q: "different", pageIdentifier: cursor });

    expect(malformed.statusCode).toBe(400);
    expect(mismatched.statusCode).toBe(400);
    expect(JSON.parse(malformed.body).data.errors[0].field).toBe(
      "pageIdentifier",
    );
  });

  it.each(["0", "101"])(
    "lets generated Smithy validation reject maxResults=%s",
    async (maxResults) => {
      const response = await invoke({ maxResults });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).status).toBe("fail");
      expect(
        mockPrincipalStore.getPermissionSetCacheItems,
      ).not.toHaveBeenCalled();
    },
  );

  it("reports IDC configuration failures as server errors", async () => {
    mockIdcStackConfigStore.get.mockRejectedValueOnce(
      new Error("IDC stack configuration is invalid."),
    );

    const response = await invoke();

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      status: "error",
      message: "An unexpected error occurred.",
    });
  });
});
