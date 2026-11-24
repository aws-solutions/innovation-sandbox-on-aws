// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ValidationException } from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import type { IdcConfig } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/idc-stack-config.js";
import type { IdcStackConfigStore } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/ssm-idc-stack-config-store.js";
import {
  permissionSetCacheSk,
  toPermissionSetSummary,
  type PersistedPermissionSetCacheItem,
} from "@amzn/innovation-sandbox-commons/data/permission-set/permission-set.js";
import type { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import { PermissionProfileConfigSchema } from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import type { DesiredAssignment } from "@amzn/innovation-sandbox-shared/types/lease.js";
import {
  MAX_ALLOWED_PERMISSION_SETS,
  permissionSetIdFromArn,
  type PermissionSetReference,
  type PermissionSetSummary,
} from "@amzn/innovation-sandbox-shared/types/permission-set.js";

import type {
  AssignmentTupleKey,
  HydratedPermissionSets,
  PermissionSetConfig,
  PermissionSetContext,
  ResolvedPermissionSetConfig,
} from "./permission-set.types.js";

type IdcConfigSource = IdcConfig | Pick<PermissionSetContext, "idcConfig">;

const UNRESOLVED_PERMISSION_SET_TUPLE = "<unresolved-permission-set>";

/** Callers resolve contextual permission-set defaults before building the key. */
export function assignmentTupleKey(
  props: Pick<
    DesiredAssignment,
    "principalType" | "principalId" | "permissionSetArn"
  >,
): AssignmentTupleKey {
  const { principalType, principalId, permissionSetArn } = props;
  return JSON.stringify([
    principalType,
    principalId,
    permissionSetArn ?? UNRESOLVED_PERMISSION_SET_TUPLE,
  ]) as AssignmentTupleKey;
}

function permissionSetArnPrefixForInstance(
  instanceArn: string,
): string | undefined {
  const prefix = instanceArn.replace(
    /:instance\/([^/]+)$/,
    ":permissionSet/$1/",
  );
  return prefix === instanceArn ? undefined : prefix;
}

function isPermissionSetArnForInstance(
  permissionSetArn: string,
  source: IdcConfigSource,
): boolean {
  const idcConfig = "idcConfig" in source ? source.idcConfig : source;
  const prefix = permissionSetArnPrefixForInstance(idcConfig.ssoInstanceArn);
  return prefix !== undefined && permissionSetArn.startsWith(prefix);
}

function getUsableCacheItem(
  permissionSetArn: string,
  source: IdcConfigSource,
  cached: PersistedPermissionSetCacheItem | undefined,
): PersistedPermissionSetCacheItem | undefined {
  if (!isPermissionSetArnForInstance(permissionSetArn, source)) {
    return undefined;
  }

  const permissionSetId = permissionSetIdFromArn(permissionSetArn);
  if (
    !cached ||
    !permissionSetId ||
    cached.permissionSetArn !== permissionSetArn ||
    cached.permissionSetId !== permissionSetId ||
    cached.sk !== permissionSetCacheSk(permissionSetId)
  ) {
    return undefined;
  }

  return cached;
}

/** Registration validation must opt into consistent reads; display reads use the default. */
export async function loadPermissionSetContext(
  idcStackConfigStore: Pick<IdcStackConfigStore, "get">,
  principalStore: Pick<PrincipalStore, "getPermissionSetCacheItems">,
  options: { consistentRead?: boolean } = {},
): Promise<PermissionSetContext> {
  const [idcConfig, cacheItems] = await Promise.all([
    idcStackConfigStore.get(),
    principalStore.getPermissionSetCacheItems(options),
  ]);

  return {
    idcConfig,
    cacheByArn: new Map(
      cacheItems.map((item) => [item.permissionSetArn, item]),
    ),
  };
}

export function isSystemPermissionSetArn(
  permissionSetArn: string,
  source: IdcConfigSource,
): boolean {
  const idcConfig = "idcConfig" in source ? source.idcConfig : source;

  return (
    permissionSetArn === idcConfig.adminPermissionSetArn ||
    permissionSetArn === idcConfig.managerPermissionSetArn
  );
}

export function getAssignablePermissionSets(
  context: PermissionSetContext,
): PermissionSetSummary[] {
  return [...context.cacheByArn.keys()]
    .filter(
      (permissionSetArn) =>
        !isSystemPermissionSetArn(permissionSetArn, context),
    )
    .map((permissionSetArn) =>
      getUsableCacheItem(
        permissionSetArn,
        context,
        context.cacheByArn.get(permissionSetArn),
      ),
    )
    .filter(
      (item): item is PersistedPermissionSetCacheItem => item !== undefined,
    )
    .map((item) => toPermissionSetSummary(item));
}

function resolvePermissionSetConfigValues(
  input: PermissionSetConfig,
  context: PermissionSetContext,
  previous?: PermissionSetConfig,
): ResolvedPermissionSetConfig {
  const defaultPermissionSetArn =
    input.defaultPermissionSetArn ??
    previous?.defaultPermissionSetArn ??
    context.idcConfig.userPermissionSetArn;
  const selectedAllowedPermissionSetArns =
    input.allowedPermissionSetArns ?? previous?.allowedPermissionSetArns;

  const parsedConfig = PermissionProfileConfigSchema.safeParse({
    defaultPermissionSetArn,
    allowedPermissionSetArns: selectedAllowedPermissionSetArns,
  });

  if (!parsedConfig.success) {
    throw new ValidationException(
      `Invalid permission set configuration: ${parsedConfig.error.issues
        .map(({ path, message }) => `${path.join(".")}: ${message}`)
        .join(", ")}`,
    );
  }

  return {
    defaultPermissionSetArn: parsedConfig.data.defaultPermissionSetArn!,
    allowedPermissionSetArns: parsedConfig.data.allowedPermissionSetArns,
  };
}

function getArnsRequiringCacheValidation(
  config: ResolvedPermissionSetConfig,
  referencedArns: ReadonlySet<string>,
  context: PermissionSetContext,
  previous?: PermissionSetConfig,
): ReadonlySet<string> {
  if (previous === undefined) {
    return referencedArns;
  }

  const previousDefaultPermissionSetArn =
    previous.defaultPermissionSetArn ?? context.idcConfig.userPermissionSetArn;
  const previousEffectiveArns = new Set([
    previousDefaultPermissionSetArn,
    ...(previous.allowedPermissionSetArns ?? []),
  ]);
  const arnsRequiringCacheValidation = new Set<string>();

  if (config.defaultPermissionSetArn !== previousDefaultPermissionSetArn) {
    arnsRequiringCacheValidation.add(config.defaultPermissionSetArn);
  }

  for (const permissionSetArn of referencedArns) {
    if (!previousEffectiveArns.has(permissionSetArn)) {
      arnsRequiringCacheValidation.add(permissionSetArn);
    }
  }

  return arnsRequiringCacheValidation;
}

function assertAssignablePermissionSetReference(
  permissionSetArn: string,
  source: IdcConfigSource,
): void {
  if (!isPermissionSetArnForInstance(permissionSetArn, source)) {
    throw new ValidationException(
      `Permission set ${permissionSetArn} does not belong to this deployment's IAM Identity Center instance.`,
    );
  }
  if (isSystemPermissionSetArn(permissionSetArn, source)) {
    throw new ValidationException(
      `Permission set ${permissionSetArn} is a system role and cannot be assigned to lease users.`,
    );
  }
}

function validatePermissionSetReferences(
  referencedArns: ReadonlySet<string>,
  arnsRequiringCacheValidation: ReadonlySet<string>,
  context: PermissionSetContext,
): void {
  for (const permissionSetArn of referencedArns) {
    assertAssignablePermissionSetReference(permissionSetArn, context);
    if (
      arnsRequiringCacheValidation.has(permissionSetArn) &&
      permissionSetArn !== context.idcConfig.userPermissionSetArn &&
      !getUsableCacheItem(
        permissionSetArn,
        context,
        context.cacheByArn.get(permissionSetArn),
      )
    ) {
      throw new ValidationException(
        `Permission set ${permissionSetArn} is not registered in this deployment's catalog.`,
      );
    }
  }
}

/**
 * Resolves concrete permission-set configuration and validates its references.
 *
 * Omitted update members preserve persisted values. A missing create or legacy
 * persisted default resolves to the built-in user permission set. Updates may
 * retain references that have since disappeared from the cache, but a changed
 * default or newly allowed reference must still be currently registered.
 */
export function resolvePermissionSetConfig(
  input: PermissionSetConfig,
  context: PermissionSetContext,
  previous?: PermissionSetConfig,
): ResolvedPermissionSetConfig {
  const resolvedConfig = resolvePermissionSetConfigValues(
    input,
    context,
    previous,
  );
  const referencedArns = new Set([
    resolvedConfig.defaultPermissionSetArn,
    ...(resolvedConfig.allowedPermissionSetArns ?? []),
  ]);
  if (referencedArns.size > MAX_ALLOWED_PERMISSION_SETS) {
    throw new ValidationException(
      `A permission profile can contain at most ${MAX_ALLOWED_PERMISSION_SETS} effective permission sets, including the default.`,
    );
  }
  const arnsRequiringCacheValidation = getArnsRequiringCacheValidation(
    resolvedConfig,
    referencedArns,
    context,
    previous,
  );

  validatePermissionSetReferences(
    referencedArns,
    arnsRequiringCacheValidation,
    context,
  );

  return resolvedConfig;
}

/**
 * Authorizes an actual grant against the current cached registration. The
 * configured built-in profile does not require a registration tag or cache row.
 * Existing access and revocation do not use this check.
 */
export function assertPermissionSetGrantAllowed(
  permissionSetArn: string,
  idcConfig: IdcConfig,
  cacheItem?: PersistedPermissionSetCacheItem,
): void {
  assertAssignablePermissionSetReference(permissionSetArn, idcConfig);
  if (
    permissionSetArn !== idcConfig.userPermissionSetArn &&
    !getUsableCacheItem(permissionSetArn, idcConfig, cacheItem)
  ) {
    throw new ValidationException(
      `Permission set ${permissionSetArn} is not registered in this deployment's catalog. Register it again or select an available permission set before granting access.`,
    );
  }
}

/**
 * Rejects new desired tuples using unavailable profiles without blocking
 * removals or unchanged bulk PUT entries. The worker still checks every actual
 * grant, including retries for unchanged tuples that have no access yet.
 */
export async function validateNewAssignmentGrants(
  props: {
    assignments: readonly DesiredAssignment[];
    previousAssignments?: readonly DesiredAssignment[];
    defaultPermissionSetArn: string;
  },
  services: {
    idcConfig: IdcConfig;
    principalStore: Pick<PrincipalStore, "getPermissionSetCacheItems">;
  },
): Promise<void> {
  const tuple = (assignment: DesiredAssignment) =>
    assignmentTupleKey({
      ...assignment,
      permissionSetArn:
        assignment.permissionSetArn ?? props.defaultPermissionSetArn,
    });
  const previousTuples = new Set((props.previousAssignments ?? []).map(tuple));
  const newArns = new Set(
    props.assignments
      .filter((assignment) => !previousTuples.has(tuple(assignment)))
      .map(
        (assignment) =>
          assignment.permissionSetArn ?? props.defaultPermissionSetArn,
      ),
  );
  if (newArns.size === 0) return;

  const context: PermissionSetContext = {
    idcConfig: services.idcConfig,
    cacheByArn: new Map(),
  };
  validatePermissionSetReferences(newArns, new Set(), context);
  if (
    [...newArns].some((arn) => arn !== services.idcConfig.userPermissionSetArn)
  ) {
    const cacheItems = await services.principalStore.getPermissionSetCacheItems(
      {
        consistentRead: true,
      },
    );
    context.cacheByArn = new Map(
      cacheItems.map((item) => [item.permissionSetArn, item]),
    );
  }
  for (const arn of newArns) {
    assertPermissionSetGrantAllowed(
      arn,
      context.idcConfig,
      context.cacheByArn.get(arn),
    );
  }
}

export function hydratePermissionSetReference(
  permissionSetArn: string,
  context: PermissionSetContext,
): PermissionSetReference {
  const cached = getUsableCacheItem(
    permissionSetArn,
    context,
    context.cacheByArn.get(permissionSetArn),
  );
  if (cached) {
    return {
      permissionSetArn,
      permissionSetId: cached.permissionSetId,
      name: cached.name,
      description: cached.description,
      sessionDuration: cached.sessionDuration,
      availability: "AVAILABLE",
    };
  }

  const permissionSetId = permissionSetIdFromArn(permissionSetArn);
  if (!permissionSetId) {
    throw new Error(
      `Cannot hydrate malformed permission set ARN: ${permissionSetArn}`,
    );
  }

  return {
    permissionSetArn,
    permissionSetId,
    availability: "UNAVAILABLE",
  };
}

/**
 * Projects persisted ARN configuration into response-only permission-set
 * references. The effective allowed set contains the default exactly once.
 */
export function hydratePermissionSets(
  config: PermissionSetConfig,
  context: PermissionSetContext,
): HydratedPermissionSets {
  const defaultPermissionSetArn =
    config.defaultPermissionSetArn ?? context.idcConfig.userPermissionSetArn;
  const effectiveAllowedArns = [
    ...new Set([
      defaultPermissionSetArn,
      ...(config.allowedPermissionSetArns ?? []),
    ]),
  ];

  return {
    defaultPermissionSet: hydratePermissionSetReference(
      defaultPermissionSetArn,
      context,
    ),
    allowedPermissionSets: effectiveAllowedArns.map((permissionSetArn) =>
      hydratePermissionSetReference(permissionSetArn, context),
    ),
  };
}
