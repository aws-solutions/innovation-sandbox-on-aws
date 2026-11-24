// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BLOCKED_FLAGS,
  executeSandboxCli,
} from "@amzn/innovation-sandbox-agent-runtime/tools/execute-sandbox-cli.js";
import { base64EncodeCompositeKey } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";

const { execFileMock, credentialsMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  credentialsMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("util")>();
  return {
    ...actual,
    // promisify(execFile) returns our mock directly so tests can control it
    promisify: (fn: unknown) =>
      fn === execFileMock ? execFileMock : actual.promisify(fn as never),
  };
});

/**
 * Mock the shared credential utility rather than the STS client:
 * `fromTemporaryCredentials` builds its STS client internally, so
 * aws-sdk-client-mock cannot intercept it and the calls would hit live AWS.
 * Asserting on what we pass the utility verifies our logic — role ARNs,
 * SourceIdentity, session name, session policy — without a network call.
 */
vi.mock(
  "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@amzn/innovation-sandbox-commons/utils/cross-account-roles.js")
    >()),
    fromTemporaryIsbSpokeCredentials: credentialsMock,
  }),
);

/** The args of the single credential call made during a tool invocation. */
function credentialCall(): {
  intermediateRoleArn: string;
  targetRoleArn: string;
  sessionName: string;
  intermediateSessionName?: string;
  sourceIdentity?: string;
  sessionPolicy?: string;
  policyArns?: string[];
  customUserAgent: string;
} {
  return credentialsMock.mock.calls[0]![0];
}

const SANDBOX_ACCOUNT = "222222222222";
const HUB_ACCOUNT = "111111111111";
const LEASE_KEY = { userEmail: "alice@example.com", uuid: crypto.randomUUID() };
const LEASE_ID = base64EncodeCompositeKey(LEASE_KEY)!;

const env = {
  INTERMEDIATE_ROLE_ARN:
    "arn:aws:iam::111111111111:role/InnovationSandbox-myisb-IntermediateRole",
  SANDBOX_ACCOUNT_ROLE_NAME: "InnovationSandbox-myisb-SandboxAccountRole",
  SANDBOX_AGENT_ROLE_NAME: "SandboxAgentRole-myisb",
  HUB_ACCOUNT_ID: HUB_ACCOUNT,
  USER_AGENT_EXTRA: "test-agent",
};

function makeServices({
  leaseStatus = "Active",
  leaseAccountId = SANDBOX_ACCOUNT,
  leaseFound = true,
  leaseKey = LEASE_KEY,
} = {}) {
  const leaseStore = {
    get: vi.fn().mockResolvedValue(
      leaseFound
        ? {
            result: {
              ...leaseKey,
              status: leaseStatus,
              awsAccountId: leaseAccountId,
            },
          }
        : {},
    ),
  } as unknown as LeaseStore;
  return {
    leaseStore,
  };
}

const userInput = {
  args: ["s3", "ls"],
  accountId: SANDBOX_ACCOUNT,
  region: "us-east-1",
  actorId: "alice-at-example-d-com",
  leaseId: LEASE_ID,
  permissionProfilePolicy: {
    Version: "2012-10-17" as const,
    Statement: [{ Effect: "Allow" as const, Action: "*", Resource: "*" }],
  },
};

describe("executeSandboxCli", () => {
  beforeEach(() => {
    credentialsMock.mockReset();
    credentialsMock.mockReturnValue(async () => ({
      accessKeyId: "AKIA-TEST",
      secretAccessKey: "secret",
      sessionToken: "token",
    }));
    execFileMock.mockReset();
    execFileMock.mockResolvedValue({ stdout: "bucket-a\n", stderr: "" });
  });

  describe("lease validation (user persona)", () => {
    it("proceeds for an Active lease", async () => {
      const result = await executeSandboxCli(userInput, makeServices(), env);
      expect(result.status).toBe("success");
      expect(result.stdout).toBe("bucket-a\n");
    });

    it("rejects a terminated lease without calling STS", async () => {
      const result = await executeSandboxCli(
        userInput,
        makeServices({ leaseStatus: "ManuallyTerminated" }),
        env,
      );
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/ManuallyTerminated/);
      expect(credentialsMock).not.toHaveBeenCalled();
    });

    it("rejects when the lease is not found", async () => {
      const result = await executeSandboxCli(
        userInput,
        makeServices({ leaseFound: false }),
        env,
      );
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/not found/i);
    });

    it("rejects when no leaseId is provided", async () => {
      const result = await executeSandboxCli(
        { ...userInput, leaseId: undefined },
        makeServices(),
        env,
      );
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/lease is required/i);
    });
  });

  describe("accountId validation", () => {
    it("rejects a user targeting an account that does not match the lease", async () => {
      const result = await executeSandboxCli(
        { ...userInput, accountId: "333333333333" },
        makeServices(),
        env,
      );
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/does not match/i);
    });

    it("always rejects the hub account", async () => {
      const result = await executeSandboxCli(
        {
          ...userInput,
          accountId: HUB_ACCOUNT,
        },
        makeServices(),
        env,
      );
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/hub account/i);
      expect(credentialsMock).not.toHaveBeenCalled();
    });
  });

  describe("option parser — service location behind global options", () => {
    // The parser must correctly locate the service even when leading global
    // options are present. Previously tested as "protected services" but
    // enforcement has moved to session policy + SCPs — these now verify
    // that the parser finds the service and does NOT wrongly block it.

    it.each([
      ["--region with value", ["--region", "us-east-1", "s3", "ls"]],
      ["--output with value", ["--output", "json", "s3", "ls"]],
      ["--region=inline form", ["--region=us-east-1", "s3", "ls"]],
      ["--no-paginate valueless flag", ["--no-paginate", "s3", "ls"]],
      [
        "several stacked options",
        [
          "--no-paginate",
          "--region",
          "us-east-1",
          "--output",
          "json",
          "s3",
          "ls",
        ],
      ],
    ])("finds the service correctly after %s", async (_label, args) => {
      const result = await executeSandboxCli(
        { ...userInput, args },
        makeServices(),
        env,
      );
      expect(result.status).toBe("success");
      expect(credentialsMock).toHaveBeenCalled();
    });

    it("allows a permitted service behind global options", async () => {
      const result = await executeSandboxCli(
        { ...userInput, args: ["--region", "us-east-1", "s3", "ls"] },
        makeServices(),
        env,
      );
      expect(result.status).toBe("success");
    });

    it("errors when the command is only global options", async () => {
      const result = await executeSandboxCli(
        { ...userInput, args: ["--region", "us-east-1"] },
        makeServices(),
        env,
      );
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/no aws service/i);
    });
  });

  describe("global option parsing (fails closed)", () => {
    // --debug, --no-verify-ssl and --no-sign-request are also valueless
    // globals, but they are rejected outright — see the blocked-arguments tests.
    it.each(["--no-paginate", "--cli-auto-prompt", "--no-cli-pager"])(
      "treats %s as valueless and finds the service after it",
      async (flag) => {
        const result = await executeSandboxCli(
          { ...userInput, args: [flag, "s3", "ls"] },
          makeServices(),
          env,
        );
        expect(result.status).toBe("success");
      },
    );

    it("refuses an unrecognized global option instead of guessing", async () => {
      // The bypass this prevents: were the unknown option assumed valueless,
      // the parser would land on "value" and let `iam` through unchecked.
      const result = await executeSandboxCli(
        {
          ...userInput,
          args: ["--some-future-opt", "value", "iam", "create-user"],
        },
        makeServices(),
        env,
      );
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/unrecognized global option/i);
      expect(result.message).toContain("--some-future-opt");
      expect(credentialsMock).not.toHaveBeenCalled();
    });

    it("names the supported options so a stale list is actionable", async () => {
      const result = await executeSandboxCli(
        { ...userInput, args: ["--bogus", "s3", "ls"] },
        makeServices(),
        env,
      );
      expect(result.message).toContain("--region");
      expect(result.message).toContain("--debug");
    });

    it("accepts any --flag=value form without needing to know the flag", async () => {
      const result = await executeSandboxCli(
        { ...userInput, args: ["--cli-read-timeout=5", "s3", "ls"] },
        makeServices(),
        env,
      );
      expect(result.status).toBe("success");
    });
  });

  describe("destructive detection behind global options", () => {
    it("prompts for a destructive operation after a leading option", async () => {
      // Also positional: the prompt read args[1], so a leading option hid it.
      const result = await executeSandboxCli(
        {
          ...userInput,
          args: [
            "--region",
            "us-east-1",
            "s3api",
            "delete-bucket",
            "--bucket",
            "b",
          ],
        },
        makeServices(),
        env,
      );
      expect(result.status).toBe("confirmation_required");
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  describe("blocked arguments (off-AWS redirect / local file read)", () => {
    it.each([
      ["--endpoint-url", ["s3", "ls", "--endpoint-url", "https://example.com"]],
      ["--endpoint-url=", ["s3", "ls", "--endpoint-url=https://example.com"]],
      ["--ca-bundle", ["s3", "ls", "--ca-bundle", "example-ca-bundle.pem"]],
      ["--no-verify-ssl", ["s3", "ls", "--no-verify-ssl"]],
      ["--no-sign-request", ["s3", "ls", "--no-sign-request"]],
      // Leading position too: the parser recognizes these as valueless global
      // options, so the block must not depend on where they appear.
      ["leading --no-verify-ssl", ["--no-verify-ssl", "s3", "ls"]],
      [
        "file:// input",
        ["ec2", "run-instances", "--cli-input-json", "file:///etc/passwd"],
      ],
      ["fileb:// input", ["s3", "cp", "fileb:///etc/shadow", "s3://b/x"]],
      [
        "file:// in inline --flag=value form",
        ["ec2", "run-instances", "--cli-input-json=file:///etc/passwd"],
      ],
      // The AWS CLI reads an unambiguous prefix of a global option as that option.
      ["--endpoint=", ["s3", "ls", "--endpoint=https://example.com"]],
      ["--endpoint", ["s3", "ls", "--endpoint", "https://example.com"]],
      ["--endpoint-u=", ["s3", "ls", "--endpoint-u=https://example.com"]],
      [
        "--e",
        ["s3", "presign", "s3://bucket/key", "--e", "https://example.com"],
      ],
      ["--ca", ["s3", "ls", "--ca", "example-ca-bundle.pem"]],
      ["--ca-b=", ["s3", "ls", "--ca-b=example-ca-bundle.pem"]],
      ["--no-verify", ["s3", "ls", "--no-verify"]],
      ["--no-v", ["s3", "ls", "--no-v"]],
      ["--no-sign", ["s3", "ls", "--no-sign"]],
      ["--no-s", ["s3", "ls", "--no-s"]],
      [
        "--endpoint on sns subscribe, which the CLI reads as --endpoint-url",
        [
          "sns",
          "subscribe",
          "--topic-arn",
          "arn:aws:sns:us-east-1:222222222222:topic",
          "--protocol",
          "https",
          "--endpoint",
          "https://example.com",
        ],
      ],
    ])("rejects %s before assuming any role", async (_label, args) => {
      const result = await executeSandboxCli(
        { ...userInput, args },
        makeServices(),
        env,
      );
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/not permitted/);
      expect(credentialsMock).not.toHaveBeenCalled();
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it.each(
      [...BLOCKED_FLAGS].flatMap((flag) => {
        const shortenedFlag = flag.slice(0, "--".length + 5);
        return [
          [flag, ["s3", "ls", flag]],
          [shortenedFlag, ["s3", "ls", shortenedFlag]],
          [`${flag}=`, ["s3", "ls", `${flag}=https://example.com`]],
          [
            `${shortenedFlag}=`,
            ["s3", "ls", `${shortenedFlag}=https://example.com`],
          ],
        ];
      }),
    )(
      "refuses blocked flag form %s before assuming any role",
      async (_label, args) => {
        const result = await executeSandboxCli(
          { ...userInput, args },
          makeServices(),
          env,
        );
        expect(result.status).toBe("error");
        expect(result.message).toMatch(/not permitted/);
        expect(credentialsMock).not.toHaveBeenCalled();
        expect(execFileMock).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        "export-credentials",
        ["configure", "export-credentials", "--format", "env"],
      ],
      [
        "configure behind a global option",
        ["--region", "us-east-1", "configure", "list"],
      ],
    ])(
      "refuses the configure service (%s) before any lease read, STS call, or CLI run",
      async (_label, args) => {
        const services = makeServices();
        const result = await executeSandboxCli(
          { ...userInput, args },
          services,
          env,
        );
        expect(result.status).toBe("error");
        expect(result.message).toMatch(/configure/);
        expect(services.leaseStore.get).not.toHaveBeenCalled();
        expect(credentialsMock).not.toHaveBeenCalled();
        expect(execFileMock).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["--debug", ["sts", "get-caller-identity", "--debug"]],
      ["--deb", ["s3", "ls", "--deb"]],
      [
        "--debug after the operation's options",
        ["s3", "ls", "s3://bucket", "--recursive", "--debug"],
      ],
      ["--debug before the service", ["--debug", "sts", "get-caller-identity"]],
    ])(
      "refuses %s, which prints the session token, before any lease read, STS call, or CLI run",
      async (_label, args) => {
        const services = makeServices();
        const result = await executeSandboxCli(
          { ...userInput, args },
          services,
          env,
        );
        expect(result.status).toBe("error");
        expect(result.message).toMatch(/not permitted/);
        expect(services.leaseStore.get).not.toHaveBeenCalled();
        expect(credentialsMock).not.toHaveBeenCalled();
        expect(execFileMock).not.toHaveBeenCalled();
      },
    );

    it("allows a legitimate s3:// argument", async () => {
      const result = await executeSandboxCli(
        { ...userInput, args: ["s3", "cp", "s3://bucket/key", "."] },
        makeServices(),
        env,
      );
      expect(result.status).toBe("success");
    });

    it.each([
      ["--endp", ["--endp", "https://example.com", "s3", "ls"]],
      ["--no-verify", ["--no-verify", "s3", "ls"]],
    ])(
      "refuses a leading %s before assuming any role",
      async (_label, args) => {
        const result = await executeSandboxCli(
          { ...userInput, args },
          makeServices(),
          env,
        );
        expect(result.status).toBe("error");
        expect(credentialsMock).not.toHaveBeenCalled();
        expect(execFileMock).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        "--endpoint-arn",
        [
          "sns",
          "get-endpoint-attributes",
          "--endpoint-arn",
          "arn:aws:sns:us-east-1:222222222222:endpoint/GCM/app/endpoint-id",
        ],
      ],
      [
        "--notification-endpoint",
        [
          "sns",
          "subscribe",
          "--topic-arn",
          "arn:aws:sns:us-east-1:222222222222:topic",
          "--protocol",
          "email",
          "--notification-endpoint",
          "a@example.com",
        ],
      ],
      [
        "--expires-in",
        ["s3", "presign", "s3://bucket/key", "--expires-in", "60"],
      ],
      [
        "--ca-certificate-id",
        [
          "iot",
          "list-certificates-by-ca",
          "--ca-certificate-id",
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ],
      ],
      ["--no-dry-run", ["ec2", "describe-subnets", "--no-dry-run"]],
      ["--no-paginate", ["s3api", "list-buckets", "--no-paginate"]],
      [
        "--output and --query",
        ["s3", "ls", "--output", "json", "--query", "x"],
      ],
      ["--color=on", ["s3", "ls", "--color=on"]],
    ])("allows %s, which no blocked flag starts with", async (_label, args) => {
      const result = await executeSandboxCli(
        { ...userInput, args },
        makeServices(),
        env,
      );
      expect(result.status).toBe("success");
      expect(execFileMock).toHaveBeenCalledOnce();
    });
  });

  describe("destructive operation confirmation", () => {
    it("returns a confirmation prompt for destructive operations", async () => {
      const result = await executeSandboxCli(
        { ...userInput, args: ["s3api", "delete-bucket", "--bucket", "b"] },
        makeServices(),
        env,
      );
      expect(result.status).toBe("confirmation_required");
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("executes destructive operations when confirmed", async () => {
      const result = await executeSandboxCli(
        {
          ...userInput,
          args: ["s3api", "delete-bucket", "--bucket", "b"],
          confirmed: true,
        },
        makeServices(),
        env,
      );
      expect(result.status).toBe("success");
    });

    it("executes read operations directly", async () => {
      const result = await executeSandboxCli(userInput, makeServices(), env);
      expect(result.status).toBe("success");
      expect(execFileMock).toHaveBeenCalledOnce();
    });
  });

  describe("RoleSessionName (STS 64-char limit)", () => {
    it("uses the lease uuid, not the oversized leaseId", async () => {
      await executeSandboxCli(userInput, makeServices(), env);

      const sessionName = credentialCall().sessionName;
      expect(sessionName).toBe(LEASE_KEY.uuid);
      expect(sessionName.length).toBeLessThanOrEqual(64);
      // The leaseId itself would have blown the limit.
      expect(LEASE_ID.length).toBeGreaterThan(64);
    });

    it("gives two leases of the same user distinct session names", async () => {
      // A long corporate email pushes the encoded uuid past char 64, so
      // truncating the leaseId WOULD collide — both leases would share one
      // session name and per-lease CloudTrail attribution would be lost.
      const email = "firstname.lastname@some-long-corporate-domain.com";
      const keyA = { userEmail: email, uuid: crypto.randomUUID() };
      const keyB = { userEmail: email, uuid: crypto.randomUUID() };
      const leaseIdA = base64EncodeCompositeKey(keyA)!;
      const leaseIdB = base64EncodeCompositeKey(keyB)!;
      expect(leaseIdA.slice(0, 64)).toBe(leaseIdB.slice(0, 64));

      await executeSandboxCli(
        { ...userInput, leaseId: leaseIdA },
        makeServices({ leaseKey: keyA }),
        env,
      );
      const first = credentialCall().sessionName;

      credentialsMock.mockClear();
      await executeSandboxCli(
        { ...userInput, leaseId: leaseIdB },
        makeServices({ leaseKey: keyB }),
        env,
      );
      const second = credentialCall().sessionName;

      expect(first).not.toBe(second);
      expect(first).toBe(keyA.uuid);
      expect(second).toBe(keyB.uuid);
    });
  });

  describe("credential chain", () => {
    it("sets SourceIdentity for CloudTrail attribution", async () => {
      await executeSandboxCli(userInput, makeServices(), env);

      // The shared utility applies SourceIdentity to hop 1 (the nested
      // masterCredentials) only — it propagates to hop 2 automatically, and
      // setting it there would fail with InvalidParameter.
      expect(credentialCall().sourceIdentity).toBe(userInput.actorId);
    });

    it("attaches a session policy carrying the ISB control-plane deny", async () => {
      await executeSandboxCli(userInput, makeServices(), env);

      const policy = JSON.parse(credentialCall().sessionPolicy!);
      expect(
        policy.Statement.some(
          (s: { Sid?: string }) => s.Sid === "IsbControlPlaneDeny",
        ),
      ).toBe(true);
    });

    it("attaches a session policy carrying the identity/org control-plane deny", async () => {
      // Replaces the removed application-level PROTECTED_SERVICES list. These
      // action-level denies must land in the session policy on every User call
      // — SCPs cover them on the non-exempt SandboxAgentRole, but the session
      // policy should not rely solely on SCPs.
      await executeSandboxCli(userInput, makeServices(), env);

      const policy = JSON.parse(credentialCall().sessionPolicy!);
      const deny = policy.Statement.find(
        (s: { Sid?: string }) => s.Sid === "IdentityAndOrgControlPlaneDeny",
      );
      expect(deny).toBeDefined();
      expect(deny.Effect).toBe("Deny");
      expect(deny.Resource).toBe("*");
      expect(deny.Action).toEqual(
        expect.arrayContaining([
          "organizations:*",
          "sso:*",
          "sso-admin:*",
          "identitystore:*",
          "account:*",
        ]),
      );
    });

    it("refuses User CLI calls when no permissionProfilePolicy is present (fail-closed)", async () => {
      // Security-critical: an unresolved permission set MUST NOT fall back to
      // an unrestricted policy. The worker rejects such turns before invoking
      // the runtime; this check is the last line of defense, and the tool must
      // refuse to assume SandboxAgentRole without a permission set.
      const result = await executeSandboxCli(
        {
          ...userInput,
          permissionProfilePolicy: undefined,
          permissionProfileManagedPolicyArns: undefined,
        },
        makeServices(),
        env,
      );

      expect(result.status).toBe("error");
      expect(result.message).toMatch(/permission profile policy/i);
      expect(result.message).toMatch(/contact your administrator/i);
      expect(credentialsMock).not.toHaveBeenCalled();
    });

    it("accepts a managed-policy-only permission set (no inline policy)", async () => {
      // A permission set that grants access purely via managed policies
      // (e.g., AWS-managed ReadOnlyAccess) is a valid setup. The runtime
      // must accept the invocation and pass those ARNs as PolicyArns on the
      // final AssumeRole so the session inherits the managed permissions.
      // The inline session policy carries only the base deny: STS combines it
      // with PolicyArns where any allow counts, so an allow-all here would
      // nullify the managed policies' restriction.
      await executeSandboxCli(
        {
          ...userInput,
          permissionProfilePolicy: undefined,
          permissionProfileManagedPolicyArns: [
            "arn:aws:iam::aws:policy/ReadOnlyAccess",
          ],
        },
        makeServices(),
        env,
      );

      const call = credentialCall();
      expect(call.policyArns).toEqual([
        "arn:aws:iam::aws:policy/ReadOnlyAccess",
      ]);
      const policy = JSON.parse(call.sessionPolicy!);
      expect(
        policy.Statement.some(
          (s: { Sid?: string }) => s.Sid === "IsbControlPlaneDeny",
        ),
      ).toBe(true);
      expect(
        policy.Statement.every((s: { Effect: string }) => s.Effect === "Deny"),
      ).toBe(true);
    });

    it("forwards managed-policy ARNs alongside an inline session policy", async () => {
      // Mixed permission set: an inline policy plus one or more managed
      // policies. Both must reach STS AssumeRole — inline as Policy, managed
      // as PolicyArns — so effective permissions match the human portal path.
      await executeSandboxCli(
        {
          ...userInput,
          permissionProfilePolicy: {
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" },
            ],
          },
          permissionProfileManagedPolicyArns: [
            "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
            "arn:aws:iam::123456789012:policy/CustomAllow",
          ],
        },
        makeServices(),
        env,
      );

      const call = credentialCall();
      expect(call.policyArns).toEqual([
        "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
        "arn:aws:iam::123456789012:policy/CustomAllow",
      ]);
      const policy = JSON.parse(call.sessionPolicy!);
      expect(
        policy.Statement.some(
          (s: { Action?: string | string[] }) =>
            Array.isArray(s.Action) && s.Action.includes("s3:GetObject"),
        ),
      ).toBe(true);
    });

    it("merges a permission profile into the session policy", async () => {
      await executeSandboxCli(
        {
          ...userInput,
          permissionProfilePolicy: {
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Action: ["s3:*"], Resource: "*" }],
          },
        },
        makeServices(),
        env,
      );

      const policy = JSON.parse(credentialCall().sessionPolicy!);
      expect(
        policy.Statement.some(
          (s: { Action?: string | string[] }) =>
            Array.isArray(s.Action) && s.Action.includes("s3:*"),
        ),
      ).toBe(true);
      // Base deny still applies over the profile's allows.
      expect(
        policy.Statement.some(
          (s: { Sid?: string }) => s.Sid === "IsbControlPlaneDeny",
        ),
      ).toBe(true);
    });

    it("requests credentials fresh on every call (never cached)", async () => {
      await executeSandboxCli(userInput, makeServices(), env);
      await executeSandboxCli(userInput, makeServices(), env);

      // A terminated lease must lose access at the next tool call, so the
      // provider is rebuilt and re-invoked per call rather than reused.
      expect(credentialsMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("execution", () => {
    it("passes credentials as env vars without inheriting process.env", async () => {
      await executeSandboxCli(userInput, makeServices(), env);

      const [cmd, args, options] = execFileMock.mock.calls[0]!;
      expect(cmd).toBe("aws");
      expect(args).toEqual(["s3", "ls"]);
      expect(options.env.AWS_ACCESS_KEY_ID).toBe("AKIA-TEST");
      expect(options.env.AWS_SESSION_TOKEN).toBe("token");
      expect(options.env.AWS_DEFAULT_REGION).toBe("us-east-1");
      // Config/credentials files pinned away so no ambient profile or
      // persisted endpoint override is read.
      expect(options.env.AWS_CONFIG_FILE).toBe("/dev/null");
      expect(options.env.AWS_SHARED_CREDENTIALS_FILE).toBe("/dev/null");
      // No inherited runtime credentials
      expect(Object.keys(options.env).sort()).toEqual([
        "AWS_ACCESS_KEY_ID",
        "AWS_CONFIG_FILE",
        "AWS_DEFAULT_REGION",
        "AWS_REGION",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_SHARED_CREDENTIALS_FILE",
        "PATH",
      ]);
    });

    it("carries the intermediate role's partition into hop 2 and the deny statements", async () => {
      await executeSandboxCli(userInput, makeServices(), {
        ...env,
        INTERMEDIATE_ROLE_ARN:
          "arn:aws-us-gov:iam::111111111111:role/InnovationSandbox-myisb-IntermediateRole",
      });

      const call = credentialCall();
      expect(call.targetRoleArn).toBe(
        `arn:aws-us-gov:iam::${SANDBOX_ACCOUNT}:role/${env.SANDBOX_AGENT_ROLE_NAME}`,
      );
      const deny = JSON.parse(call.sessionPolicy!).Statement.find(
        (s: { Sid?: string }) => s.Sid === "IsbControlPlaneDeny",
      );
      expect(deny.Resource).toContain(
        "arn:aws-us-gov:iam::*:role/aws-reserved/sso.amazonaws.com/*",
      );
      expect(deny.Resource).toContain(
        "arn:aws-us-gov:iam::*:role/InnovationSandbox-*",
      );
    });

    it("returns stderr as data on CLI failure", async () => {
      execFileMock.mockRejectedValue(
        Object.assign(new Error("exit 254"), {
          code: 254,
          stdout: "",
          stderr: "An error occurred (AccessDenied)",
        }),
      );
      const result = await executeSandboxCli(userInput, makeServices(), env);
      expect(result.status).toBe("error");
      expect(result.stderr).toMatch(/AccessDenied/);
    });

    it("reports timeouts distinctly", async () => {
      execFileMock.mockRejectedValue(
        Object.assign(new Error("killed"), { killed: true }),
      );
      const result = await executeSandboxCli(userInput, makeServices(), env);
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/timed out/i);
    });

    it("rejects empty args", async () => {
      const result = await executeSandboxCli(
        { ...userInput, args: [] },
        makeServices(),
        env,
      );
      expect(result.status).toBe("error");
    });
  });
});
