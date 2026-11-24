// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { enumErrorMap } from "./zod.js";

export const IsbRoleSchema = z.enum(["Admin", "Manager", "User"], {
  error: enumErrorMap,
});

export type IsbRole = z.infer<typeof IsbRoleSchema>;

export const IdcIdentitySchema = z.object({
  type: z.literal("user"),
  email: z.email(),
  displayName: z.string().optional(),
  userName: z.string().optional(),
  userId: z.string(),
  roles: z.array(IsbRoleSchema).default([]),
});

export const M2MIdentitySchema = z.object({
  type: z.literal("m2m"),
  clientId: z.string(),
  roles: z.array(IsbRoleSchema).default([]),
});

export type IdcIdentity = z.infer<typeof IdcIdentitySchema>;
export type M2MIdentity = z.infer<typeof M2MIdentitySchema>;
export type IsbUser = IdcIdentity | M2MIdentity;

export const COGNITO_ISB_ROLES_CLAIM = "custom:isb_roles";
export const COGNITO_USERNAME_CLAIM = "cognito:username";
export const COGNITO_IDC_USER_ID_CLAIM = "custom:idc_user_id";
export const COGNITO_IDC_DISPLAY_NAME_CLAIM = "custom:idc_display_name";
export const COGNITO_IDC_USER_NAME_CLAIM = "custom:idc_user_name";
/**
 * Custom HTTP header that carries the Cognito ID token on SigV4-signed
 * requests. Read by the `captureIsbUser` middleware to extract RBAC
 * claims; redacted from request logs by the sanitizer middleware.
 */
export const IDENTITY_HEADER = "x-isb-identity";
// Uses email format because fields like createdBy validate with z.string().email().
// The .local TLD is reserved (RFC 6762) and cannot receive real email.
export const M2M_EMAIL_DOMAIN = "automation.local";

export function buildM2mSyntheticEmail(
  clientId: string,
  role: IsbRole,
): string {
  return `m2m-${clientId}-${role}@${M2M_EMAIL_DOMAIN}`;
}

/**
 * Maps an M2M role tier (extracted from the assumed-role ARN,
 * case-insensitive) to a single-element `IsbRole` array, or `[]` if it
 * doesn't match. Single-element rather than cumulative ([Admin, Manager,
 * User]) because routes in `authorization-map.ts` already list every
 * eligible role explicitly.
 */
export function m2mRoleTierToRoles(roleTier: string): IsbRole[] {
  const normalized =
    roleTier.charAt(0).toUpperCase() + roleTier.slice(1).toLowerCase();
  const parsed = IsbRoleSchema.safeParse(normalized);
  return parsed.success ? [parsed.data] : [];
}

export function isIdcUser(user: IsbUser): user is IdcIdentity {
  return user.type === "user";
}

export function isM2MUser(user: IsbUser): user is M2MIdentity {
  return user.type === "m2m";
}

export function isAdminOrManager(user: IsbUser): boolean {
  return user.roles.includes("Admin") || user.roles.includes("Manager");
}

export function getUserEmail(user: IsbUser): string {
  if (isM2MUser(user)) {
    // roles[0] is the highest-privilege tier ("Admin" wins over "Manager" /
    // "User"). captureIsbUser rejects M2M callers with empty roles upstream
    // (403), so this is non-null at handler time.
    return buildM2mSyntheticEmail(user.clientId, user.roles[0]!);
  }
  return user.email;
}

/**
 * True if the email is an M2M synthetic address (`...@automation.local`).
 * Such an assignee has no IDC user record, so it can never receive a lease
 * IDC grant — see {@link M2M_EMAIL_DOMAIN}.
 */
export function isSyntheticM2mEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`@${M2M_EMAIL_DOMAIN}`);
}

export function getUserLabel(user: IsbUser): string {
  if (isM2MUser(user)) {
    return `Automation: ${user.clientId}`;
  }
  return user.displayName || user.userName || user.email;
}

/**
 * Minimal claim shape accepted by {@link resolveEmailFromClaims}.
 * Both `CognitoIdTokenPayload` (aws-jwt-verify) and Amplify's
 * `JWT.payload` satisfy this interface without explicit casting.
 */
export interface CognitoEmailClaims {
  email?: unknown;
  [COGNITO_USERNAME_CLAIM]?: unknown;
}

/**
 * Extracts an email from a Cognito SAML username.
 * Format: `<ProviderName>_<email>` (e.g. `IAMIdentityCenter_user@example.com`).
 */
function extractEmailFromCognitoUsername(
  username: string | undefined,
): string | undefined {
  if (!username?.includes("_")) {
    return undefined;
  }
  const extracted = username.substring(username.indexOf("_") + 1);
  if (extracted.includes("@")) {
    return extracted;
  }
  return undefined;
}

/**
 * Resolves an email from Cognito token claims.
 * Tries `email` first, falls back to extracting from `cognito:username`.
 */
export function resolveEmailFromClaims(
  claims: CognitoEmailClaims,
): string | undefined {
  const email = typeof claims.email === "string" ? claims.email : undefined;
  const username =
    typeof claims[COGNITO_USERNAME_CLAIM] === "string"
      ? claims[COGNITO_USERNAME_CLAIM]
      : undefined;
  return email || extractEmailFromCognitoUsername(username);
}

/**
 * Parses the `custom:isb_roles` claim (JSON-encoded string array) into validated IsbRole[].
 * Returns an empty array when the claim is missing or contains no valid roles.
 */
export function parseRolesClaim(
  rolesClaimValue: string | undefined,
): IsbRole[] {
  if (!rolesClaimValue) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(rolesClaimValue);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((role) => IsbRoleSchema.safeParse(role).success);
  } catch {
    return [];
  }
}
