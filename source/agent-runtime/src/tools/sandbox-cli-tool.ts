// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { tool, type ToolResultBlock } from "@strands-agents/sdk";
import { z } from "zod";

import {
  TOOL_RESULT_STATUSES,
  type ToolOutputNotes,
  type ToolResultStatus,
} from "@amzn/innovation-sandbox-agent-runtime/tool-output-guardrail.js";
import {
  executeSandboxCli,
  ExecuteSandboxCliEnv,
  ExecuteSandboxCliServices,
} from "@amzn/innovation-sandbox-agent-runtime/tools/execute-sandbox-cli.js";
import { PolicyDocument } from "@amzn/innovation-sandbox-commons/isb-services/permission-policy/index.js";

/**
 * Caller identity and scope for a single agent invocation. Supplied by the
 * Worker Lambda in the invoke payload and closed over when the tool is
 * built — NEVER part of the model-facing input schema.
 *
 * This split is the security boundary for the CLI tool: the model chooses
 * which command to run, but it cannot choose who it runs as or which lease
 * authorizes it. A prompt injection that emits `{"actorId": "someone-else"}`
 * has nowhere to land, because those fields are not parameters the model
 * can address.
 */
export interface SandboxCliToolContext {
  /** Sanitized actorId — becomes CloudTrail sourceIdentity. */
  actorId: string;
  leaseId: string;
  /**
   * The lease's account. Pinned from the trusted invoke payload — the model
   * cannot redirect to another account.
   */
  accountId: string;
  /**
   * Regions ISB manages, from the `isbManagedRegions` deployment parameter.
   * The model sees the full list in its system prompt and is expected to name
   * one otherwise.
   */
  regions: string[];
  permissionProfilePolicy?: PolicyDocument;
  /**
   * Managed-policy ARNs from the permission set. Passed as `PolicyArns` on
   * the final `sts:AssumeRole`.
   */
  permissionProfileManagedPolicyArns?: string[];
}

/**
 * The region to use when the model did not name one. Only safe when the
 * deployment manages exactly one region: the managed list is unordered, so
 * picking an element from a longer list would run the command somewhere the
 * user did not choose.
 */
function resolveRegion(regions: string[]): string | undefined {
  return regions.length === 1 ? regions[0] : undefined;
}

const REGION_OPTION = "--region";

/** The AWS CLI reads any prefix of a global option, from `--r`, as that option. */
function isRegionOption(token: string): boolean {
  return token.length >= "--r".length && REGION_OPTION.startsWith(token);
}

const REGION_MESSAGES = {
  missingValue: "Add a region name after --region.",
  moreThanOne: (regions: string[]) =>
    `The command names more than one region: ${regions.join(" and ")}. ` +
    "Specify the region once.",
  settingConflict: (setting: string, named: string) =>
    `The region setting is ${setting}, but the command names ${named}. ` +
    "Specify the region once.",
  required: (managed: string[]) =>
    `Specify which region to run in. This deployment manages: ${managed.join(", ")}.`,
  unmanaged: (region: string, managed: string[]) =>
    `This deployment doesn't manage region ${region}. ` +
    `Specify one of the managed regions: ${managed.join(", ")}.`,
  noneManaged: "No managed region is configured for this deployment.",
};

type RegionOptionResult =
  { ok: true; region?: string; args: string[] } | { ok: false; error: string };

type CommandRegionResult =
  { ok: true; region: string; args: string[] } | { ok: false; error: string };

function expandRegionOption(arg: string): string[] {
  const separatorIndex = arg.indexOf("=");
  return separatorIndex > 0 && isRegionOption(arg.slice(0, separatorIndex))
    ? [REGION_OPTION, arg.slice(separatorIndex + 1)]
    : [arg];
}

/** An args region would override the validated region in the CLI env vars. */
function splitRegionOption(args: string[]): RegionOptionResult {
  const tokens = args.flatMap(expandRegionOption);
  const optionIndexes = tokens.flatMap((token, index) =>
    isRegionOption(token) ? [index] : [],
  );
  const namedRegions = optionIndexes.map((index) => tokens[index + 1] ?? "");
  if (namedRegions.some((value) => value === "" || value.startsWith("-"))) {
    return { ok: false, error: REGION_MESSAGES.missingValue };
  }
  const distinctRegions = [...new Set(namedRegions)];
  if (distinctRegions.length > 1) {
    return { ok: false, error: REGION_MESSAGES.moreThanOne(distinctRegions) };
  }
  const regionTokenIndexes = new Set(
    optionIndexes.flatMap((index) => [index, index + 1]),
  );
  return {
    ok: true,
    region: distinctRegions[0],
    args: tokens.filter((_, index) => !regionTokenIndexes.has(index)),
  };
}

function findCommandRegion(
  input: { args: string[]; region?: string },
  managedRegions: string[],
): CommandRegionResult {
  const regionOption = splitRegionOption(input.args);
  if (!regionOption.ok) {
    return regionOption;
  }
  if (
    input.region &&
    regionOption.region &&
    input.region !== regionOption.region
  ) {
    return {
      ok: false,
      error: REGION_MESSAGES.settingConflict(input.region, regionOption.region),
    };
  }
  // With no managed regions the field accepts any region, so args do too.
  if (
    regionOption.region &&
    managedRegions.length > 0 &&
    !managedRegions.includes(regionOption.region)
  ) {
    return {
      ok: false,
      error: REGION_MESSAGES.unmanaged(regionOption.region, managedRegions),
    };
  }
  const region =
    input.region ?? regionOption.region ?? resolveRegion(managedRegions);
  if (!region) {
    return {
      ok: false,
      error:
        managedRegions.length === 0
          ? REGION_MESSAGES.noneManaged
          : REGION_MESSAGES.required(managedRegions),
    };
  }
  return { ok: true, region, args: regionOption.args };
}

/**
 * Builds the `execute_sandbox_cli` Strands tool for one invocation.
 *
 * The returned tool carries `context` in its closure, so per-call model
 * input can never override identity or lease. The target account
 * is always taken from the lease in context — the model cannot redirect to
 * another account.
 */
export function buildSandboxCliTool(
  context: SandboxCliToolContext,
  services: ExecuteSandboxCliServices,
  env: ExecuteSandboxCliEnv,
) {
  // Model-facing input schema. Deliberately minimal: every field here is
  // something the model is allowed to decide. Identity and lease scope are
  // absent by design — see SandboxCliToolContext. Built inside the closure
  // so `region` can be narrowed to `z.enum(context.regions)`.
  const sandboxCliInputSchema = z.object({
    args: z
      .array(z.string())
      .min(1)
      .describe(
        "AWS CLI arguments WITHOUT the leading 'aws', e.g. ['s3', 'ls'] or " +
          "['ec2', 'describe-instances', '--max-items', '10']. Always include " +
          "--output json unless the user asked for another format.",
      ),
    region: (context.regions.length > 0
      ? z.enum(context.regions as [string, ...string[]]).optional()
      : z.string().optional()
    ).describe(
      "Specify the region here or with `--region` in the command arguments. " +
        "When the deployment manages one region, it is used when neither is provided.",
    ),
    confirmed: z
      .boolean()
      .optional()
      .describe(
        "Set true ONLY after the user has explicitly approved a destructive " +
          "operation that previously returned confirmation_required.",
      ),
  });
  return tool({
    name: "execute_sandbox_cli",
    description:
      "Execute an AWS CLI command inside the sandbox account. Use this for " +
      "inspecting and managing AWS resources. Commands run with the " +
      "caller's own identity and are recorded in CloudTrail. Destructive " +
      "operations return confirmation_required first — relay that to the " +
      "user and only retry with confirmed=true after they agree.",
    inputSchema: sandboxCliInputSchema,
    callback: async (input) => {
      const commandRegion = findCommandRegion(input, context.regions);
      if (!commandRegion.ok) {
        return { status: "error", message: commandRegion.error };
      }

      return executeSandboxCli(
        {
          args: commandRegion.args,
          accountId: context.accountId,
          region: commandRegion.region,
          confirmed: input.confirmed,
          // Identity and scope come from the invocation context only.
          actorId: context.actorId,
          leaseId: context.leaseId,
          permissionProfilePolicy: context.permissionProfilePolicy,
          permissionProfileManagedPolicyArns:
            context.permissionProfileManagedPolicyArns,
        },
        services,
        env,
      );
    },
  });
}

const CLI_STATUSES: ReadonlySet<string> = new Set(TOOL_RESULT_STATUSES);

/** A command that ran may already have changed resources, so re-run only read-only commands. */
export const SANDBOX_CLI_OUTPUT_NOTES: ToolOutputNotes = {
  resultStatus: commandStatus,
  screeningFailed: (status) =>
    `The command returned status "${status}", but its output can't be shown because the safety check that reviews command output failed to run. ` +
    "This is a problem with the check, not with the command or the user's account. " +
    "Do not run the command again: it may already have created or changed resources. " +
    `Tell the user the command returned "${status}" and that you can't see its output, ` +
    "and ask whether they want you to check the outcome with a read-only command.",
  outputBlocked: (status) =>
    `The command returned status "${status}", but its output was withheld by the content safety guardrail. ` +
    "Do not run the command again: it may already have created or changed resources. " +
    `Tell the user the command returned "${status}" and that its output was withheld, ` +
    "and ask whether they want you to check the outcome with a read-only command.",
  narrowCut:
    "If the command only reads data, such as a list or describe command, run it again with --query, --max-items, or a filter to see the rest. " +
    "Don't run a command that changes resources again; tell the user the output was cut instead.",
};

/** Only known statuses, so no tool output reaches the note unscreened. */
function commandStatus(result: ToolResultBlock): ToolResultStatus {
  for (const block of result.content) {
    if (block.type !== "jsonBlock") continue;
    const status = (block.json as { status?: unknown } | null)?.status;
    if (typeof status === "string" && isCliStatus(status)) return status;
  }
  return result.status;
}

function isCliStatus(status: string): status is ToolResultStatus {
  return CLI_STATUSES.has(status);
}
