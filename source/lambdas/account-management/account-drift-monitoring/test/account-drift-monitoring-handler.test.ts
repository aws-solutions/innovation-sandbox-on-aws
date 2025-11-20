// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Account } from "@aws-sdk/client-organizations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler } from "@amzn/innovation-sandbox-account-drift-monitoring/account-drift-monitoring-handler.js";
import { DynamoSandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/dynamo-sandbox-account-store.js";
import {
  IsbOu,
  SandboxAccount,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { AccountDriftDetectedAlert } from "@amzn/innovation-sandbox-commons/events/account-drift-detected-alert.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import { AccountDriftMonitoringEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-drift-monitoring-environment.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";

const mockSendIsbEvents = vi.fn();
const mockUpdateSandboxAccountInDb = vi.fn();

const testEnv = generateSchemaData(AccountDriftMonitoringEnvironmentSchema);

beforeEach(() => {
  bulkStubEnv(testEnv);
  vi.spyOn(IsbEventBridgeClient.prototype, "sendIsbEvents").mockImplementation(
    mockSendIsbEvents,
  );
  vi.spyOn(DynamoSandboxAccountStore.prototype, "put").mockImplementation(
    mockUpdateSandboxAccountInDb,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("doAccountDriftMonitoring", () => {
  it("no drift", async () => {
    const allAccounts: SandboxAccount[] = [
      {
        awsAccountId: "111111111111",
        status: "Available",
      },
      {
        awsAccountId: "222222222222",
        status: "Active",
      },
    ];
    vi.spyOn(DynamoSandboxAccountStore.prototype, "findAll").mockReturnValue(
      Promise.resolve({
        result: allAccounts,
        nextPageIdentifier: null,
      }),
    );
    vi.spyOn(
      SandboxOuService.prototype,
      "listAllAccountsInOU",
    ).mockImplementation(async (ouName: IsbOu) => {
      switch (ouName) {
        case "Available":
          return [{ Id: allAccounts[0]!.awsAccountId }] as Account[];
        case "Active":
          return [{ Id: allAccounts[1]!.awsAccountId }] as Account[];
        default:
          return [] as Account[];
      }
    });
    await handler({}, mockContext(testEnv));
    expect(mockSendIsbEvents).toHaveBeenCalledTimes(0);
  });
  describe("drift detection", async () => {
    const trackedAccounts: SandboxAccount[] = [
      {
        awsAccountId: "111111111111",
        status: "Available",
      },
      {
        awsAccountId: "222222222222",
        status: "Active",
      },
      {
        awsAccountId: "333333333333",
        status: "CleanUp",
      },
      {
        awsAccountId: "444444444444",
        status: "CleanUp",
      },
    ];

    it("when drift first detected, account db is updated, but event is not sent", async () => {
      vi.spyOn(DynamoSandboxAccountStore.prototype, "findAll").mockReturnValue(
        Promise.resolve({
          result: trackedAccounts,
          nextPageIdentifier: null,
        }),
      );
      vi.spyOn(
        SandboxOuService.prototype,
        "listAllAccountsInOU",
      ).mockImplementation(async (ouName: IsbOu) => {
        switch (ouName) {
          case "Available":
            return [{ Id: trackedAccounts[0]!.awsAccountId }] as Account[]; //no drift same as with db
          case "Active":
            return [] as Account[]; // drift - nothing in active account[1] is not in any ou
          case "CleanUp":
            return [{ Id: trackedAccounts[2]!.awsAccountId }] as Account[]; //no drift
          case "Quarantine":
            return [] as Account[];
          case "Frozen":
            return [{ Id: trackedAccounts[3]!.awsAccountId }] as Account[]; //drift - account in wrong ou
          default:
            return [] as Account[];
        }
      });
      await handler({}, mockContext(testEnv));
      expect(mockSendIsbEvents).toHaveBeenCalledTimes(0);
      expect(mockUpdateSandboxAccountInDb).toHaveBeenCalledTimes(2);
      expect(mockUpdateSandboxAccountInDb).toHaveBeenCalledWith({
        awsAccountId: trackedAccounts[1]!.awsAccountId,
        status: "Active",
        driftAtLastScan: true,
      });
      expect(mockUpdateSandboxAccountInDb).toHaveBeenCalledWith({
        awsAccountId: "444444444444",
        status: "CleanUp",
        driftAtLastScan: true,
      });
    });

    it("on second drift detection, either event is sent or flag is removed", async () => {
      const allAccountsDrifted = trackedAccounts.map((account) => {
        return {
          ...account,
          driftAtLastScan: true,
        };
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "findAll").mockReturnValue(
        Promise.resolve({
          result: allAccountsDrifted,
          nextPageIdentifier: null,
        }),
      );
      vi.spyOn(
        SandboxOuService.prototype,
        "listAllAccountsInOU",
      ).mockImplementation(async (ouName: IsbOu) => {
        switch (ouName) {
          case "Available":
            return [{ Id: trackedAccounts[0]!.awsAccountId }] as Account[]; //no drift
          case "Active":
            return [] as Account[]; // drift - account[1] is not in any ou
          case "CleanUp":
            return [{ Id: trackedAccounts[2]!.awsAccountId }] as Account[]; //no drift
          case "Quarantine":
            return [] as Account[];
          case "Frozen":
            return [{ Id: trackedAccounts[3]!.awsAccountId }] as Account[]; //drift - account in wrong ou
          default:
            return [] as Account[];
        }
      });
      await handler({}, mockContext(testEnv));
      expect(mockSendIsbEvents).toHaveBeenCalledTimes(2);
      expect(mockUpdateSandboxAccountInDb).toHaveBeenCalledTimes(2);
      expect(mockSendIsbEvents).toHaveBeenCalledWith(
        expect.any(Tracer),
        new AccountDriftDetectedAlert({
          accountId: trackedAccounts[1]!.awsAccountId,
          actualOu: undefined,
          expectedOu: "Active",
        }),
      );
      expect(mockSendIsbEvents).toHaveBeenCalledWith(
        expect.any(Tracer),
        new AccountDriftDetectedAlert({
          accountId: trackedAccounts[3]!.awsAccountId,
          expectedOu: "CleanUp",
          actualOu: "Frozen",
        }),
      );
      expect(mockUpdateSandboxAccountInDb).toHaveBeenCalledWith({
        ...trackedAccounts[0]!,
        driftAtLastScan: false,
      });
      expect(mockUpdateSandboxAccountInDb).toHaveBeenCalledWith({
        ...trackedAccounts[2]!,
        driftAtLastScan: false,
      });
    });

    it("drift event is sent for untracked accounts", async () => {
      vi.spyOn(DynamoSandboxAccountStore.prototype, "findAll").mockReturnValue(
        Promise.resolve({
          result: trackedAccounts,
          nextPageIdentifier: null,
        }),
      );
      vi.spyOn(
        SandboxOuService.prototype,
        "listAllAccountsInOU",
      ).mockImplementation(async (ouName: IsbOu) => {
        switch (ouName) {
          case "Available":
            return [{ Id: trackedAccounts[0]!.awsAccountId }] as Account[]; //no drift
          case "Active":
            return [{ Id: trackedAccounts[1]!.awsAccountId }] as Account[]; //no drift
          case "CleanUp":
            return [
              { Id: trackedAccounts[2]!.awsAccountId },
              { Id: trackedAccounts[3]!.awsAccountId },
            ] as Account[]; //no drift
          case "Quarantine":
            return [] as Account[];
          case "Frozen":
            return [{ Id: "555555555555" }] as Account[]; //drift - account not tracked
          default:
            return [] as Account[];
        }
      });
      await handler({}, mockContext(testEnv));
      expect(mockSendIsbEvents).toHaveBeenCalledTimes(1);
      expect(mockUpdateSandboxAccountInDb).toHaveBeenCalledTimes(0);
      expect(mockSendIsbEvents).toHaveBeenCalledWith(
        expect.any(Tracer),
        new AccountDriftDetectedAlert({
          accountId: "555555555555",
          expectedOu: undefined,
          actualOu: "Frozen",
        }),
      );
    });
  });
});
