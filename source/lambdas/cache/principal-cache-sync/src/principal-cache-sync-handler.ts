// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { EventBridgeSchema } from "@aws-lambda-powertools/parser/schemas";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { z } from "zod";

import {
  PERMISSION_SET_CACHE_PK,
  PersistedPermissionSetCacheItem,
  managedPermissionSetTagKey,
  permissionSetCacheSk,
} from "@amzn/innovation-sandbox-commons/data/permission-set/permission-set.js";
import {
  PRINCIPAL_CACHE_GROUP_SK_PREFIX,
  PRINCIPAL_CACHE_PK,
  PRINCIPAL_CACHE_USER_SK_PREFIX,
  PersistedPrincipalCacheItem,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  PrincipalCacheSyncEnvironment,
  PrincipalCacheSyncEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/principal-cache-sync-environment.js";
import baseMiddlewareBundle, {
  IsbLambdaContext,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { assertNever } from "@amzn/innovation-sandbox-commons/types/type-guards.js";
import { fromTemporaryIsbIdcCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import {
  calculateTtlInEpochSeconds,
  nowAsIsoDatetimeString,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import { permissionSetIdFromArn } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

const serviceName = "PrincipalCacheSync";
const tracer = new Tracer({ serviceName });
const logger = new Logger({ serviceName });

type SyncContext = IsbLambdaContext<PrincipalCacheSyncEnvironment>;
type IdcService = ReturnType<typeof IsbServices.idcService>;
type PrincipalStore = ReturnType<typeof IsbServices.principalStore>;
type IdcStackConfigStore = ReturnType<typeof IsbServices.idcStackConfigStore>;

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: PrincipalCacheSyncEnvironmentSchema,
  moduleName: "principal-cache-sync",
}).handler(handleCacheSync);

const EventIdentitySchema = z.object({
  accountId: AwsAccountIdSchema,
  arn: z.string().optional(),
});
const EventTagSchema = z.object({
  key: z.string(),
  value: z.string(),
});
const CommonPermissionSetEventDetailSchema = z.object({
  eventSource: z.literal("sso.amazonaws.com"),
  userIdentity: EventIdentitySchema,
  errorCode: z.never().optional(),
  errorMessage: z.never().optional(),
});
const PermissionSetEventDetailSchema = z.discriminatedUnion("eventName", [
  CommonPermissionSetEventDetailSchema.extend({
    eventName: z.literal("CreatePermissionSet"),
    requestParameters: z.object({
      instanceArn: z.string(),
      tags: z.array(EventTagSchema).optional(),
    }),
    responseElements: z.object({
      permissionSet: z.object({
        permissionSetArn: z.string(),
      }),
    }),
  }),
  CommonPermissionSetEventDetailSchema.extend({
    eventName: z.literal("TagResource"),
    requestParameters: z.object({
      instanceArn: z.string().optional(),
      resourceArn: z.string(),
      tags: z.array(EventTagSchema),
    }),
  }),
  CommonPermissionSetEventDetailSchema.extend({
    eventName: z.literal("UntagResource"),
    requestParameters: z.object({
      instanceArn: z.string().optional(),
      resourceArn: z.string(),
      tagKeys: z.array(z.string()),
    }),
  }),
  CommonPermissionSetEventDetailSchema.extend({
    eventName: z.literal("DeletePermissionSet"),
    requestParameters: z.object({
      instanceArn: z.string(),
      permissionSetArn: z.string(),
    }),
  }),
  CommonPermissionSetEventDetailSchema.extend({
    eventName: z.literal("UpdatePermissionSet"),
    requestParameters: z.object({
      instanceArn: z.string(),
      permissionSetArn: z.string(),
    }),
  }),
]);
const PermissionSetEventSchema = EventBridgeSchema.extend({
  "detail-type": z.literal("AWS API Call via CloudTrail"),
  source: z.literal("aws.sso"),
  account: AwsAccountIdSchema,
  detail: PermissionSetEventDetailSchema,
});
const ScheduledSyncEventSchema = z.object({
  source: z.literal("scheduled"),
});

type PermissionSetEvent = z.infer<typeof PermissionSetEventSchema>;

function permissionSetArnFromEvent(
  detail: PermissionSetEvent["detail"],
): string {
  switch (detail.eventName) {
    case "CreatePermissionSet":
      return detail.responseElements.permissionSet.permissionSetArn;
    case "DeletePermissionSet":
    case "UpdatePermissionSet":
      return detail.requestParameters.permissionSetArn;
    case "TagResource":
    case "UntagResource":
      return detail.requestParameters.resourceArn;
    default:
      return assertNever(detail);
  }
}

async function handleCacheSync(event: unknown, context: SyncContext) {
  const permissionSetEvent = PermissionSetEventSchema.safeParse(event);
  if (permissionSetEvent.success) {
    await handlePermissionSetEvent(permissionSetEvent.data, context);
    return;
  }
  if (!ScheduledSyncEventSchema.safeParse(event).success) {
    logger.warn("Ignoring unsupported or malformed cache sync invocation");
    return;
  }

  await handlePrincipalCacheSync(context);
}

async function handlePrincipalCacheSync(context: SyncContext) {
  const { env } = context;
  const credentials = fromTemporaryIsbIdcCredentials(env);
  const idcService = IsbServices.idcService(env, credentials);
  const principalStore = IsbServices.principalStore(env);

  logger.info("Starting principal cache sync");

  const isbMemberIds = await idcService.listAllIsbMemberIds();
  const allUsers = await idcService.listAllUsers();
  const users = allUsers.filter((u) => isbMemberIds.has(u.principalId));
  const groups = await idcService.listAllGroups();

  logger.info("Fetched and filtered principals from Identity Store", {
    totalIdentityStoreUsers: allUsers.length,
    isbMembers: isbMemberIds.size,
    isbUsers: users.length,
    groupCount: groups.length,
  });

  const now = nowAsIsoDatetimeString();
  const ttl = calculateTtlInEpochSeconds(2);

  const cacheItems = [
    ...users.map((u) => ({
      pk: PRINCIPAL_CACHE_PK,
      sk: `${PRINCIPAL_CACHE_USER_SK_PREFIX}${u.principalId}`,
      principalId: u.principalId,
      principalType: u.principalType,
      displayName: u.displayName,
      ...(u.email && { email: u.email }),
      syncedAt: now,
      ttl,
    })),
    ...groups.map((g) => ({
      pk: PRINCIPAL_CACHE_PK,
      sk: `${PRINCIPAL_CACHE_GROUP_SK_PREFIX}${g.principalId}`,
      principalId: g.principalId,
      principalType: g.principalType,
      displayName: g.displayName,
      syncedAt: now,
      ttl,
    })),
  ] satisfies PersistedPrincipalCacheItem[];

  const existingItems = await principalStore.getCacheItems({});
  const existingSks = new Set(existingItems.map((item) => item.sk));
  const newSks = new Set(cacheItems.map((item) => item.sk));
  const staleSks = [...existingSks].filter((sk) => !newSks.has(sk));

  await principalStore.batchPutCacheItems(cacheItems);

  if (staleSks.length > 0) {
    await principalStore.batchDeleteCacheItemsBySk(staleSks);
    logger.info("Deleted stale cache records", { count: staleSks.length });
  }

  logger.info("Principal cache sync complete", {
    usersWritten: users.length,
    groupsWritten: groups.length,
    staleDeleted: staleSks.length,
  });

  await syncPermissionSetCache({
    env,
    idcService,
    principalStore,
    idcStackConfigStore: IsbServices.idcStackConfigStore(env),
  }).catch((error) => {
    logger.error("Permission set cache sync failed", { error });
    throw error;
  });
}

async function handlePermissionSetEvent(
  event: PermissionSetEvent,
  context: SyncContext,
): Promise<void> {
  const { env } = context;
  if (
    event.account !== env.IDC_ACCOUNT_ID ||
    event.detail.userIdentity.accountId !== env.IDC_ACCOUNT_ID
  ) {
    logger.warn("Ignoring permission set event from an unexpected account", {
      eventAccount: event.account,
      actorAccount: event.detail.userIdentity.accountId,
    });
    return;
  }

  const idcConfig = await IsbServices.idcStackConfigStore(context.env).get();
  const { detail } = event;
  const permissionSetArn = permissionSetArnFromEvent(detail);
  const requestInstanceArn = detail.requestParameters.instanceArn;
  if (
    (requestInstanceArn !== undefined &&
      requestInstanceArn !== idcConfig.ssoInstanceArn) ||
    !permissionSetArn
  ) {
    logger.warn("Ignoring malformed or cross-instance permission set event");
    return;
  }

  const expectedPermissionSetPrefix = idcConfig.ssoInstanceArn.replace(
    ":instance/",
    ":permissionSet/",
  );
  const permissionSetId = permissionSetIdFromArn(permissionSetArn);
  if (
    !permissionSetId ||
    !permissionSetArn.startsWith(`${expectedPermissionSetPrefix}/`)
  ) {
    logger.warn("Ignoring permission set event for a different IDC instance", {
      permissionSetArn,
    });
    return;
  }

  const managedTagKey = managedPermissionSetTagKey(env.ISB_NAMESPACE);
  if (
    (detail.eventName === "CreatePermissionSet" ||
      detail.eventName === "TagResource") &&
    !detail.requestParameters.tags?.some(({ key }) => key === managedTagKey)
  ) {
    return;
  }
  if (
    detail.eventName === "UntagResource" &&
    !detail.requestParameters.tagKeys.includes(managedTagKey)
  ) {
    return;
  }

  const principalStore = IsbServices.principalStore(env);
  const isBuiltInDefault = permissionSetArn === idcConfig.userPermissionSetArn;
  const isSystemRole =
    permissionSetArn === idcConfig.adminPermissionSetArn ||
    permissionSetArn === idcConfig.managerPermissionSetArn;
  const credentials = fromTemporaryIsbIdcCredentials(env);
  const idcService = IsbServices.idcService(env, credentials);
  const permissionSet = await idcService.getPermissionSet(permissionSetArn);
  const isRegistered =
    permissionSet !== undefined &&
    !isBuiltInDefault &&
    !isSystemRole &&
    (await idcService.isPermissionSetRegistered(
      permissionSetArn,
      env.ISB_NAMESPACE,
    ));

  if (permissionSet && (isBuiltInDefault || (isRegistered && !isSystemRole))) {
    const item = toPermissionSetCacheItem(permissionSet);
    const existingItem = (
      await principalStore.getPermissionSetCacheItems()
    ).find(({ sk }) => sk === item.sk);
    await principalStore.batchPutPermissionSetCacheItems([
      {
        ...item,
        meta: existingItem?.meta,
      },
    ]);
    logger.info("Applied permission set cache event", {
      action: "UPSERT",
      eventId: event.id,
      eventTime: event.time,
      eventName: detail.eventName,
      permissionSetArn,
      permissionSetName: permissionSet.name,
      actorAccount: detail.userIdentity.accountId,
      actorArn: detail.userIdentity.arn,
    });
    return;
  }

  await principalStore.batchDeletePermissionSetCacheItemsBySk([
    permissionSetCacheSk(permissionSetId),
  ]);
  logger.info("Applied permission set cache event", {
    action: "DELETE",
    eventId: event.id,
    eventTime: event.time,
    eventName: detail.eventName,
    permissionSetArn,
    permissionSetName: permissionSet?.name,
    actorAccount: detail.userIdentity.accountId,
    actorArn: detail.userIdentity.arn,
  });
}

async function syncPermissionSetCache(props: {
  env: PrincipalCacheSyncEnvironment;
  idcService: IdcService;
  principalStore: PrincipalStore;
  idcStackConfigStore: IdcStackConfigStore;
}): Promise<void> {
  const { env, idcService, principalStore, idcStackConfigStore } = props;
  logger.info("Starting permission set cache sync");

  // Complete every IDC/config read before mutating the cache. If discovery
  // fails, the existing permission-set cache remains untouched.
  const [registeredPermissionSets, idcConfig] = await Promise.all([
    idcService.listRegisteredPermissionSets(env.ISB_NAMESPACE),
    idcStackConfigStore.get(),
  ]);

  const excludedPermissionSetArns = new Set([
    idcConfig.adminPermissionSetArn,
    idcConfig.managerPermissionSetArn,
  ]);
  const assignablePermissionSets = registeredPermissionSets.filter(
    ({ permissionSetArn }) => !excludedPermissionSetArns.has(permissionSetArn),
  );

  if (
    !assignablePermissionSets.some(
      ({ permissionSetArn }) =>
        permissionSetArn === idcConfig.userPermissionSetArn,
    )
  ) {
    const builtInPermissionSet = await idcService.getPermissionSet(
      idcConfig.userPermissionSetArn,
    );
    if (!builtInPermissionSet) {
      throw new Error(
        `Built-in user permission set is unavailable: ${idcConfig.userPermissionSetArn}`,
      );
    }

    assignablePermissionSets.push(builtInPermissionSet);
  }

  const now = nowAsIsoDatetimeString();
  const targetItemsBySk = new Map<string, PersistedPermissionSetCacheItem>();
  for (const permissionSet of assignablePermissionSets) {
    const item = toPermissionSetCacheItem(permissionSet, now);
    targetItemsBySk.set(item.sk, item);
  }

  const existingItems = await principalStore.getPermissionSetCacheItems();
  const existingItemsBySk = new Map(
    existingItems.map((item) => [item.sk, item]),
  );
  const itemsToPut = [...targetItemsBySk.values()]
    .filter((item) => {
      const existingItem = existingItemsBySk.get(item.sk);
      return (
        existingItem === undefined ||
        !samePermissionSetCacheValue(existingItem, item)
      );
    })
    .map((item) => ({
      ...item,
      meta: existingItemsBySk.get(item.sk)?.meta,
    }));
  const staleSks = existingItems
    .filter((item) => !targetItemsBySk.has(item.sk))
    .map((item) => item.sk);

  // Upsert before deleting. A failed write cannot partially empty the prior
  // cache, and stale entries are retained until every replacement is durable.
  if (itemsToPut.length > 0) {
    await principalStore.batchPutPermissionSetCacheItems(itemsToPut);
  }
  if (staleSks.length > 0) {
    await principalStore.batchDeletePermissionSetCacheItemsBySk(staleSks);
  }

  logger.info("Permission set cache sync complete", {
    discovered: registeredPermissionSets.length,
    assignable: targetItemsBySk.size,
    written: itemsToPut.length,
    staleDeleted: staleSks.length,
  });
}

function toPermissionSetCacheItem(
  permissionSet: NonNullable<
    Awaited<ReturnType<IdcService["getPermissionSet"]>>
  >,
  syncedAt = nowAsIsoDatetimeString(),
): PersistedPermissionSetCacheItem {
  return {
    pk: PERMISSION_SET_CACHE_PK,
    sk: permissionSetCacheSk(permissionSet.permissionSetId),
    permissionSetArn: permissionSet.permissionSetArn,
    permissionSetId: permissionSet.permissionSetId,
    name: permissionSet.name,
    ...(permissionSet.description !== undefined && {
      description: permissionSet.description,
    }),
    ...(permissionSet.sessionDuration !== undefined && {
      sessionDuration: permissionSet.sessionDuration,
    }),
    syncedAt,
  };
}

function samePermissionSetCacheValue(
  existingItem: PersistedPermissionSetCacheItem,
  targetItem: PersistedPermissionSetCacheItem,
): boolean {
  return (
    existingItem.permissionSetArn === targetItem.permissionSetArn &&
    existingItem.permissionSetId === targetItem.permissionSetId &&
    existingItem.name === targetItem.name &&
    existingItem.description === targetItem.description &&
    existingItem.sessionDuration === targetItem.sessionDuration
  );
}
