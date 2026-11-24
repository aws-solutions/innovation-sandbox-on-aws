// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  type IsbUser,
  buildM2mSyntheticEmail,
  getUserEmail,
  getUserLabel,
  IdcIdentitySchema,
  isIdcUser,
  isM2MUser,
  M2M_EMAIL_DOMAIN,
  M2MIdentitySchema,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

describe("isIdcUser", () => {
  it("should return true for user type", () => {
    const user: IsbUser = generateSchemaData(IdcIdentitySchema);
    expect(isIdcUser(user)).toBe(true);
  });

  it("should return false for m2m type", () => {
    const user: IsbUser = generateSchemaData(M2MIdentitySchema);
    expect(isIdcUser(user)).toBe(false);
  });
});

describe("isM2MUser", () => {
  it("should return true for m2m type", () => {
    const user: IsbUser = generateSchemaData(M2MIdentitySchema);
    expect(isM2MUser(user)).toBe(true);
  });

  it("should return false for user type", () => {
    const user: IsbUser = generateSchemaData(IdcIdentitySchema);
    expect(isM2MUser(user)).toBe(false);
  });
});

describe("buildM2mSyntheticEmail", () => {
  it("should build synthetic email from clientId and role", () => {
    expect(buildM2mSyntheticEmail("my-client", "Admin")).toBe(
      `m2m-my-client-Admin@${M2M_EMAIL_DOMAIN}`,
    );
  });
});

describe("getUserEmail", () => {
  it("should return email for user tokens", () => {
    const user = generateSchemaData(IdcIdentitySchema, {
      email: "a@b.com",
    });
    expect(getUserEmail(user)).toBe("a@b.com");
  });

  it("should return synthetic email for m2m tokens", () => {
    const user = generateSchemaData(M2MIdentitySchema, {
      clientId: "4a8b2c1d-e5f6-7890-abcd-ef1234567890",
      roles: ["Admin", "Manager", "User"],
    });
    expect(getUserEmail(user)).toBe(
      `m2m-4a8b2c1d-e5f6-7890-abcd-ef1234567890-Admin@${M2M_EMAIL_DOMAIN}`,
    );
  });
});

describe("getUserLabel", () => {
  it("should return email when displayName and userName are not set", () => {
    const user = generateSchemaData(IdcIdentitySchema, {
      email: "a@b.com",
      displayName: undefined,
      userName: undefined,
    });
    expect(getUserLabel(user)).toBe("a@b.com");
  });

  it.each([undefined, ""])(
    "should return userName when displayName is %s",
    (displayName) => {
      const user = generateSchemaData(IdcIdentitySchema, {
        email: "a@b.com",
        displayName,
        userName: "alice",
      });
      expect(getUserLabel(user)).toBe("alice");
    },
  );

  it("should return displayName when set", () => {
    const user = generateSchemaData(IdcIdentitySchema, {
      email: "a@b.com",
      displayName: "Alice",
    });
    expect(getUserLabel(user)).toBe("Alice");
  });

  it("should return automation label for m2m tokens", () => {
    const user = generateSchemaData(M2MIdentitySchema, {
      clientId: "4a8b2c1d-e5f6-7890-abcd-ef1234567890",
    });
    expect(getUserLabel(user)).toBe(
      "Automation: 4a8b2c1d-e5f6-7890-abcd-ef1234567890",
    );
  });
});
