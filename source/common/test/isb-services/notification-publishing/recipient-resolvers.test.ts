// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import {
  resolveAdminRecipients,
  resolveAssignmentRecipients,
  resolveManagerRecipients,
  resolveUserRecipients,
} from "@amzn/innovation-sandbox-commons/isb-services/notification-publishing/recipient-resolvers.js";
import { describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted above module-level const declarations, so the
// fixture values the factory closes over must themselves be declared via
// vi.hoisted -- referencing a plain top-level const here throws a
// ReferenceError at hoist time.
const { managerEmails, adminEmails } = vi.hoisted(() => ({
  managerEmails: ["manager@example.com", "manager2@example.com"],
  adminEmails: ["admin@example.com"],
}));

vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/notification/email-address-utils.js",
  async () => {
    const actual = (await vi.importActual(
      "@amzn/innovation-sandbox-commons/isb-services/notification/email-address-utils.js",
    )) as any;
    return {
      ...actual,
      allAdmins: vi.fn().mockResolvedValue(adminEmails),
      allManagers: vi.fn().mockResolvedValue(managerEmails),
    };
  },
);

describe("recipient-resolvers", () => {
  describe("resolveUserRecipients", () => {
    it("returns the single event-owning user as the sole recipient", () => {
      expect(resolveUserRecipients("user@example.com")).toEqual([
        "user@example.com",
      ]);
    });
  });

  describe("resolveAssignmentRecipients", () => {
    it("returns the lease owner alone when no assignee email is present", () => {
      expect(resolveAssignmentRecipients("owner@example.com")).toEqual([
        "owner@example.com",
      ]);
    });

    it("returns both the lease owner and a distinct assignee email", () => {
      expect(
        resolveAssignmentRecipients(
          "owner@example.com",
          "assignee@example.com",
        ),
      ).toEqual(["owner@example.com", "assignee@example.com"]);
    });

    it("de-duplicates when the assignee email matches the lease owner", () => {
      expect(
        resolveAssignmentRecipients("owner@example.com", "owner@example.com"),
      ).toEqual(["owner@example.com"]);
    });
  });

  describe("resolveManagerRecipients", () => {
    it("resolves the union of admins and managers via the same IdcService calls the SES path uses", async () => {
      const idcService = {} as IdcService;

      const recipients = await resolveManagerRecipients(idcService);

      expect(recipients.sort()).toEqual(
        [...adminEmails, ...managerEmails].sort(),
      );
    });

    it("de-duplicates a user who is both an admin and a manager", async () => {
      const { allAdmins, allManagers } =
        await import("@amzn/innovation-sandbox-commons/isb-services/notification/email-address-utils.js");
      vi.mocked(allAdmins).mockResolvedValueOnce(["shared@example.com"]);
      vi.mocked(allManagers).mockResolvedValueOnce([
        "shared@example.com",
        "manager2@example.com",
      ]);
      const idcService = {} as IdcService;

      const recipients = await resolveManagerRecipients(idcService);

      expect(recipients.sort()).toEqual(
        ["shared@example.com", "manager2@example.com"].sort(),
      );
    });

    it("starts both recipient lookups before either completes", async () => {
      const { allAdmins, allManagers } =
        await import("@amzn/innovation-sandbox-commons/isb-services/notification/email-address-utils.js");

      // Deferred promises let the test control exactly when each lookup
      // settles, so both call sites are provably invoked before either
      // resolves -- a sequential `await a(); await b();` implementation
      // would never call `allManagers` until `adminDeferred` resolves.
      let resolveAdmins!: (value: string[]) => void;
      let resolveManagers!: (value: string[]) => void;
      const adminDeferred = new Promise<string[]>((resolve) => {
        resolveAdmins = resolve;
      });
      const managerDeferred = new Promise<string[]>((resolve) => {
        resolveManagers = resolve;
      });
      vi.mocked(allAdmins).mockReturnValueOnce(adminDeferred);
      vi.mocked(allManagers).mockReturnValueOnce(managerDeferred);
      const idcService = {} as IdcService;
      // Mocks in this file are not reset between tests, so calls accumulate
      // across the suite -- the assertions below compare against this
      // baseline rather than an absolute count.
      const adminCallsBefore = vi.mocked(allAdmins).mock.calls.length;
      const managerCallsBefore = vi.mocked(allManagers).mock.calls.length;

      const resultPromise = resolveManagerRecipients(idcService);

      // Both underlying calls must already have happened by this point --
      // neither deferred promise has resolved yet.
      expect(vi.mocked(allAdmins).mock.calls.length).toEqual(
        adminCallsBefore + 1,
      );
      expect(vi.mocked(allManagers).mock.calls.length).toEqual(
        managerCallsBefore + 1,
      );

      resolveAdmins(["admin@example.com"]);
      resolveManagers(["manager@example.com"]);
      const recipients = await resultPromise;

      expect(recipients.sort()).toEqual(
        ["admin@example.com", "manager@example.com"].sort(),
      );
    });
  });

  describe("resolveAdminRecipients", () => {
    it("resolves admins only, excluding managers", async () => {
      const idcService = {} as IdcService;

      const recipients = await resolveAdminRecipients(idcService);

      expect(recipients.sort()).toEqual([...adminEmails].sort());
      for (const managerEmail of managerEmails) {
        expect(recipients).not.toContain(managerEmail);
      }
    });
  });
});
