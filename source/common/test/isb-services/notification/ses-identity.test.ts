// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  candidateSesIdentities,
  isSenderAddressCoveredBySesIdentity,
  parseValidatedSesIdentityArn,
} from "@amzn/innovation-sandbox-commons/isb-services/notification/ses-identity.js";
import { describe, expect, it } from "vitest";

const domainIdentity = { kind: "domain", domain: "example.com" } as const;
const emailIdentity = {
  kind: "email",
  address: "user@example.com",
} as const;

describe("parseValidatedSesIdentityArn", () => {
  it("parses and normalizes a domain identity", () => {
    expect(
      parseValidatedSesIdentityArn(
        "arn:aws:ses:us-east-1:123456789012:identity/Example.COM",
      ),
    ).toEqual(domainIdentity);
  });

  it("preserves email identity case", () => {
    expect(
      parseValidatedSesIdentityArn(
        "arn:aws:ses:us-east-1:123456789012:identity/User@Example.COM",
      ),
    ).toEqual({ kind: "email", address: "User@Example.COM" });
  });

  it("accepts partition variants", () => {
    expect(
      parseValidatedSesIdentityArn(
        "arn:aws-us-gov:ses:us-gov-west-1:123456789012:identity/example.com",
      ),
    ).toEqual(domainIdentity);
  });

  it.each([
    { description: "empty string", arn: "" },
    {
      description: "no identity segment",
      arn: "arn:aws:ses:us-east-1:123456789012:not-an-identity",
    },
    {
      description: "empty identity value",
      arn: "arn:aws:ses:us-east-1:123456789012:identity/",
    },
    {
      description: "wrong service",
      arn: "arn:aws:sns:us-east-1:123456789012:identity/example.com",
    },
    {
      description: "non-numeric account",
      arn: "arn:aws:ses:us-east-1:abc:identity/example.com",
    },
    { description: "bare domain", arn: "example.com" },
    {
      description: "unsupported global-endpoint ARN",
      arn: "arn:aws:ses:*:123456789012:identity/example.com",
    },
  ])("throws for $description without echoing it", ({ arn }) => {
    expect(() => parseValidatedSesIdentityArn(arn)).toThrow(
      /^SES_IDENTITY_ARN passed startup validation but is unparsable$/,
    );
  });
});

describe("candidateSesIdentities", () => {
  it("lists the address, then each domain down to the registrable suffix", () => {
    expect(candidateSesIdentities("user@mail.corp.example.com")).toEqual([
      "user@mail.corp.example.com",
      "mail.corp.example.com",
      "corp.example.com",
      "example.com",
    ]);
  });

  it("lowercases domains but preserves the address as given", () => {
    expect(candidateSesIdentities("User@Example.COM")).toEqual([
      "User@Example.COM",
      "example.com",
    ]);
  });

  it("includes the verified base address for a plus label", () => {
    expect(candidateSesIdentities("user+alerts@Example.COM")).toEqual([
      "user+alerts@Example.COM",
      "user@Example.COM",
      "example.com",
    ]);
  });

  it("returns only the input when it has no domain", () => {
    expect(candidateSesIdentities("not-an-email")).toEqual(["not-an-email"]);
  });
});

describe("isSenderAddressCoveredBySesIdentity", () => {
  it.each([
    {
      description: "exact match on an email identity",
      identity: emailIdentity,
      emailFrom: "user@example.com",
      expected: true,
    },
    {
      description: "case-sensitive mismatch on an email identity",
      identity: { kind: "email", address: "Sender@EXAMPLE.com" } as const,
      emailFrom: "sender@example.com",
      expected: false,
    },
    {
      description: "plus label on an email identity",
      identity: emailIdentity,
      emailFrom: "user+alerts@example.com",
      expected: true,
    },
    {
      description: "case-sensitive plus-label mismatch on an email identity",
      identity: emailIdentity,
      emailFrom: "User+alerts@example.com",
      expected: false,
    },
    {
      description: "sibling address on an email identity",
      identity: emailIdentity,
      emailFrom: "other@example.com",
      expected: false,
    },
    {
      description: "subdomain address on an email identity",
      identity: emailIdentity,
      emailFrom: "user@mail.example.com",
      expected: false,
    },
    {
      description: "same domain on a domain identity",
      identity: domainIdentity,
      emailFrom: "anyone@example.com",
      expected: true,
    },
    {
      description: "case-insensitive domain match",
      identity: domainIdentity,
      emailFrom: "anyone@EXAMPLE.com",
      expected: true,
    },
    {
      description: "subdomain on a domain identity",
      identity: domainIdentity,
      emailFrom: "anyone@mail.corp.example.com",
      expected: true,
    },
    {
      description: "different domain on a domain identity",
      identity: domainIdentity,
      emailFrom: "anyone@example.org",
      expected: false,
    },
    {
      description: "look-alike suffix without a dot boundary",
      identity: domainIdentity,
      emailFrom: "anyone@notexample.com",
      expected: false,
    },
  ])("$description", ({ identity, emailFrom, expected }) => {
    expect(isSenderAddressCoveredBySesIdentity(identity, emailFrom)).toBe(
      expected,
    );
  });
});
