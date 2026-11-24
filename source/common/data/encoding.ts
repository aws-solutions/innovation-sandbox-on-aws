// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
export function base64EncodeCompositeKey(
  key: Record<string, any> | undefined,
): string | null {
  if (key === undefined) {
    return null;
  }

  const jsonStr = JSON.stringify(key);
  // base64url so the value is safe in URL path segments and query strings.
  return Buffer.from(jsonStr, "utf8").toString("base64url");
}

export function base64DecodeCompositeKey<
  T extends Record<string, unknown> = Record<string, unknown>,
>(encodedKey: string, validate?: (decoded: unknown) => T): T {
  const jsonStr = Buffer.from(encodedKey, "base64url").toString("utf8");
  const decoded: unknown = JSON.parse(jsonStr);
  return validate ? validate(decoded) : (decoded as T);
}

export class InvalidPageIdentifierError extends Error {
  constructor() {
    super("Invalid page identifier.");
    this.name = "InvalidPageIdentifierError";
  }
}

export function decodePageIdentifier<
  T extends Record<string, unknown> = Record<string, unknown>,
>(encodedKey: string, validate?: (decoded: unknown) => T): T;
export function decodePageIdentifier<
  T extends Record<string, unknown> = Record<string, unknown>,
>(encodedKey: undefined, validate?: (decoded: unknown) => T): undefined;
export function decodePageIdentifier<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  encodedKey: string | undefined,
  validate?: (decoded: unknown) => T,
): T | undefined;
export function decodePageIdentifier<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  encodedKey: string | undefined,
  validate?: (decoded: unknown) => T,
): T | undefined {
  if (encodedKey === undefined) {
    return undefined;
  }

  try {
    return base64DecodeCompositeKey(encodedKey, validate);
  } catch {
    throw new InvalidPageIdentifierError();
  }
}
