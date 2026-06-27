// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  HttpMethod,
  authorizationMap,
} from "@amzn/innovation-sandbox-authorizer/authorization-map.js";
import { IsbContext } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import {
  IsbRole,
  IsbUser,
} from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { verifyJwt } from "@amzn/innovation-sandbox-commons/utils/jwt.js";

// doing await secretsMangerHelper.getStringSecret() here at the top level results in Top-level await is currently not
// supported with the "cjs" output error when synthesizing the templates as the infra module is commonjs
// so cache it by having it lazily initialized
let jwtSecret = "";

/**
 * extracts the method and the path from the given method arn
 * @param arn sample value arn:aws:execute-api:us-east-1:123456789012:aaaaaaaaaa/prod/GET/leases
 */
export function extractMethodAndPathFromArn(
  arn: string,
): { method: HttpMethod; path: string } | null {
  const parts = arn.replace(/\/$/, "").split("/");
  if (parts.length >= 4) {
    return {
      method: parts[2]! as HttpMethod,
      path: "/" + parts.slice(3).join("/"),
    };
  }
  return null;
}

/**
 * extracts the method and the path from the given method arn assuming the last entry is the path parameter and
 * replaces it with {param} as expected by the authorizationMap
 * @param arn sample value arn:aws:execute-api:us-east-1:123456789012:aaaaaaaaaa/prod/GET/leases/Lease101
 */
export function extractMethodAndPathFromArnWithPathParameterEnd(
  arn: string,
): { method: HttpMethod; path: string } | null {
  const parts = arn.replace(/\/$/, "").split("/");
  if (parts.length >= 5) {
    return {
      method: parts[2]! as HttpMethod,
      path: "/" + [...parts.slice(3, parts.length - 1), "{param}"].join("/"),
    };
  }
  return null;
}

/**
 * extracts the method and the path from the given method arn assuming the entry before the last  is the path
 * parameter and replaces it with {param} as expected by the authorizationMap
 * @param arn sample value arn:aws:execute-api:us-east-1:123456789012:aaaaaaaaaa/prod/POST/accounts/1234/eject
 */
export function extractMethodAndPathFromArnWithPathParameterMiddle(
  arn: string,
): { method: HttpMethod; path: string } | null {
  const parts = arn.replace(/\/$/, "").split("/");
  if (parts.length >= 5) {
    return {
      method: parts[2]! as HttpMethod,
      path:
        "/" +
        [
          ...parts.slice(3, parts.length - 2),
          "{param}",
          parts[parts.length - 1],
        ].join("/"),
    };
  }
  return null;
}

/**
 * extracts the method and the path from the given method arn assuming the entry third from the end is the path
 * parameter and replaces it with {param} as expected by the authorizationMap
 * @param arn sample value arn:aws:execute-api:us-east-1:123456789012:aaaaaaaaaa/prod/POST/leases/{uuid}/extend/review
 */
export function extractMethodAndPathFromArnWithPathParameterThirdFromEnd(
  arn: string,
): { method: HttpMethod; path: string } | null {
  const parts = arn.replace(/\/$/, "").split("/");
  if (parts.length >= 6) {
    return {
      method: parts[2]! as HttpMethod,
      path:
        "/" +
        [
          ...parts.slice(3, parts.length - 3),
          "{param}",
          parts[parts.length - 2],
          parts[parts.length - 1],
        ].join("/"),
    };
  }
  return null;
}

export function getAllowedRolesEntry(
  path: string,
  method: HttpMethod,
): IsbRole[] | undefined {
  return authorizationMap[path]?.[method];
}

export function getAllAllowedRoles(
  path: string,
  method: HttpMethod,
): IsbRole[] {
  const allowedRoles: IsbRole[] = getAllowedRolesEntry(path, method) ?? [];
  if (allowedRoles.length === 0) {
    allowedRoles.push(...(getAllowedRolesEntry(path, "ALL") ?? []));
  }
  return allowedRoles;
}

function getAllowedRolesForUrlPattern(
  props: {
    methodArn: string;
    authorizationToken: string;
  },
  extractMethodAndPathFunction: (
    url: string,
  ) => { method: HttpMethod; path: string } | null,
): IsbRole[] {
  const methodAndPathWithPathParameter = extractMethodAndPathFunction(
    props.methodArn,
  );
  if (!methodAndPathWithPathParameter) {
    return [];
  }
  const methodParam = methodAndPathWithPathParameter.method;
  const pathParam = methodAndPathWithPathParameter.path;
  return getAllAllowedRoles(pathParam, methodParam);
}

export async function isAuthorized(
  props: {
    methodArn: string;
    authorizationToken: string;
  },
  context: IsbContext<{
    env: {
      USER_AGENT_EXTRA: string;
      JWT_SECRET_NAME: string;
    };
  }>,
): Promise<boolean> {
  if (jwtSecret === "") {
    const secretsMangerHelper = IsbClients.secretsManager(context.env);
    jwtSecret = await secretsMangerHelper.getStringSecret(
      context.env.JWT_SECRET_NAME,
    );
  }

  const jwt = await verifyJwt(jwtSecret, props.authorizationToken);
  if (!jwt.verified) {
    return false;
  }

  const user: IsbUser = jwt.session.user;
  const roles = user.roles ?? [];

  const allowedRoles = getAllowedRolesForUrlPattern(
    props,
    extractMethodAndPathFromArn,
  );
  if (allowedRoles.length === 0) {
    allowedRoles.push(
      ...getAllowedRolesForUrlPattern(
        props,
        extractMethodAndPathFromArnWithPathParameterEnd,
      ),
    );
  }
  if (allowedRoles.length === 0) {
    allowedRoles.push(
      ...getAllowedRolesForUrlPattern(
        props,
        extractMethodAndPathFromArnWithPathParameterMiddle,
      ),
    );
  }
  if (allowedRoles.length === 0) {
    allowedRoles.push(
      ...getAllowedRolesForUrlPattern(
        props,
        extractMethodAndPathFromArnWithPathParameterThirdFromEnd,
      ),
    );
  }

  return roles?.some((role) => allowedRoles.includes(role));
}
