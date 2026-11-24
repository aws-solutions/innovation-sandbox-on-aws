// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createSign, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  IdentityTokenError,
  IdentityVerifierEnv,
  extractSubFromAuthProvider,
  verifyAndExtractClaims,
} from "@amzn/innovation-sandbox-commons/lambda/auth/identity-token-verifier.js";
import { encodeTestToken } from "@amzn/innovation-sandbox-commons/test/lambdas/api-test-setup.js";
import {
  buildCognitoAuthProvider,
  createAPIGatewayProxyEvent,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { IDENTITY_HEADER } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

const SUB = "abc12345-6789-4abc-9def-0123456789ab";
const POOL_ID = "us-east-1_TEST";
const PROVIDER = buildCognitoAuthProvider(POOL_ID, SUB, "us-east-1");

const env: IdentityVerifierEnv = {
  COGNITO_USER_POOL_ID: POOL_ID,
  COGNITO_APP_CLIENT_ID: "test-client-id",
  COGNITO_MCP_CLIENT_ID: "test-mcp-client-id",
};

function buildEvent(overrides: {
  identityToken?: string;
  cognitoAuthenticationProvider?: string | null;
}) {
  return createAPIGatewayProxyEvent({
    httpMethod: "GET",
    path: "/test",
    headers: overrides.identityToken
      ? { [IDENTITY_HEADER]: overrides.identityToken }
      : {},
    identity: {
      cognitoAuthenticationProvider:
        overrides.cognitoAuthenticationProvider ?? null,
    },
  });
}

describe("identity-token-verifier", () => {
  describe("extractSubFromAuthProvider", () => {
    it("returns null for null/undefined/empty", () => {
      expect(extractSubFromAuthProvider(null)).toBeNull();
      expect(extractSubFromAuthProvider(undefined)).toBeNull();
      expect(extractSubFromAuthProvider("")).toBeNull();
    });

    it("extracts sub from the documented provider format", () => {
      expect(extractSubFromAuthProvider(PROVIDER)).toBe(SUB);
    });

    it("returns null when format is unrecognized", () => {
      expect(
        extractSubFromAuthProvider(
          "cognito-identity.amazonaws.com,SomethingElse",
        ),
      ).toBeNull();
      expect(extractSubFromAuthProvider("totally-unrelated")).toBeNull();
    });

    it("handles only the trailing CognitoSignIn segment", () => {
      expect(extractSubFromAuthProvider(`x:CognitoSignIn:${SUB}`)).toBe(SUB);
    });
  });

  describe("verifyAndExtractClaims", () => {
    it("throws IdentityTokenError(Missing) when x-isb-identity header is absent", async () => {
      await expect(
        verifyAndExtractClaims(buildEvent({}), env),
      ).rejects.toMatchObject({ name: "IdentityTokenError", kind: "Missing" });
      await expect(
        verifyAndExtractClaims(buildEvent({}), env),
      ).rejects.toBeInstanceOf(IdentityTokenError);
    });

    it("returns the verified payload when sub matches the IAM principal", async () => {
      const claims = { sub: SUB, "custom:isb_roles": '["User"]' };
      const result = await verifyAndExtractClaims(
        buildEvent({
          identityToken: encodeTestToken(claims),
          cognitoAuthenticationProvider: PROVIDER,
        }),
        env,
      );
      expect(result).toEqual(claims);
    });

    it("throws IdentityTokenError(Invalid) when JWKS verification fails", async () => {
      // Token without the test-token prefix → mock rejects with an error,
      // which the verifier catches and wraps as IdentityTokenError("Invalid").
      await expect(
        verifyAndExtractClaims(
          buildEvent({
            identityToken: "not-an-encoded-token",
            cognitoAuthenticationProvider: PROVIDER,
          }),
          env,
        ),
      ).rejects.toMatchObject({ name: "IdentityTokenError", kind: "Invalid" });
    });

    it("throws IdentityTokenError(SubMismatch) when token sub does not match cognitoAuthProvider sub", async () => {
      await expect(
        verifyAndExtractClaims(
          buildEvent({
            identityToken: encodeTestToken({ sub: "different-sub" }),
            cognitoAuthenticationProvider: PROVIDER,
          }),
          env,
        ),
      ).rejects.toMatchObject({
        name: "IdentityTokenError",
        kind: "SubMismatch",
      });
    });

    it("falls open (returns payload) when cognitoAuthenticationProvider is absent", async () => {
      const claims = { sub: SUB };
      const result = await verifyAndExtractClaims(
        buildEvent({
          identityToken: encodeTestToken(claims),
          cognitoAuthenticationProvider: null,
        }),
        env,
      );
      expect(result).toEqual(claims);
    });

    it("falls open and warns when cognitoAuthenticationProvider format is unrecognized", async () => {
      const claims = { sub: SUB };
      const result = await verifyAndExtractClaims(
        buildEvent({
          identityToken: encodeTestToken(claims),
          cognitoAuthenticationProvider: "unrecognized-format",
        }),
        env,
      );
      expect(result).toEqual(claims);
    });

    it("treats an event with no headers field as missing the identity header", async () => {
      // API Gateway always sets `headers` on incoming events, but the type
      // allows undefined; defensive against malformed events.
      const event = {
        requestContext: { identity: { cognitoAuthenticationProvider: null } },
      } as unknown as Parameters<typeof verifyAndExtractClaims>[0];
      await expect(verifyAndExtractClaims(event, env)).rejects.toMatchObject({
        name: "IdentityTokenError",
        kind: "Missing",
      });
    });
  });

  // The shared aws-jwt-verify mock ignores clientId, so these use the real
  // library with locally signed tokens to exercise the `aud` check itself.
  describe("app client audiences", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const KID = "test-kid";
    const { n, e } = publicKey.export({ format: "jwk" }) as {
      n: string;
      e: string;
    };

    function signIdToken(aud: string): string {
      const now = Math.floor(Date.now() / 1000);
      const encode = (part: object) =>
        Buffer.from(JSON.stringify(part)).toString("base64url");
      const unsigned = `${encode({ alg: "RS256", kid: KID, typ: "JWT" })}.${encode(
        {
          sub: SUB,
          aud,
          iss: `https://cognito-idp.us-east-1.amazonaws.com/${POOL_ID}`,
          token_use: "id",
          iat: now,
          exp: now + 3600,
        },
      )}`;
      const signature = createSign("RSA-SHA256")
        .update(unsigned)
        .sign(privateKey)
        .toString("base64url");
      return `${unsigned}.${signature}`;
    }

    let verify: typeof verifyAndExtractClaims;

    beforeAll(async () => {
      vi.resetModules(); // fresh verifier singleton, built with the real library
      vi.doUnmock("aws-jwt-verify");
      const { CognitoJwtVerifier } = await import("aws-jwt-verify");
      const create = CognitoJwtVerifier.create.bind(CognitoJwtVerifier);
      vi.spyOn(CognitoJwtVerifier, "create").mockImplementation(((
        ...args: Parameters<typeof create>
      ) => {
        const verifier = create(...args);
        // Serve the test key without fetching the pool's JWKS.
        verifier.cacheJwks(
          { keys: [{ kty: "RSA", n, e, kid: KID, alg: "RS256", use: "sig" }] },
          POOL_ID,
        );
        return verifier;
      }) as typeof create);
      ({ verifyAndExtractClaims: verify } =
        await import("@amzn/innovation-sandbox-commons/lambda/auth/identity-token-verifier.js"));
    });

    afterAll(() => {
      vi.restoreAllMocks();
      vi.resetModules();
    });

    it.each([
      ["web", env.COGNITO_APP_CLIENT_ID],
      ["MCP", env.COGNITO_MCP_CLIENT_ID],
    ])("accepts ID tokens issued to the %s app client", async (_, aud) => {
      const claims = await verify(
        buildEvent({ identityToken: signIdToken(aud) }),
        env,
      );
      expect(claims).toMatchObject({ sub: SUB, aud });
    });

    it("rejects ID tokens issued to any other app client", async () => {
      await expect(
        verify(
          buildEvent({ identityToken: signIdToken("other-client-id") }),
          env,
        ),
      ).rejects.toMatchObject({ name: "IdentityTokenError", kind: "Invalid" });
    });
  });
});
