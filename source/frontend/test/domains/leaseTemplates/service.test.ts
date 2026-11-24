// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { signOut } from "aws-amplify/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LeaseTemplateView } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/model";
import {
  getLeaseTemplateService,
  LeaseTemplateService,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/service";
import { SmithyLeaseTemplateApi } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/smithy-client";
import { CreateLeaseTemplateRequest } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/types";
import { resetApiSingletons } from "@amzn/innovation-sandbox-frontend/helpers/apiSingletons";
import { CognitoAuthService } from "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService";

const createMockGeneratedApi = (): SmithyLeaseTemplateApi => ({
  listLeaseTemplates: vi.fn(),
  createLeaseTemplate: vi.fn(),
  getLeaseTemplate: vi.fn(),
  updateLeaseTemplate: vi.fn(),
  deleteLeaseTemplate: vi.fn(),
});

const template: LeaseTemplateView = {
  uuid: "00000000-0000-4000-8000-000000000001",
  name: "Pilot template",
  requiresApproval: true,
  createdBy: "owner@example.com",
  visibility: "PRIVATE",
  allowOwnerToShareLease: false,
  predictiveBudgetEnabled: false,
  bedrockTokenMonitoringEnabled: false,
  sandboxSpacesEnabled: true,
  meta: {
    createdTime: "2026-08-01T12:00:00.000Z",
    lastEditTime: "2026-08-02T13:30:00.000Z",
    schemaVersion: 4,
  },
};

const newTemplate: CreateLeaseTemplateRequest = {
  name: "Pilot template",
  requiresApproval: true,
  visibility: "PRIVATE",
  allowOwnerToShareLease: false,
  predictiveBudgetEnabled: false,
  bedrockTokenMonitoringEnabled: false,
  sandboxSpacesEnabled: true,
  defaultPermissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
  allowedPermissionSetArns: [
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
  ],
};

describe("LeaseTemplateService smithy-client operations", () => {
  let api: SmithyLeaseTemplateApi;

  beforeEach(() => {
    api = createMockGeneratedApi();
  });

  it("memoizes the production service and rebuilds it after resetApiSingletons()", () => {
    const first = getLeaseTemplateService();
    expect(first).toBeInstanceOf(LeaseTemplateService);
    // Same instance while the session is unchanged …
    expect(getLeaseTemplateService()).toBe(first);
    // … but a reset (logout / authenticated-user change) forces a fresh service +
    // client, so the next session never reuses the prior client's memoized SigV4
    // credentials.
    resetApiSingletons();
    expect(getLeaseTemplateService()).not.toBe(first);
  });

  it("logout resets the singletons BEFORE awaiting signOut (so the reset runs before the redirect)", async () => {
    const before = getLeaseTemplateService();

    // Hold signOut pending. logout() must reset the singletons *before* awaiting
    // signOut — otherwise the oauth redirect could tear down the page before the
    // reset runs. Asserting while signOut is still in flight fails if the reset
    // were moved after `await signOut(...)` (the memo would still be `before`).
    let releaseSignOut!: () => void;
    vi.mocked(signOut).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseSignOut = resolve;
      }),
    );

    const logoutPromise = CognitoAuthService.logout();
    expect(getLeaseTemplateService()).not.toBe(before);

    releaseSignOut();
    await logoutPromise;
  });

  it("routes every operation through the generated client", async () => {
    vi.mocked(api.listLeaseTemplates)
      .mockResolvedValueOnce({
        result: [template],
        nextPageIdentifier: "next-page",
      })
      .mockResolvedValueOnce({
        result: [],
        nextPageIdentifier: null,
      });
    vi.mocked(api.getLeaseTemplate).mockResolvedValue(template);
    const service = new LeaseTemplateService(api);

    await expect(service.getLeaseTemplates()).resolves.toEqual([template]);
    await service.addLeaseTemplate(newTemplate);
    await expect(service.getLeaseTemplateById(template.uuid)).resolves.toEqual(
      template,
    );
    await service.updateLeaseTemplate(template);
    await service.deleteLeaseTemplates([template.uuid, "another-id"]);

    expect(api.listLeaseTemplates).toHaveBeenNthCalledWith(1, undefined);
    expect(api.listLeaseTemplates).toHaveBeenNthCalledWith(2, "next-page");
    expect(api.createLeaseTemplate).toHaveBeenCalledWith(newTemplate);
    expect(api.getLeaseTemplate).toHaveBeenCalledWith(template.uuid);
    // updateLeaseTemplate strips server-owned members (uuid, blueprintName,
    // createdBy) before passing the body through.
    expect(api.updateLeaseTemplate).toHaveBeenCalledWith(
      template.uuid,
      expect.objectContaining({
        name: template.name,
        requiresApproval: template.requiresApproval,
        visibility: template.visibility,
        meta: template.meta,
      }),
    );
    const updateBody = vi.mocked(api.updateLeaseTemplate).mock
      .calls[0]![1] as Record<string, unknown>;
    expect(updateBody).not.toHaveProperty("uuid");
    expect(updateBody).not.toHaveProperty("createdBy");
    expect(updateBody).not.toHaveProperty("blueprintName");
    expect(api.deleteLeaseTemplate).toHaveBeenNthCalledWith(1, template.uuid);
    expect(api.deleteLeaseTemplate).toHaveBeenNthCalledWith(2, "another-id");
  });
});
