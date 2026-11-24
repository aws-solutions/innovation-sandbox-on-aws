// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AwsCredentialIdentity } from "@aws-sdk/types";
import {
  fetchAuthSession,
  signInWithRedirect,
  signOut,
} from "aws-amplify/auth";

import { resetApiSingletons } from "@amzn/innovation-sandbox-frontend/helpers/apiSingletons";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  COGNITO_IDC_DISPLAY_NAME_CLAIM,
  COGNITO_IDC_USER_ID_CLAIM,
  COGNITO_IDC_USER_NAME_CLAIM,
  CognitoEmailClaims,
  type IdcIdentity,
  parseRolesClaim,
  resolveEmailFromClaims,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

export type AuthResult =
  | { status: "authenticated"; user: IdcIdentity }
  | { status: "unauthenticated" }
  | { status: "incomplete_claims"; message: string };

/**
 * Auth service backed by Amazon Cognito via Amplify v6.
 * Tokens are managed by Amplify (storage, refresh, etc.).
 * ISB roles are injected into the ID token by the Pre Token Generation Lambda.
 */
export class CognitoAuthService {
  /** Returns the auth state: authenticated user, unauthenticated, or incomplete claims. */
  static async getCurrentUser(): Promise<AuthResult> {
    const session = await fetchAuthSession();
    const idToken = session.tokens?.idToken;

    if (!idToken) {
      return { status: "unauthenticated" };
    }

    const payload = idToken.payload;
    const email = resolveEmailFromClaims(payload as CognitoEmailClaims);
    const userId = payload[COGNITO_IDC_USER_ID_CLAIM] as string | undefined;
    const displayName = payload[COGNITO_IDC_DISPLAY_NAME_CLAIM] as
      string | undefined;
    const userName = payload[COGNITO_IDC_USER_NAME_CLAIM] as string | undefined;

    if (!email || !userId) {
      return {
        status: "incomplete_claims",
        message:
          "Your session is missing required claims. Please sign out and sign in again, or contact your administrator.",
      };
    }

    const roles = parseRolesClaim(
      payload["custom:isb_roles"] as string | undefined,
    );

    return {
      status: "authenticated",
      user: {
        type: "user" as const,
        email,
        userId,
        displayName,
        userName,
        roles,
      },
    };
  }

  /**
   * Returns the ID token string used as the `x-isb-identity` header, or
   * `null` if the session has no ID token (user not signed in). Underlying
   * Amplify errors (network, refresh failure, etc.) propagate so callers can
   * distinguish "no session" from "couldn't reach Cognito."
   */
  static async getIdToken(): Promise<string | null> {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() ?? null;
  }

  /**
   * Returns temporary AWS credentials vended by the Identity Pool, used to
   * SigV4-sign API Gateway requests. Returns `null` if the session has no
   * credentials (user not signed in). Underlying Amplify errors propagate.
   */
  static async getCredentials(): Promise<AwsCredentialIdentity | null> {
    const session = await fetchAuthSession();
    const c = session.credentials;
    if (!c?.accessKeyId || !c.secretAccessKey) return null;
    return {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
      expiration: c.expiration,
    };
  }

  /** Initiates the Cognito Hosted UI login flow via IAMIdentityCenter SAML provider. */
  static login(): void {
    signInWithRedirect({ provider: { custom: "IAMIdentityCenter" } });
  }

  /** Signs the user out of Cognito. */
  static async logout(): Promise<void> {
    // Clear memoized API service/client singletons BEFORE signing out. `signOut`
    // with an oauth redirect navigates away, so anything after it may not run;
    // and a memoized SigV4 credential stays valid past logout, so a stale client
    // must not survive into the next session.
    resetApiSingletons();
    await signOut({
      global: false,
      oauth: { redirectUrl: getConfig().AwsAccessPortalUrl },
    });
  }
}
