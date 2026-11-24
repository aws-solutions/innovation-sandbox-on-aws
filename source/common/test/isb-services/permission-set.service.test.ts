// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import { ValidationException } from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import type { IdcConfig } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/idc-stack-config.js";
import type { IdcStackConfigStore } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/ssm-idc-stack-config-store.js";
import {
  type PersistedPermissionSetCacheItem,
  PersistedPermissionSetCacheItemSchema,
  toPermissionSetSummary,
} from "@amzn/innovation-sandbox-commons/data/permission-set/permission-set.js";
import type { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import {
  assertPermissionSetGrantAllowed,
  getAssignablePermissionSets,
  hydratePermissionSets,
  isSystemPermissionSetArn,
  loadPermissionSetContext,
  type PermissionSetContext,
  resolvePermissionSetConfig,
  validateNewAssignmentGrants,
} from "@amzn/innovation-sandbox-commons/isb-services/permission-set/index.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  MAX_ALLOWED_PERMISSION_SETS,
  PermissionSetReferenceSchema,
} from "@amzn/innovation-sandbox-shared/types/permission-set.js";

const USER_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-user123456789012";
const CUSTOM_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-custom1234567890";
const SECOND_CUSTOM_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-second1234567890";
const MISSING_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-missing123456789";
const ADMIN_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-admin12345678901";
const MANAGER_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-manager123456789";
const FOREIGN_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-fedcba9876543210/ps-foreign123456789";

const idcConfig: IdcConfig = {
  identityStoreId: "d-1234567890",
  ssoInstanceArn: "arn:aws:sso:::instance/ssoins-1234567890abcdef",
  adminGroupId: "admin-group",
  managerGroupId: "manager-group",
  userGroupId: "user-group",
  adminPermissionSetArn: ADMIN_PERMISSION_SET_ARN,
  managerPermissionSetArn: MANAGER_PERMISSION_SET_ARN,
  userPermissionSetArn: USER_PERMISSION_SET_ARN,
  solutionVersion: "1.4.0",
  supportedSchemas: "1",
};

function cacheItem(
  permissionSetArn: string,
  permissionSetId: string,
  name: string,
): PersistedPermissionSetCacheItem {
  return generateSchemaData(PersistedPermissionSetCacheItemSchema, {
    pk: "permissionSetCache",
    sk: `ps#${permissionSetId}`,
    permissionSetArn,
    permissionSetId,
    name,
    description: `${name} description`,
    sessionDuration: "PT1H",
  });
}

const userCacheItem = cacheItem(
  USER_PERMISSION_SET_ARN,
  "ps-user123456789012",
  "BuiltInUser",
);
const customCacheItem = cacheItem(
  CUSTOM_PERMISSION_SET_ARN,
  "ps-custom1234567890",
  "Custom",
);
const secondCustomCacheItem = cacheItem(
  SECOND_CUSTOM_PERMISSION_SET_ARN,
  "ps-second1234567890",
  "SecondCustom",
);
const adminCacheItem = cacheItem(
  ADMIN_PERMISSION_SET_ARN,
  "ps-admin12345678901",
  "Admin",
);
const managerCacheItem = cacheItem(
  MANAGER_PERMISSION_SET_ARN,
  "ps-manager123456789",
  "Manager",
);
const foreignCacheItem = cacheItem(
  FOREIGN_PERMISSION_SET_ARN,
  "ps-foreign123456789",
  "Foreign",
);

function context(
  cacheItems: PersistedPermissionSetCacheItem[] = [
    userCacheItem,
    customCacheItem,
    secondCustomCacheItem,
  ],
): PermissionSetContext {
  return {
    idcConfig,
    cacheByArn: new Map(
      cacheItems.map((item) => [item.permissionSetArn, item]),
    ),
  };
}

function numberedPermissionSet(index: number) {
  const permissionSetId = `ps-${index.toString().padStart(16, "0")}`;
  const permissionSetArn = `arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/${permissionSetId}`;
  return {
    permissionSetArn,
    cacheItem: cacheItem(
      permissionSetArn,
      permissionSetId,
      `PermissionSet${index}`,
    ),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("loadPermissionSetContext", () => {
  it("loads IDC configuration and the cache concurrently", async () => {
    const configResult = deferred<IdcConfig>();
    const cacheResult = deferred<PersistedPermissionSetCacheItem[]>();
    const idcStackConfigStore: Pick<IdcStackConfigStore, "get"> = {
      get: vi.fn(() => configResult.promise),
    };
    const principalStore: Pick<PrincipalStore, "getPermissionSetCacheItems"> = {
      getPermissionSetCacheItems: vi.fn(() => cacheResult.promise),
    };

    const resultPromise = loadPermissionSetContext(
      idcStackConfigStore,
      principalStore,
    );

    expect(idcStackConfigStore.get).toHaveBeenCalledOnce();
    expect(
      principalStore.getPermissionSetCacheItems,
    ).toHaveBeenCalledExactlyOnceWith({});

    configResult.resolve(idcConfig);
    cacheResult.resolve([userCacheItem, customCacheItem]);

    await expect(resultPromise).resolves.toEqual({
      idcConfig,
      cacheByArn: new Map([
        [USER_PERMISSION_SET_ARN, userCacheItem],
        [CUSTOM_PERMISSION_SET_ARN, customCacheItem],
      ]),
    });
  });

  it("allows registration validation to request a strongly consistent catalog", async () => {
    const idcStackConfigStore: Pick<IdcStackConfigStore, "get"> = {
      get: vi.fn().mockResolvedValue(idcConfig),
    };
    const principalStore: Pick<PrincipalStore, "getPermissionSetCacheItems"> = {
      getPermissionSetCacheItems: vi.fn().mockResolvedValue([customCacheItem]),
    };

    await loadPermissionSetContext(idcStackConfigStore, principalStore, {
      consistentRead: true,
    });

    expect(
      principalStore.getPermissionSetCacheItems,
    ).toHaveBeenCalledExactlyOnceWith({
      consistentRead: true,
    });
  });

  it.each([
    ["IDC configuration", new Error("config unavailable"), undefined],
    ["permission-set cache", undefined, new Error("cache unavailable")],
  ])(
    "propagates a %s loading failure after starting both reads",
    async (_source, configError, cacheError) => {
      const idcStackConfigStore: Pick<IdcStackConfigStore, "get"> = {
        get: vi.fn(() =>
          configError
            ? Promise.reject(configError)
            : Promise.resolve(idcConfig),
        ),
      };
      const principalStore: Pick<PrincipalStore, "getPermissionSetCacheItems"> =
        {
          getPermissionSetCacheItems: vi.fn(() =>
            cacheError
              ? Promise.reject(cacheError)
              : Promise.resolve([userCacheItem]),
          ),
        };

      await expect(
        loadPermissionSetContext(idcStackConfigStore, principalStore),
      ).rejects.toBe(configError ?? cacheError);
      expect(idcStackConfigStore.get).toHaveBeenCalledOnce();
      expect(principalStore.getPermissionSetCacheItems).toHaveBeenCalledOnce();
    },
  );
});

describe("system roles and assignable permission sets", () => {
  it.each([ADMIN_PERMISSION_SET_ARN, MANAGER_PERMISSION_SET_ARN])(
    "identifies system permission set %s from either context shape",
    (permissionSetArn) => {
      expect(isSystemPermissionSetArn(permissionSetArn, idcConfig)).toBe(true);
      expect(isSystemPermissionSetArn(permissionSetArn, context())).toBe(true);
    },
  );

  it("does not identify the built-in user permission set as a system role", () => {
    expect(isSystemPermissionSetArn(USER_PERMISSION_SET_ARN, context())).toBe(
      false,
    );
  });

  it("filters admin and manager entries from the assignable cache", () => {
    expect(
      getAssignablePermissionSets(
        context([
          adminCacheItem,
          userCacheItem,
          managerCacheItem,
          customCacheItem,
        ]),
      ),
    ).toEqual([
      toPermissionSetSummary(userCacheItem),
      toPermissionSetSummary(customCacheItem),
    ]);
  });

  it("excludes foreign-instance and identity-inconsistent cache entries", () => {
    const inconsistentCacheItem: PersistedPermissionSetCacheItem = {
      ...customCacheItem,
      sk: secondCustomCacheItem.sk,
      permissionSetId: secondCustomCacheItem.permissionSetId,
    };

    expect(
      getAssignablePermissionSets(
        context([userCacheItem, foreignCacheItem, inconsistentCacheItem]),
      ),
    ).toEqual([toPermissionSetSummary(userCacheItem)]);
  });

  it("returns fresh catalog projections that cannot mutate the context", () => {
    const permissionSetContext = context();
    const [first] = getAssignablePermissionSets(permissionSetContext);

    first!.name = "Mutated";

    expect(
      hydratePermissionSets(
        { defaultPermissionSetArn: USER_PERMISSION_SET_ARN },
        permissionSetContext,
      ).defaultPermissionSet.name,
    ).toBe("BuiltInUser");
  });
});

describe("resolvePermissionSetConfig", () => {
  it("validates and returns concrete default and allowed references", () => {
    expect(
      resolvePermissionSetConfig(
        {
          defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN,
          allowedPermissionSetArns: [
            CUSTOM_PERMISSION_SET_ARN,
            SECOND_CUSTOM_PERMISSION_SET_ARN,
          ],
        },
        context(),
      ),
    ).toEqual({
      defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      allowedPermissionSetArns: [
        CUSTOM_PERMISSION_SET_ARN,
        SECOND_CUSTOM_PERMISSION_SET_ARN,
      ],
    });
  });

  it("resolves an omitted create default to the built-in user permission set", () => {
    expect(resolvePermissionSetConfig({}, context())).toEqual({
      defaultPermissionSetArn: USER_PERMISSION_SET_ARN,
      allowedPermissionSetArns: undefined,
    });
  });

  it("preserves omitted update fields and resolves a legacy missing default", () => {
    const previousAllowedPermissionSetArns = [SECOND_CUSTOM_PERMISSION_SET_ARN];
    expect(
      resolvePermissionSetConfig({}, context(), {
        defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN,
        allowedPermissionSetArns: previousAllowedPermissionSetArns,
      }),
    ).toEqual({
      defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      allowedPermissionSetArns: [SECOND_CUSTOM_PERMISSION_SET_ARN],
    });
    expect(
      resolvePermissionSetConfig({}, context(), {
        defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN,
        allowedPermissionSetArns: previousAllowedPermissionSetArns,
      }).allowedPermissionSetArns,
    ).not.toBe(previousAllowedPermissionSetArns);

    expect(
      resolvePermissionSetConfig({}, context(), {
        allowedPermissionSetArns: [CUSTOM_PERMISSION_SET_ARN],
      }),
    ).toEqual({
      defaultPermissionSetArn: USER_PERMISSION_SET_ARN,
      allowedPermissionSetArns: [CUSTOM_PERMISSION_SET_ARN],
    });
  });

  it("preserves omitted references that became unavailable after configuration", () => {
    expect(
      resolvePermissionSetConfig({}, context([userCacheItem]), {
        defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN,
        allowedPermissionSetArns: [MISSING_PERMISSION_SET_ARN],
      }),
    ).toEqual({
      defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      allowedPermissionSetArns: [MISSING_PERMISSION_SET_ARN],
    });
  });

  it("accepts explicitly echoed references that became unavailable after configuration", () => {
    const previous = {
      defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      allowedPermissionSetArns: [MISSING_PERMISSION_SET_ARN],
    };

    expect(
      resolvePermissionSetConfig(previous, context([userCacheItem]), previous),
    ).toEqual(previous);
  });

  it("validates newly allowed references without revalidating unchanged unavailable references", () => {
    expect(
      resolvePermissionSetConfig(
        {
          allowedPermissionSetArns: [
            MISSING_PERMISSION_SET_ARN,
            SECOND_CUSTOM_PERMISSION_SET_ARN,
          ],
        },
        context([userCacheItem, secondCustomCacheItem]),
        {
          defaultPermissionSetArn: USER_PERMISSION_SET_ARN,
          allowedPermissionSetArns: [MISSING_PERMISSION_SET_ARN],
        },
      ),
    ).toEqual({
      defaultPermissionSetArn: USER_PERMISSION_SET_ARN,
      allowedPermissionSetArns: [
        MISSING_PERMISSION_SET_ARN,
        SECOND_CUSTOM_PERMISSION_SET_ARN,
      ],
    });
  });

  it("rejects a newly allowed unavailable reference on update", () => {
    expect(() =>
      resolvePermissionSetConfig(
        { allowedPermissionSetArns: [MISSING_PERMISSION_SET_ARN] },
        context([userCacheItem]),
        {
          defaultPermissionSetArn: USER_PERMISSION_SET_ARN,
          allowedPermissionSetArns: [],
        },
      ),
    ).toThrow(
      `Permission set ${MISSING_PERMISSION_SET_ARN} is not registered in this deployment's catalog.`,
    );
  });

  it("rejects changing the default to an unavailable reference that was previously only allowed", () => {
    expect(() =>
      resolvePermissionSetConfig(
        { defaultPermissionSetArn: MISSING_PERMISSION_SET_ARN },
        context([userCacheItem]),
        {
          defaultPermissionSetArn: USER_PERMISSION_SET_ARN,
          allowedPermissionSetArns: [MISSING_PERMISSION_SET_ARN],
        },
      ),
    ).toThrow(
      `Permission set ${MISSING_PERMISSION_SET_ARN} is not registered in this deployment's catalog.`,
    );
  });

  it.each([
    ["system role", ADMIN_PERMISSION_SET_ARN],
    ["foreign-instance reference", FOREIGN_PERMISSION_SET_ARN],
  ])(
    "does not grandfather an unchanged %s",
    (_description, permissionSetArn) => {
      expect(() =>
        resolvePermissionSetConfig(
          {},
          context([userCacheItem, adminCacheItem, foreignCacheItem]),
          { defaultPermissionSetArn: permissionSetArn },
        ),
      ).toThrow(ValidationException);
    },
  );

  it("gives explicit update values precedence over previous values", () => {
    expect(
      resolvePermissionSetConfig(
        {
          defaultPermissionSetArn: SECOND_CUSTOM_PERMISSION_SET_ARN,
          allowedPermissionSetArns: [CUSTOM_PERMISSION_SET_ARN],
        },
        context(),
        {
          defaultPermissionSetArn: USER_PERMISSION_SET_ARN,
          allowedPermissionSetArns: [SECOND_CUSTOM_PERMISSION_SET_ARN],
        },
      ),
    ).toEqual({
      defaultPermissionSetArn: SECOND_CUSTOM_PERMISSION_SET_ARN,
      allowedPermissionSetArns: [CUSTOM_PERMISSION_SET_ARN],
    });
  });

  it("treats an explicit empty allowed list as clearing overrides", () => {
    expect(
      resolvePermissionSetConfig({ allowedPermissionSetArns: [] }, context(), {
        defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN,
        allowedPermissionSetArns: [SECOND_CUSTOM_PERMISSION_SET_ARN],
      }),
    ).toEqual({
      defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      allowedPermissionSetArns: [],
    });
  });

  it.each([ADMIN_PERMISSION_SET_ARN, MANAGER_PERMISSION_SET_ARN])(
    "rejects system permission set %s even when it is cached",
    (permissionSetArn) => {
      const resolve = () =>
        resolvePermissionSetConfig(
          { allowedPermissionSetArns: [permissionSetArn] },
          context([userCacheItem, adminCacheItem, managerCacheItem]),
        );

      expect(resolve).toThrow(ValidationException);
      expect(resolve).toThrow(
        `Permission set ${permissionSetArn} is a system role and cannot be assigned to lease users.`,
      );
    },
  );

  it.each([ADMIN_PERMISSION_SET_ARN, MANAGER_PERMISSION_SET_ARN])(
    "rejects system permission set %s as the default",
    (permissionSetArn) => {
      const resolve = () =>
        resolvePermissionSetConfig(
          { defaultPermissionSetArn: permissionSetArn },
          context([userCacheItem, adminCacheItem, managerCacheItem]),
        );

      expect(resolve).toThrow(ValidationException);
      expect(resolve).toThrow(
        `Permission set ${permissionSetArn} is a system role and cannot be assigned to lease users.`,
      );
    },
  );

  it("rejects an uncached permission set with an actionable error", () => {
    const resolve = () =>
      resolvePermissionSetConfig(
        { allowedPermissionSetArns: [MISSING_PERMISSION_SET_ARN] },
        context(),
      );

    expect(resolve).toThrow(ValidationException);
    expect(resolve).toThrow(
      `Permission set ${MISSING_PERMISSION_SET_ARN} is not registered in this deployment's catalog.`,
    );
  });

  it("rejects an uncached default permission set", () => {
    const resolve = () =>
      resolvePermissionSetConfig(
        { defaultPermissionSetArn: MISSING_PERMISSION_SET_ARN },
        context(),
      );

    expect(resolve).toThrow(ValidationException);
    expect(resolve).toThrow(
      `Permission set ${MISSING_PERMISSION_SET_ARN} is not registered in this deployment's catalog.`,
    );
  });

  it("rejects cached permission sets from a different IDC instance", () => {
    const resolve = () =>
      resolvePermissionSetConfig(
        { allowedPermissionSetArns: [FOREIGN_PERMISSION_SET_ARN] },
        context([userCacheItem, foreignCacheItem]),
      );

    expect(resolve).toThrow(ValidationException);
    expect(resolve).toThrow(
      `Permission set ${FOREIGN_PERMISSION_SET_ARN} does not belong to this deployment's IAM Identity Center instance.`,
    );
  });

  it("rejects malformed or oversized canonical profile configuration", () => {
    const malformedResolve = () =>
      resolvePermissionSetConfig(
        { defaultPermissionSetArn: "not-an-arn" },
        context(),
      );
    const oversizedResolve = () =>
      resolvePermissionSetConfig(
        {
          allowedPermissionSetArns: Array(21).fill(CUSTOM_PERMISSION_SET_ARN),
        },
        context(),
      );

    expect(malformedResolve).toThrow(ValidationException);
    expect(malformedResolve).toThrow("Invalid permission set configuration");
    expect(oversizedResolve).toThrow(ValidationException);
    expect(oversizedResolve).toThrow("Invalid permission set configuration");
  });

  it("accepts at most 20 effective permission sets when the default is included in the allowed list", () => {
    const permissionSets = Array.from(
      { length: MAX_ALLOWED_PERMISSION_SETS },
      (_, index) => numberedPermissionSet(index),
    );
    const allowedPermissionSetArns = permissionSets.map(
      ({ permissionSetArn }) => permissionSetArn,
    );

    expect(
      resolvePermissionSetConfig(
        {
          defaultPermissionSetArn: allowedPermissionSetArns[0],
          allowedPermissionSetArns,
        },
        context(permissionSets.map(({ cacheItem }) => cacheItem)),
      ),
    ).toEqual({
      defaultPermissionSetArn: allowedPermissionSetArns[0],
      allowedPermissionSetArns,
    });
  });

  it("accepts a distinct default plus 19 allowed permission sets", () => {
    const permissionSets = Array.from(
      { length: MAX_ALLOWED_PERMISSION_SETS - 1 },
      (_, index) => numberedPermissionSet(index),
    );
    const allowedPermissionSetArns = permissionSets.map(
      ({ permissionSetArn }) => permissionSetArn,
    );

    expect(
      resolvePermissionSetConfig(
        {
          defaultPermissionSetArn: USER_PERMISSION_SET_ARN,
          allowedPermissionSetArns,
        },
        context([
          userCacheItem,
          ...permissionSets.map(({ cacheItem }) => cacheItem),
        ]),
      ),
    ).toEqual({
      defaultPermissionSetArn: USER_PERMISSION_SET_ARN,
      allowedPermissionSetArns,
    });
  });

  it("rejects a distinct default plus 20 allowed permission sets", () => {
    const permissionSets = Array.from(
      { length: MAX_ALLOWED_PERMISSION_SETS },
      (_, index) => numberedPermissionSet(index),
    );

    expect(() =>
      resolvePermissionSetConfig(
        {
          defaultPermissionSetArn: USER_PERMISSION_SET_ARN,
          allowedPermissionSetArns: permissionSets.map(
            ({ permissionSetArn }) => permissionSetArn,
          ),
        },
        context([
          userCacheItem,
          ...permissionSets.map(({ cacheItem }) => cacheItem),
        ]),
      ),
    ).toThrow(
      "A permission profile can contain at most 20 effective permission sets, including the default.",
    );
  });

  it("rejects a default-only update that would exceed the effective limit", () => {
    const permissionSets = Array.from(
      { length: MAX_ALLOWED_PERMISSION_SETS },
      (_, index) => numberedPermissionSet(index),
    );
    const allowedPermissionSetArns = permissionSets.map(
      ({ permissionSetArn }) => permissionSetArn,
    );

    expect(() =>
      resolvePermissionSetConfig(
        { defaultPermissionSetArn: USER_PERMISSION_SET_ARN },
        context([
          userCacheItem,
          ...permissionSets.map(({ cacheItem }) => cacheItem),
        ]),
        {
          defaultPermissionSetArn: allowedPermissionSetArns[0],
          allowedPermissionSetArns,
        },
      ),
    ).toThrow(
      "A permission profile can contain at most 20 effective permission sets, including the default.",
    );
  });

  it("does not accept an identity-inconsistent cached permission set", () => {
    const inconsistentCacheItem: PersistedPermissionSetCacheItem = {
      ...customCacheItem,
      sk: secondCustomCacheItem.sk,
      permissionSetId: secondCustomCacheItem.permissionSetId,
    };

    expect(() =>
      resolvePermissionSetConfig(
        { defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN },
        context([userCacheItem, inconsistentCacheItem]),
      ),
    ).toThrow(
      `Permission set ${CUSTOM_PERMISSION_SET_ARN} is not registered in this deployment's catalog.`,
    );
  });

  it("validates duplicate references only once", () => {
    const cacheByArn = new Map(context().cacheByArn);
    const get = vi.spyOn(cacheByArn, "get");
    const validationContext: PermissionSetContext = {
      idcConfig,
      cacheByArn,
    };

    resolvePermissionSetConfig(
      {
        defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN,
        allowedPermissionSetArns: [
          CUSTOM_PERMISSION_SET_ARN,
          CUSTOM_PERMISSION_SET_ARN,
        ],
      },
      validationContext,
    );

    expect(get).toHaveBeenCalledOnce();
  });

  it("returns persistence-only ARN configuration without mutable metadata", () => {
    const input = {
      defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      allowedPermissionSetArns: [SECOND_CUSTOM_PERMISSION_SET_ARN],
    };

    const result = resolvePermissionSetConfig(input, context());

    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(result.allowedPermissionSetArns).not.toBe(
      input.allowedPermissionSetArns,
    );
    expect(result).not.toHaveProperty("defaultPermissionSet");
    expect(result).not.toHaveProperty("allowedPermissionSets");
    expect(input).toEqual({
      defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      allowedPermissionSetArns: [SECOND_CUSTOM_PERMISSION_SET_ARN],
    });
  });
});

describe("hydratePermissionSets", () => {
  it("deduplicates AVAILABLE references and uses current cached metadata", () => {
    const result = hydratePermissionSets(
      {
        defaultPermissionSetArn: USER_PERMISSION_SET_ARN,
        allowedPermissionSetArns: [
          USER_PERMISSION_SET_ARN,
          CUSTOM_PERMISSION_SET_ARN,
          CUSTOM_PERMISSION_SET_ARN,
        ],
      },
      context(),
    );

    expect(result.defaultPermissionSet).toEqual({
      permissionSetArn: USER_PERMISSION_SET_ARN,
      permissionSetId: "ps-user123456789012",
      name: "BuiltInUser",
      description: "BuiltInUser description",
      sessionDuration: "PT1H",
      availability: "AVAILABLE",
    });
    expect(result.allowedPermissionSets).toEqual([
      result.defaultPermissionSet,
      {
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
        permissionSetId: "ps-custom1234567890",
        name: "Custom",
        description: "Custom description",
        sessionDuration: "PT1H",
        availability: "AVAILABLE",
      },
    ]);
  });

  it("hydrates legacy defaults and missing cache entries as UNAVAILABLE", () => {
    const result = hydratePermissionSets(
      {
        allowedPermissionSetArns: [MISSING_PERMISSION_SET_ARN],
      },
      context([userCacheItem]),
    );

    expect(result).toEqual({
      defaultPermissionSet: {
        permissionSetArn: USER_PERMISSION_SET_ARN,
        permissionSetId: "ps-user123456789012",
        name: "BuiltInUser",
        description: "BuiltInUser description",
        sessionDuration: "PT1H",
        availability: "AVAILABLE",
      },
      allowedPermissionSets: [
        {
          permissionSetArn: USER_PERMISSION_SET_ARN,
          permissionSetId: "ps-user123456789012",
          name: "BuiltInUser",
          description: "BuiltInUser description",
          sessionDuration: "PT1H",
          availability: "AVAILABLE",
        },
        {
          permissionSetArn: MISSING_PERMISSION_SET_ARN,
          permissionSetId: "ps-missing123456789",
          availability: "UNAVAILABLE",
        },
      ],
    });
  });

  it("treats foreign-instance and identity-inconsistent cache entries as UNAVAILABLE", () => {
    const inconsistentCacheItem: PersistedPermissionSetCacheItem = {
      ...customCacheItem,
      sk: secondCustomCacheItem.sk,
      permissionSetId: secondCustomCacheItem.permissionSetId,
    };
    const permissionSetContext = context([
      userCacheItem,
      foreignCacheItem,
      inconsistentCacheItem,
    ]);

    const foreignReference = hydratePermissionSets(
      { defaultPermissionSetArn: FOREIGN_PERMISSION_SET_ARN },
      permissionSetContext,
    ).defaultPermissionSet;
    const inconsistentReference = hydratePermissionSets(
      { defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN },
      permissionSetContext,
    ).defaultPermissionSet;

    expect(foreignReference).toEqual({
      permissionSetArn: FOREIGN_PERMISSION_SET_ARN,
      permissionSetId: "ps-foreign123456789",
      availability: "UNAVAILABLE",
    });
    expect(inconsistentReference).toEqual({
      permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
      permissionSetId: "ps-custom1234567890",
      availability: "UNAVAILABLE",
    });
    expect(
      PermissionSetReferenceSchema.safeParse(foreignReference).success,
    ).toBe(true);
    expect(
      PermissionSetReferenceSchema.safeParse(inconsistentReference).success,
    ).toBe(true);
  });
});

describe("cached registration grant policy", () => {
  const owner = {
    principalType: "USER",
    principalId: "owner",
    permissionSetArn: USER_PERMISSION_SET_ARN,
  } as const;
  const custom = {
    principalType: "USER",
    principalId: "shared",
    permissionSetArn: CUSTOM_PERMISSION_SET_ARN,
  } as const;
  const props = {
    assignments: [owner, custom],
    previousAssignments: [owner],
    defaultPermissionSetArn: USER_PERMISSION_SET_ARN,
  };

  it("authorizes registered custom grants and the untagged built-in profile", () => {
    expect(() =>
      assertPermissionSetGrantAllowed(
        CUSTOM_PERMISSION_SET_ARN,
        idcConfig,
        customCacheItem,
      ),
    ).not.toThrow();
    expect(() =>
      assertPermissionSetGrantAllowed(USER_PERMISSION_SET_ARN, idcConfig),
    ).not.toThrow();
    expect(
      resolvePermissionSetConfig({}, context([])).defaultPermissionSetArn,
    ).toBe(USER_PERMISSION_SET_ARN);
  });

  it.each([
    MISSING_PERMISSION_SET_ARN,
    ADMIN_PERMISSION_SET_ARN,
    MANAGER_PERMISSION_SET_ARN,
    FOREIGN_PERMISSION_SET_ARN,
  ])("rejects unavailable or forbidden grant %s", (arn) => {
    expect(() =>
      assertPermissionSetGrantAllowed(
        arn,
        idcConfig,
        context().cacheByArn.get(arn),
      ),
    ).toThrow(ValidationException);
  });

  it.each([
    {
      field: "permissionSetArn",
      item: {
        ...customCacheItem,
        permissionSetArn: CUSTOM_PERMISSION_SET_ARN.replace(
          "ssoins-1234567890abcdef",
          "ssoins-fedcba9876543210",
        ),
      },
    },
    {
      field: "permissionSetId",
      item: {
        ...customCacheItem,
        permissionSetId: userCacheItem.permissionSetId,
      },
    },
    {
      field: "sk",
      item: { ...customCacheItem, sk: userCacheItem.sk },
    },
  ])("rejects registration metadata with a mismatched $field", ({ item }) => {
    expect(() =>
      assertPermissionSetGrantAllowed(
        CUSTOM_PERMISSION_SET_ARN,
        idcConfig,
        item,
      ),
    ).toThrow("not registered");
  });

  it.each(["unchanged", "removal"])(
    "does not read the catalog for an %s replacement",
    async (kind) => {
      const getPermissionSetCacheItems = vi
        .fn()
        .mockRejectedValue(new Error("cache unavailable"));
      await expect(
        validateNewAssignmentGrants(
          {
            ...props,
            previousAssignments: [owner, custom],
            assignments: kind === "removal" ? [owner] : [owner, custom],
          },
          { idcConfig, principalStore: { getPermissionSetCacheItems } },
        ),
      ).resolves.toBeUndefined();
      expect(getPermissionSetCacheItems).not.toHaveBeenCalled();
    },
  );

  it("normalizes legacy previous rows before deciding whether a tuple is new", async () => {
    const getPermissionSetCacheItems = vi
      .fn()
      .mockRejectedValue(new Error("cache unavailable"));
    await validateNewAssignmentGrants(
      {
        ...props,
        defaultPermissionSetArn: CUSTOM_PERMISSION_SET_ARN,
        assignments: [custom],
        previousAssignments: [
          { principalType: "USER", principalId: custom.principalId },
        ],
      },
      { idcConfig, principalStore: { getPermissionSetCacheItems } },
    );
    expect(getPermissionSetCacheItems).not.toHaveBeenCalled();
  });

  it("reads the catalog once, consistently, for new user and group tuples", async () => {
    const getPermissionSetCacheItems = vi
      .fn()
      .mockResolvedValue([customCacheItem]);
    await validateNewAssignmentGrants(
      {
        ...props,
        assignments: [owner, custom, { ...custom, principalType: "GROUP" }],
      },
      { idcConfig, principalStore: { getPermissionSetCacheItems } },
    );
    expect(getPermissionSetCacheItems).toHaveBeenCalledExactlyOnceWith({
      consistentRead: true,
    });
  });

  it("blocks a profile replacement and does not grandfather the old principal", async () => {
    const getPermissionSetCacheItems = vi.fn().mockResolvedValue([]);
    await expect(
      validateNewAssignmentGrants(
        {
          ...props,
          previousAssignments: [
            owner,
            { ...custom, permissionSetArn: USER_PERMISSION_SET_ARN },
          ],
        },
        { idcConfig, principalStore: { getPermissionSetCacheItems } },
      ),
    ).rejects.toThrow(
      "Register it again or select an available permission set",
    );
  });

  it("fails closed on a catalog read error for a new custom tuple", async () => {
    const getPermissionSetCacheItems = vi
      .fn()
      .mockRejectedValue(new Error("cache unavailable"));
    await expect(
      validateNewAssignmentGrants(props, {
        idcConfig,
        principalStore: { getPermissionSetCacheItems },
      }),
    ).rejects.toThrow("cache unavailable");
  });

  it("allows new built-in tuples without a catalog read", async () => {
    const getPermissionSetCacheItems = vi
      .fn()
      .mockRejectedValue(new Error("cache unavailable"));
    await validateNewAssignmentGrants(
      {
        ...props,
        assignments: [
          owner,
          { ...custom, permissionSetArn: USER_PERMISSION_SET_ARN },
        ],
      },
      { idcConfig, principalStore: { getPermissionSetCacheItems } },
    );
    expect(getPermissionSetCacheItems).not.toHaveBeenCalled();
  });
});
