// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { IdcConfig } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/idc-stack-config.js";
import type { PersistedPermissionSetCacheItem } from "@amzn/innovation-sandbox-commons/data/permission-set/permission-set.js";
import type { PermissionProfileConfig } from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

export type AssignmentTupleKey = string & {
  readonly assignmentTupleKey: unique symbol;
};

export interface PermissionSetContext {
  idcConfig: IdcConfig;
  cacheByArn: ReadonlyMap<string, PersistedPermissionSetCacheItem>;
}

export type PermissionSetConfig = PermissionProfileConfig;

export type ResolvedPermissionSetConfig = PermissionProfileConfig & {
  defaultPermissionSetArn: string;
};

export interface HydratedPermissionSets {
  defaultPermissionSet: PermissionSetReference;
  allowedPermissionSets: PermissionSetReference[];
}
