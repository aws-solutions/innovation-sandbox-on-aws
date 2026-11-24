// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PaginatedQueryResult } from "@amzn/innovation-sandbox-commons/data/common-types.js";
import type { IsbUser } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger();

type CacheType = "Admin" | "Manager" | "User";

interface UserCacheEntry {
  users: PaginatedQueryResult<IsbUser>;
  lastUpdated: Date;
}

// the key here can be the page identifier
const cachedUsers: { [key: string]: UserCacheEntry } = {};
const cachedManagers: { [key: string]: UserCacheEntry } = {};
const cachedAdmins: { [key: string]: UserCacheEntry } = {};

const CACHE_EXPIRATION_MILLI = 5 * 60 * 1000; //5 minutes

function getCacheObject(cacheType: CacheType) {
  switch (cacheType) {
    case "Admin":
      return cachedAdmins;
    case "Manager":
      return cachedManagers;
    case "User":
      return cachedUsers;
  }
}

function getCachedObjects(
  cacheType: CacheType,
  key: string,
): PaginatedQueryResult<IsbUser> | null {
  const cache = getCacheObject(cacheType);
  if (cache[key]) {
    const { users, lastUpdated } = cache[key];
    const diff = Date.now() - lastUpdated.getTime();
    if (diff > CACHE_EXPIRATION_MILLI) {
      logger.debug(`${cacheType} Cache miss - expired for key ${key}`);
      delete cachedUsers[key];
      return null;
    } else {
      logger.debug(`${cacheType} Cache hit for key ${key}`);
      return users;
    }
  } else {
    logger.debug(`${cacheType} Cache miss - cache empty for key ${key}`);
    return null;
  }
}

function cacheObjects(
  cacheType: CacheType,
  key: string,
  users: PaginatedQueryResult<IsbUser>,
) {
  const cache = getCacheObject(cacheType);
  cache[key] = {
    users,
    lastUpdated: new Date(),
  };
}

export function getCachedUsers(
  key: string,
): PaginatedQueryResult<IsbUser> | null {
  return getCachedObjects("User", key);
}

export function cacheUsers(key: string, users: PaginatedQueryResult<IsbUser>) {
  cacheObjects("User", key, users);
}

export function getCachedManagers(
  key: string,
): PaginatedQueryResult<IsbUser> | null {
  return getCachedObjects("Manager", key);
}

export function cacheManagers(
  key: string,
  users: PaginatedQueryResult<IsbUser>,
) {
  cacheObjects("Manager", key, users);
}

export function getCachedAdmins(
  key: string,
): PaginatedQueryResult<IsbUser> | null {
  return getCachedObjects("Admin", key);
}

export function cacheAdmins(key: string, users: PaginatedQueryResult<IsbUser>) {
  cacheObjects("Admin", key, users);
}

export function clearCache() {
  Object.keys(cachedUsers).forEach((key) => delete cachedUsers[key]);
  Object.keys(cachedManagers).forEach((key) => delete cachedManagers[key]);
  Object.keys(cachedAdmins).forEach((key) => delete cachedAdmins[key]);
}
