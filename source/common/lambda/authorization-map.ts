// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { IsbRole } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

export type HttpMethod =
  | "OPTIONS"
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "TRACE"
  | "CONNECT"
  | "ALL";

export interface AuthorizationMapType {
  [path: string]: {
    [method in HttpMethod]?: IsbRole[];
  };
}

export const authorizationMap: AuthorizationMapType = {
  "/leases": {
    GET: ["Manager", "Admin", "User"],
    POST: ["User", "Manager", "Admin"],
  },
  "/leases/{param}": {
    PATCH: ["Manager", "Admin"],
    GET: ["User", "Manager", "Admin"],
  },
  "/leases/{param}/costSummary": {
    GET: ["User", "Manager", "Admin"],
  },
  "/leases/{param}/costHistory": {
    GET: ["User", "Manager", "Admin"],
  },
  "/leases/{param}/bedrockTokenHistory": {
    GET: ["User", "Manager", "Admin"],
  },
  "/leases/{param}/breachHistory": {
    GET: ["User", "Manager", "Admin"],
  },
  "/leases/{param}/review": {
    POST: ["Manager", "Admin"],
  },
  "/leases/{param}/terminate": {
    POST: ["User", "Manager", "Admin"],
  },
  "/leases/{param}/freeze": {
    POST: ["Manager", "Admin"],
  },
  "/leases/{param}/unfreeze": {
    POST: ["Manager", "Admin"],
  },
  "/leaseTemplates": {
    GET: ["User", "Manager", "Admin"],
    POST: ["Admin", "Manager"],
  },
  "/leaseTemplates/{param}": {
    GET: ["User", "Manager", "Admin"],
    DELETE: ["Admin", "Manager"],
    PUT: ["Admin", "Manager"],
  },
  "/configurations": {
    GET: ["Manager", "Admin", "User"],
  },
  "/configurations/{param}": {
    GET: ["Manager", "Admin", "User"],
    PUT: ["Admin"],
  },
  "/accounts": {
    GET: ["Admin"],
    POST: ["Admin"],
  },
  "/accounts/{param}": {
    GET: ["Admin"],
  },
  "/accounts/{param}/retryCleanup": {
    POST: ["Admin"],
  },
  "/accounts/{param}/eject": {
    POST: ["Admin"],
  },
  "/accounts/{param}/quarantine": {
    POST: ["Admin"],
  },
  "/accounts/unregistered": {
    GET: ["Admin"],
  },
  "/accounts/{param}/cleanup-reports": {
    GET: ["Admin"],
  },
  "/accounts/{param}/skipCooldown": {
    POST: ["Admin"],
  },
  "/blueprints": {
    GET: ["Manager", "Admin"], // Managers can view for template selection
    POST: ["Admin"], // Only admins can create
  },
  "/blueprints/stacksets": {
    GET: ["Manager", "Admin"], // Managers need this for template creation
  },
  "/blueprints/{param}": {
    GET: ["Manager", "Admin"], // Managers can view for template selection
    PUT: ["Admin"], // Only admins can update
    DELETE: ["Admin"], // Only admins can delete
  },
  "/principals/search": {
    GET: ["User", "Manager", "Admin"],
  },
  "/permissionSets": {
    GET: ["Manager", "Admin"],
  },
  "/leases/{param}/assignments": {
    GET: ["User", "Manager", "Admin"],
    PUT: ["User", "Manager", "Admin"],
  },
  "/leases/shared": {
    GET: ["User", "Manager", "Admin"],
  },
  "/sandboxAgent/history": {
    GET: ["User", "Manager", "Admin"],
  },
  "/sandboxAgent/models": {
    GET: ["Admin"],
  },
  "/configurations/agent/models": {
    GET: ["User", "Manager", "Admin"],
  },
  "/configurations/agent/models/{param}": {
    PUT: ["Admin"],
  },
  "/sandboxAgent/usage": {
    GET: ["User", "Manager", "Admin"],
  },
};

export function getAllowedRoles(path: string, method: HttpMethod): IsbRole[] {
  const entry = authorizationMap[path];
  if (!entry) {
    return [];
  }
  const roles = entry[method];
  if (roles && roles.length > 0) {
    return roles;
  }
  return entry["ALL"] ?? [];
}

export function resolveAllowedRoles(
  path: string,
  method: HttpMethod,
): IsbRole[] {
  const exactRoles = getAllowedRoles(path, method);
  if (exactRoles.length > 0) {
    return exactRoles;
  }

  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) {
    return [];
  }

  // /resource/{param} — path parameter at end
  const withParamEnd = "/" + [...segments.slice(0, -1), "{param}"].join("/");
  const endRoles = getAllowedRoles(withParamEnd, method);
  if (endRoles.length > 0) {
    return endRoles;
  }

  // /resource/{param}/action — path parameter in middle
  if (segments.length >= 3) {
    const withParamMiddle =
      "/" + [...segments.slice(0, -2), "{param}", segments.at(-1)].join("/");
    const middleRoles = getAllowedRoles(withParamMiddle, method);
    if (middleRoles.length > 0) {
      return middleRoles;
    }
  }

  return [];
}
