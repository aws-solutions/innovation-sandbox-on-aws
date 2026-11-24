// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  buildSessionPermissions,
  hasPermissions,
  PermissionProfile,
} from "@amzn/innovation-sandbox-agent-runtime/session-policy.js";
import { base64DecodeCompositeKey } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import { PolicyDocument } from "@amzn/innovation-sandbox-commons/isb-services/permission-policy/index.js";
import {
  fromTemporaryIsbSpokeCredentials,
  parsePartitionFromArn,
  sandboxAgentRoleArn,
} from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import {
  isActiveLease,
  LeaseKeySchema,
} from "@amzn/innovation-sandbox-shared/types/lease.js";

const execFileAsync = promisify(execFile);

const CLI_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

/**
 * Destructive verbs that trigger a confirmation prompt. UX only — real
 * enforcement is IAM + SCPs + the session policy.
 */
const DESTRUCTIVE_PATTERN =
  /^(delete|terminate|remove|destroy|rb|rm|deregister|disable)\b|^stop-/;

/**
 * Global AWS CLI options that consume the following argument as their value.
 * Needed to skip past them when locating the service: `aws --region
 * us-east-1 iam list-users` puts the service at index 2, not 0.
 *
 * @see https://docs.aws.amazon.com/cli/latest/reference/#options
 */
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "--ca-bundle",
  "--cli-binary-format",
  "--cli-connect-timeout",
  "--cli-read-timeout",
  "--color",
  "--endpoint-url",
  "--output",
  "--profile",
  "--query",
  "--region",
]);

/**
 * Global AWS CLI options that take no value.
 *
 * Listing these — rather than treating every unknown option as valueless —
 * is what lets the parser fail closed. Either list can go stale when AWS
 * adds an option, but the failure modes differ sharply: assuming an unknown
 * option is boolean skips only that token, so `aws --new-opt value configure
 * list` would leave the parser looking at "value", and the `configure`
 * refusal and the destructive-operation prompt would miss the real service
 * and operation — a silent bypass. Refusing unknown options turns a stale
 * list into a clear, fixable error instead.
 */
const GLOBAL_BOOLEAN_OPTIONS = new Set([
  "--cli-auto-prompt",
  "--debug",
  "--no-cli-auto-prompt",
  "--no-cli-pager",
  "--no-paginate",
  "--no-sign-request",
  "--no-verify-ssl",
  "--version",
]);

/**
 * Locates the service and operation, skipping any leading global options.
 *
 * Positional parsing (`args[0]` / `args[1]`) is bypassable: a leading
 * `--region us-east-1` shifts the service out of index 0, which would skip both
 * the `configure` refusal and the destructive-operation prompt. Options
 * are consumed by name so an option's *value* can never be mistaken for the
 * service; an unrecognized option is refused rather than guessed at.
 */
function findServiceAndOperation(
  args: string[],
):
  | { ok: true; service: string; operation?: string }
  | { ok: false; error: string } {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      break;
    }
    if (arg.includes("=")) {
      // `--flag=value` carries its value inline, whatever the flag is.
      i += 1;
    } else if (GLOBAL_BOOLEAN_OPTIONS.has(arg)) {
      i += 1;
    } else if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      i += 2;
    } else {
      const supported = [
        ...GLOBAL_OPTIONS_WITH_VALUE,
        ...GLOBAL_BOOLEAN_OPTIONS,
      ].sort((a, b) => a.localeCompare(b));
      return {
        ok: false,
        error:
          `Unrecognized global option '${arg}'. Place operation-specific ` +
          `options after the service and operation. Supported global ` +
          `options: ${supported.join(", ")}.`,
      };
    }
  }

  const service = args[i];
  return service
    ? { ok: true, service, operation: args[i + 1] }
    : { ok: false, error: "No AWS service specified in the command." };
}

/**
 * CLI flags that redirect the request off AWS, disable TLS verification, or
 * strip SigV4. IAM cannot adjudicate a request that never reaches it or
 * arrives unsigned, so these bypass the otherwise-terminal IAM boundary and
 * must be blocked here. `--debug` prints the session token to stderr.
 */
export const BLOCKED_FLAGS: ReadonlySet<string> = new Set([
  "--endpoint-url",
  "--ca-bundle",
  "--no-verify-ssl",
  "--no-sign-request",
  "--debug",
]);

/** Rejects local file reads from the runtime container into CLI input. */
const FILE_REFERENCE_PATTERN = /^fileb?:\/\//;

/**
 * STS `RoleSessionName` accepts 2-64 chars from `[\w+=,.@-]`. Validated
 * locally because a violation otherwise surfaces as an opaque
 * `ValidationException` from AWS. The common trap: the full leaseId is
 * base64url({userEmail, uuid}) and always exceeds 64 chars — pass the
 * lease uuid instead.
 */
const ROLE_SESSION_NAME_PATTERN = /^[\w+=,.@-]{2,64}$/;

function assertValidRoleSessionName(sessionName: string): void {
  if (!ROLE_SESSION_NAME_PATTERN.test(sessionName)) {
    throw new Error(
      `Invalid RoleSessionName (${sessionName.length} chars): must be 2-64 ` +
        String.raw`characters matching [\w+=,.@-]. The full leaseId is too long — ` +
        `pass the lease uuid instead.`,
    );
  }
}

// The AWS CLI reads a prefix of a global option as that option; it rejects ambiguous prefixes itself.
function isBlockedFlag(flag: string): boolean {
  return (
    flag.length > "--".length &&
    [...BLOCKED_FLAGS].some((blockedFlag) => blockedFlag.startsWith(flag))
  );
}

/**
 * Returns the offending arg if any redirects the request off-AWS or reads
 * a local file, else undefined. Handles both `--flag value` and
 * `--flag=value` forms — including a file reference in the value of an
 * inline `--flag=value` (e.g. `--cli-input-json=file:///etc/passwd`), which
 * a start-anchored test against the whole arg would miss.
 */
function findBlockedArg(args: string[]): string | undefined {
  return args.find((arg) => {
    const [flag, ...rest] = arg.split("=");
    if (isBlockedFlag(flag!)) {
      return true;
    }
    // Rejoin in case the value itself contains '='.
    const value = rest.join("=");
    return (
      FILE_REFERENCE_PATTERN.test(arg) || FILE_REFERENCE_PATTERN.test(value)
    );
  });
}

export interface ExecuteSandboxCliServices {
  leaseStore: LeaseStore;
}

export interface ExecuteSandboxCliEnv {
  INTERMEDIATE_ROLE_ARN: string;
  SANDBOX_AGENT_ROLE_NAME: string;
  HUB_ACCOUNT_ID: string;
  USER_AGENT_EXTRA: string;
}

export interface ExecuteSandboxCliInput {
  /** CLI arguments EXCLUDING the leading "aws", e.g. ["s3", "ls"]. */
  args: string[];
  /** Target account for the command. */
  accountId: string;
  region: string;
  actorId: string;
  leaseId?: string;
  /** True when the user already confirmed a destructive operation. */
  confirmed?: boolean;
  permissionProfilePolicy?: PolicyDocument;
  permissionProfileManagedPolicyArns?: string[];
}

export interface ExecuteSandboxCliResult {
  status: "success" | "error" | "confirmation_required";
  stdout?: string;
  stderr?: string;
  message?: string;
}

/**
 * Executes an AWS CLI command in a sandbox account on behalf of the agent.
 *
 * Validation pipeline, in order:
 *  1. args shape, `configure` refusal, and off-AWS/file-read arg check
 *  2. lease status: must be Active — re-read from DDB on EVERY call, which
 *     closes the credential revocation race during multi-tool turns
 *  3. accountId: must match the lease's account; the hub account is always rejected
 *  4. destructive-operation confirmation prompt (UX only)
 *  5. fresh 2-hop STS (SourceIdentity on hop 1) → execFile with creds as
 *     env vars — no shell, no credential files on disk
 */
export async function executeSandboxCli(
  input: ExecuteSandboxCliInput,
  services: ExecuteSandboxCliServices,
  env: ExecuteSandboxCliEnv,
): Promise<ExecuteSandboxCliResult> {
  const { args, accountId, region, confirmed } = input;

  if (args.length === 0) {
    return { status: "error", message: "No CLI arguments provided." };
  }

  const parsed = findServiceAndOperation(args);
  if (!parsed.ok) {
    return { status: "error", message: parsed.error };
  }
  const { service, operation } = parsed;

  // `configure` reads and writes the CLI's local config and can print the
  // credentials the command runs with (`configure export-credentials`).
  if (service === "configure") {
    return {
      status: "error",
      message: "The 'configure' command is not available in the sandbox CLI.",
    };
  }

  const blockedArg = findBlockedArg(args);
  if (blockedArg) {
    return {
      status: "error",
      message: `The argument '${blockedArg}' is not permitted in sandbox CLI commands.`,
    };
  }

  if (accountId === env.HUB_ACCOUNT_ID) {
    return {
      status: "error",
      message: "The ISB hub account cannot be targeted.",
    };
  }

  const resolved = await resolveSessionName(input, services);
  if (resolved.error) {
    return resolved.error;
  }
  const { sessionName } = resolved;

  if (operation && DESTRUCTIVE_PATTERN.test(operation) && !confirmed) {
    return {
      status: "confirmation_required",
      message: `This will run a destructive operation (aws ${service} ${operation}) in account ${accountId}. Confirm to proceed.`,
    };
  }

  assertValidRoleSessionName(sessionName);

  // Derived from the intermediate role ARN so it matches hop 1: cross-partition
  // AssumeRole is impossible, and a mismatch would silently disable the ISB
  // control-plane deny in GovCloud/China.
  let partition: string;
  try {
    partition = parsePartitionFromArn(env.INTERMEDIATE_ROLE_ARN);
  } catch {
    return {
      status: "error",
      message: "Deployment is misconfigured: intermediate role ARN is invalid.",
    };
  }
  const profile: PermissionProfile = {
    inlinePolicy: input.permissionProfilePolicy,
    managedPolicyArns: input.permissionProfileManagedPolicyArns ?? [],
  };
  if (!hasPermissions(profile)) {
    return {
      status: "error",
      message:
        "Cannot execute CLI commands: no permission profile policy is available for this session. Contact your administrator.",
    };
  }

  const credentials = await assumeSandboxCredentials(
    input,
    profile,
    env,
    partition,
    sessionName,
  );

  try {
    const { stdout, stderr } = await execFileAsync("aws", args, {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: {
        // Minimal env: deliberately NOT inheriting process.env, so the
        // runtime's own role credentials can never leak into the CLI call.
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        AWS_ACCESS_KEY_ID: credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        AWS_SESSION_TOKEN: credentials.sessionToken,
        AWS_DEFAULT_REGION: region,
        AWS_REGION: region,
        // Pin config/credentials files to /dev/null so a prior
        // `aws configure set endpoint_url ...` (persisted to ~/.aws across
        // execFile calls) cannot redirect this call off-AWS, and no ambient
        // profile is read. Complements the --endpoint-url arg block.
        AWS_CONFIG_FILE: "/dev/null",
        AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
      },
    });
    return { status: "success", stdout, stderr };
  } catch (error) {
    return toCliErrorResult(error);
  }
}

/**
 * Resolves the STS session name the call runs under, or an error result when
 * the caller does not hold an Active lease on the account.
 */
async function resolveSessionName(
  input: ExecuteSandboxCliInput,
  services: ExecuteSandboxCliServices,
): Promise<
  { error: ExecuteSandboxCliResult } | { error?: never; sessionName: string }
> {
  const { accountId, leaseId } = input;

  if (!leaseId) {
    return {
      error: { status: "error", message: "An Active lease is required." },
    };
  }

  const leaseValidation = await validateUserLease(
    leaseId,
    accountId,
    services.leaseStore,
  );
  if (leaseValidation.error) {
    return { error: leaseValidation.error };
  }
  return { sessionName: leaseValidation.leaseUuid };
}

/**
 * Fresh credentials per call, never cached: a terminated lease loses access at
 * the next tool call.
 *
 * A User assumes SandboxAgentRole-{namespace} with the permission set policy as
 * session policy, for parity with the human portal path: effective permissions
 * = SandboxAgentRole(*:*) ∩ session policy (permission set) ∩ SCPs.
 */
function assumeSandboxCredentials(
  input: ExecuteSandboxCliInput,
  profile: PermissionProfile,
  env: ExecuteSandboxCliEnv,
  partition: string,
  sessionName: string,
) {
  const { policy, policyArns } = buildSessionPermissions(profile, {
    partition,
  });

  return fromTemporaryIsbSpokeCredentials({
    intermediateRoleArn: env.INTERMEDIATE_ROLE_ARN,
    targetRoleArn: sandboxAgentRoleArn(
      partition,
      input.accountId,
      env.SANDBOX_AGENT_ROLE_NAME,
    ),
    sessionName,
    intermediateSessionName: sessionName,
    sourceIdentity: input.actorId,
    sessionPolicy: JSON.stringify(policy),
    ...(policyArns ? { policyArns } : {}),
    customUserAgent: env.USER_AGENT_EXTRA,
  })();
}

/** Returns an error result if the lease is invalid, undefined when valid. */
async function validateUserLease(
  leaseId: string,
  accountId: string,
  leaseStore: LeaseStore,
): Promise<
  { error: ExecuteSandboxCliResult } | { error?: never; leaseUuid: string }
> {
  let leaseKey;
  try {
    leaseKey = LeaseKeySchema.parse(base64DecodeCompositeKey(leaseId));
  } catch {
    return { error: { status: "error", message: "Invalid lease identifier." } };
  }

  const lease = await leaseStore.get(leaseKey);
  if (!lease.result) {
    return { error: { status: "error", message: "Lease not found." } };
  }
  if (!isActiveLease(lease.result)) {
    return {
      error: {
        status: "error",
        message: `Lease is ${lease.result.status} — CLI access requires an Active lease.`,
      },
    };
  }
  if (lease.result.awsAccountId !== accountId) {
    return {
      error: {
        status: "error",
        message: "Account does not match the selected lease.",
      },
    };
  }
  return { leaseUuid: leaseKey.uuid };
}

function toCliErrorResult(error: unknown): ExecuteSandboxCliResult {
  const execError = error as {
    stdout?: string;
    stderr?: string;
    killed?: boolean;
    code?: number | string;
    message?: string;
  };
  if (execError.killed) {
    return {
      status: "error",
      message: `Command timed out after ${CLI_TIMEOUT_MS / 1000}s.`,
      stdout: execError.stdout,
      stderr: execError.stderr,
    };
  }
  return {
    status: "error",
    // CLI failures (non-zero exit) are data for the agent to reason about,
    // not exceptions: stderr carries the AWS error message.
    message: `Command exited with code ${execError.code ?? "unknown"}.`,
    stdout: execError.stdout,
    stderr: execError.stderr ?? execError.message,
  };
}
