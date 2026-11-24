// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { SES_IDENTITY_ARN_REGEX } from "@amzn/innovation-sandbox-shared/utils/ses-identity-arn.js";

type SesIdentity =
  | { readonly kind: "email"; readonly address: string }
  | { readonly kind: "domain"; readonly domain: string };

function parseSesIdentityArn(arn: string): SesIdentity | undefined {
  const value = SES_IDENTITY_ARN_REGEX.exec(arn)?.[2];
  if (value === undefined) {
    return undefined;
  }
  return value.includes("@")
    ? { kind: "email", address: value }
    : { kind: "domain", domain: value.toLowerCase() };
}

/** Parses a non-empty ARN already accepted by a Lambda environment schema. */
export function parseValidatedSesIdentityArn(arn: string): SesIdentity {
  const identity = parseSesIdentityArn(arn);
  if (!identity) {
    throw new Error(
      "SES_IDENTITY_ARN passed startup validation but is unparsable",
    );
  }
  return identity;
}

/** Lists the address, optional untagged address, and parent domains SES may verify. */
export function candidateSesIdentities(emailFrom: string): string[] {
  const atIndex = emailFrom.lastIndexOf("@");
  if (atIndex < 1) {
    return [emailFrom];
  }
  const localPart = emailFrom.slice(0, atIndex);
  const domain = emailFrom.slice(atIndex + 1);
  const plusIndex = localPart.indexOf("+");
  const identities = [emailFrom];
  if (plusIndex > 0) {
    identities.push(`${localPart.slice(0, plusIndex)}@${domain}`);
  }
  const labels = domain.toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    identities.push(labels.slice(i).join("."));
  }
  return identities;
}

/** Whether a delegated SES identity covers a sender address. */
export function isSenderAddressCoveredBySesIdentity(
  identity: SesIdentity,
  emailFrom: string,
): boolean {
  const identityName =
    identity.kind === "email" ? identity.address : identity.domain;
  return candidateSesIdentities(emailFrom).includes(identityName);
}
