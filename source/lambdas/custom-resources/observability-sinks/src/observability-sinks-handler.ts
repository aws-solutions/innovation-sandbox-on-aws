// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import {
  CreateSinkCommand,
  DeleteSinkCommand,
  GetSinkPolicyCommand,
  ListSinksCommand,
  OAMClient,
  PutSinkPolicyCommand,
} from "@aws-sdk/client-oam";
import {
  ListDelegatedAdministratorsCommand,
  ListParentsCommand,
  OrganizationsClient,
  RegisterDelegatedAdministratorCommand,
} from "@aws-sdk/client-organizations";
import type {
  CdkCustomResourceEvent,
  CdkCustomResourceResponse,
  CloudFormationCustomResourceDeleteEvent,
  Context,
} from "aws-lambda";
import { z } from "zod";

import {
  OBSERVABILITY_SHARED_RESOURCE_TYPES,
  OBSERVABILITY_SINK_NAME,
  OBSERVABILITY_SINK_TAG,
  OBSERVABILITY_SINK_VACANT_POLICY_SID,
  observabilitySinkPolicySid,
  ObservabilitySinksProperties,
  ObservabilitySinksPropertiesSchema,
  SINK_ID_MAPPING_KEY,
  SINK_IDS_JSON_ATTRIBUTE,
  STACKSETS_DELEGATED_ADMIN_SERVICE_PRINCIPAL,
} from "@amzn/innovation-sandbox-commons/data/observability-sink-config/observability-sink-config.js";
import {
  ObservabilitySinksEnvironment,
  ObservabilitySinksEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/observability-sinks-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";

type SinksContext = Context &
  ValidatedEnvironment<ObservabilitySinksEnvironment>;
type SinkTag = ObservabilitySinksProperties["sinkTag"];
type SinkPolicyStatement = Record<string, unknown>;
type SinkPolicyDocument = Record<string, unknown> & {
  Version: string;
  Statement: SinkPolicyStatement[];
};
type SinkMutation =
  | { region: string; sinkArn: string; created: true }
  | {
      region: string;
      sinkArn: string;
      created: false;
      previousPolicy: string | undefined;
    };
/** Remediation appended to the CloudFormation reason, keyed by SDK error name. */
type Hints = Partial<Record<string, string>>;

// A changed value would make CloudFormation replace the resource and send a
// Delete for the old one, removing live sinks.
const PHYSICAL_RESOURCE_ID = "IsbObservabilitySinks";
const POLICY_VERSION = "2012-10-17";
const REGISTRATION_ATTEMPTS = 10;
const REGISTRATION_RETRY_MS = 3_000;
const ORGANIZATIONS_HINTS: Hints = {
  AccessDeniedException:
    "; on an upgrade, redeploy the AccountPool stack before the Compute stack",
};
/**
 * The hub cannot call OAM in the region at all: an opt-in region it has
 * disabled answers UnrecognizedClientException, and one a policy denies
 * answers AccessDeniedException.
 */
const UNREACHABLE_REGION_ERRORS = new Set([
  "UnrecognizedClientException",
  "AccessDeniedException",
]);

const tracer = new Tracer();
const logger = new Logger();

const lambdaHandler = async (
  event: CdkCustomResourceEvent,
  context: SinksContext,
): Promise<CdkCustomResourceResponse> => {
  logger.info({
    message: "Observability sinks custom resource invoked",
    requestType: event.RequestType,
    logicalResourceId: event.LogicalResourceId,
  });
  switch (event.RequestType) {
    case "Create":
    case "Update": {
      return onCreateOrUpdate(event, context);
    }
    case "Delete": {
      return onDelete(event, context);
    }
  }
};

async function onCreateOrUpdate(
  event: CdkCustomResourceEvent,
  context: SinksContext,
): Promise<CdkCustomResourceResponse> {
  const props = parseProperties(event.ResourceProperties, event.ResourceType);
  const oldProps =
    event.RequestType === "Update"
      ? parseProperties(
          event.OldResourceProperties,
          `old ${event.ResourceType}`,
        )
      : undefined;
  const orgsClient = IsbClients.orgs(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );
  if (props.hubAccountId !== props.orgMgtAccountId) {
    await ensureDelegatedAdministrator(orgsClient, props.hubAccountId);
  }
  const sandboxOuPath = await resolveSandboxOuPath(
    orgsClient,
    props.organizationId,
    props.sandboxOuId,
  );

  const currentRegions = sortedRegions(props.managedRegions);
  const currentRegionSet = new Set(currentRegions);
  const sinkIds: Record<string, Record<string, string>> = {};
  const mutations: SinkMutation[] = [];
  try {
    for (const region of currentRegions) {
      const sinkArn = await joinSharedSink(
        region,
        props,
        oldProps?.namespace,
        sandboxOuPath,
        context,
        mutations,
      );
      sinkIds[region] = {
        [SINK_ID_MAPPING_KEY]: sinkArn.slice(sinkArn.lastIndexOf("/") + 1),
      };
    }

    if (oldProps) {
      await leaveDroppedRegions(oldProps, currentRegionSet, context, mutations);
    }
  } catch (error) {
    const notRestored = await restoreMutations(mutations, context);
    if (notRestored > 0) {
      throw new Error(
        `${(error as Error).message}; ${notRestored} regional sink change(s) this request may have made could not be restored, see the function log`,
        { cause: error },
      );
    }
    throw error;
  }
  logger.info({ message: "Observability sinks ready", sinkIds });

  return {
    Data: { [SINK_IDS_JSON_ATTRIBUTE]: JSON.stringify(sinkIds) },
    PhysicalResourceId: PHYSICAL_RESOURCE_ID,
  };
}

/** Puts this namespace's statement on the region's shared sink, creating the sink if absent. */
async function joinSharedSink(
  region: string,
  props: ObservabilitySinksProperties,
  oldNamespace: string | undefined,
  sandboxOuPath: string,
  context: SinksContext,
  mutations: SinkMutation[],
): Promise<string> {
  const oamClient = IsbClients.oam(context.env, region);
  const sink = await findOrCreateSharedSink(oamClient, region, props.sinkTag);
  if (sink.created) {
    mutations.push({ region, sinkArn: sink.sinkArn, created: true });
  }

  const previousPolicy = sink.created
    ? undefined
    : await getSinkPolicy(oamClient, sink.sinkArn, props.sinkTag);
  let policy = parseSinkPolicy(previousPolicy, sink.sinkArn);
  if (oldNamespace !== undefined && oldNamespace !== props.namespace) {
    policy = removeNamespaceStatement(policy, oldNamespace).policy;
  }
  policy = upsertNamespaceStatement(
    policy,
    props.namespace,
    sandboxOuPath,
    props.partition,
  );
  if (!sink.created) {
    // before the put: a failed put may still have been applied
    mutations.push({
      region,
      sinkArn: sink.sinkArn,
      created: false,
      previousPolicy,
    });
  }
  await putSinkPolicy(
    oamClient,
    sink.sinkArn,
    JSON.stringify(policy),
    props.sinkTag,
  );
  return sink.sinkArn;
}

/**
 * CloudFormation does not mark the Update that rolls back a failed region
 * addition, and its old properties list the added region. A dropped region
 * the hub cannot call is therefore skipped rather than failing that rollback.
 */
async function leaveDroppedRegions(
  oldProps: ObservabilitySinksProperties,
  currentRegions: Set<string>,
  context: SinksContext,
  mutations: SinkMutation[],
): Promise<void> {
  const droppedRegions = sortedRegions(oldProps.managedRegions).filter(
    (region) => !currentRegions.has(region),
  );
  for (const region of droppedRegions) {
    await removeNamespaceFromDroppedRegion(
      region,
      oldProps.namespace,
      oldProps.sinkTag,
      context,
      mutations,
    );
  }
}

/** Every OAM call is wrapped, with the SDK error as the cause. */
function isUnreachableRegionError(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error && UNREACHABLE_REGION_ERRORS.has(cause.name);
}

async function removeNamespaceFromDroppedRegion(
  region: string,
  namespace: string,
  tag: SinkTag,
  context: SinksContext,
  mutations: SinkMutation[],
): Promise<void> {
  const oamClient = IsbClients.oam(context.env, region);
  // Only this first call shows whether the hub can call the region at all. A
  // refused policy read or write concerns the sink itself, so it fails the request.
  const sinkArn = await findSink(
    oamClient,
    OBSERVABILITY_SINK_NAME,
    region,
  ).catch((error: unknown) => {
    if (!isUnreachableRegionError(error)) {
      throw error;
    }
    logger.warn({
      message:
        "Skipped a dropped region the hub cannot call; any sink there keeps this namespace's statement",
      region,
      namespace,
      error: error as Error,
    });
    return undefined;
  });
  if (!sinkArn) {
    return;
  }
  const previousPolicy = await getSinkPolicy(oamClient, sinkArn, tag);
  const removal = removeNamespaceStatement(
    parseSinkPolicy(previousPolicy, sinkArn),
    namespace,
  );
  if (!removal.changed) {
    return;
  }
  // The sink stays even when nothing else uses it: this namespace's links stay
  // attached until the link StackSet update that follows this resource, and a
  // rolled-back Update must rejoin the sink whose id the link template holds.
  const vacant = isVacant(removal.policy);
  mutations.push({ region, sinkArn, created: false, previousPolicy });
  await putSinkPolicy(
    oamClient,
    sinkArn,
    JSON.stringify(vacant ? vacantSinkPolicy() : removal.policy),
    tag,
  );
  if (vacant) {
    logger.info({
      message:
        "Left a vacant sink in a dropped region; it can be deleted once no link is attached",
      region,
      sinkArn,
    });
  }
}

/**
 * Leaves each listed region's sink, deleting it once no other statement
 * remains. A statement ISB did not write keeps the sink in place.
 */
async function onDelete(
  event: CloudFormationCustomResourceDeleteEvent,
  context: SinksContext,
): Promise<CdkCustomResourceResponse> {
  const parsed = ObservabilitySinksPropertiesSchema.safeParse(
    event.ResourceProperties,
  );
  if (!parsed.success) {
    // nothing this resource could have created under properties it rejects
    logger.error({
      message: "Skipping sink deletion: properties do not parse",
      issues: z.prettifyError(parsed.error),
    });
    return { PhysicalResourceId: event.PhysicalResourceId };
  }
  for (const region of new Set(parsed.data.managedRegions)) {
    const oamClient = IsbClients.oam(context.env, region);
    const sinkArn = await findSink(oamClient, OBSERVABILITY_SINK_NAME, region);
    if (!sinkArn) {
      continue;
    }
    const currentPolicy = parseSinkPolicy(
      await getSinkPolicy(oamClient, sinkArn, parsed.data.sinkTag),
      sinkArn,
    );
    const removal = removeNamespaceStatement(
      currentPolicy,
      parsed.data.namespace,
    );
    if (isVacant(removal.policy)) {
      await deleteSink(oamClient, sinkArn, region, parsed.data.sinkTag);
    } else if (removal.changed) {
      // a retried Delete finds no statement in the regions it already left
      await putSinkPolicy(
        oamClient,
        sinkArn,
        JSON.stringify(removal.policy),
        parsed.data.sinkTag,
      );
    }
  }
  return { PhysicalResourceId: event.PhysicalResourceId };
}

function parseProperties(
  properties: Record<string, unknown>,
  resourceType: string,
): ObservabilitySinksProperties {
  const parsed = ObservabilitySinksPropertiesSchema.safeParse(properties);
  if (!parsed.success) {
    throw new Error(
      `Invalid ${resourceType} properties: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function sortedRegions(regions: string[]): string[] {
  return [...new Set(regions)].sort((a, b) => a.localeCompare(b));
}

/** Names the failed call in the CloudFormation reason; the raw SDK message rarely does. */
async function calling<T>(
  what: string,
  call: () => Promise<T>,
  hints: Hints = {},
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw wrap(what, error, hints);
  }
}

function wrap(what: string, error: unknown, hints: Hints = {}): Error {
  logger.error({ message: `${what} failed`, error: error as Error });
  const { name, message } = error as Error;
  return new Error(`${what} failed: ${name}: ${message}${hints[name] ?? ""}`, {
    cause: error,
  });
}

/** The role manages only the shared sink carrying this stable ISB tag. */
function tagHints(tag: SinkTag): Hints {
  return {
    AccessDeniedException: `; the sink must carry the tag ${tag.key}=${tag.value}`,
  };
}

/**
 * Only the management account may register a delegated administrator, and a
 * member-account hub needs that standing to create the link StackSet.
 */
async function ensureDelegatedAdministrator(
  orgsClient: OrganizationsClient,
  hubAccountId: string,
): Promise<void> {
  if (await isDelegatedAdministrator(orgsClient, hubAccountId)) {
    return;
  }
  logger.info({
    message: "Registering the hub as StackSets delegated administrator",
    hubAccountId,
  });
  try {
    await orgsClient.send(
      new RegisterDelegatedAdministratorCommand({
        AccountId: hubAccountId,
        ServicePrincipal: STACKSETS_DELEGATED_ADMIN_SERVICE_PRINCIPAL,
      }),
    );
  } catch (error) {
    if ((error as Error).name !== "AccountAlreadyRegisteredException") {
      throw wrap("RegisterDelegatedAdministrator", error, {
        AccessDeniedException:
          "; StackSets trusted access must be enabled in AWS Organizations",
      });
    }
  }
  for (let attempt = 0; attempt < REGISTRATION_ATTEMPTS; attempt++) {
    if (await isDelegatedAdministrator(orgsClient, hubAccountId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, REGISTRATION_RETRY_MS));
  }
  const waited = (REGISTRATION_ATTEMPTS * REGISTRATION_RETRY_MS) / 1000;
  throw new Error(
    `Hub ${hubAccountId} is not listed as a StackSets delegated administrator ${waited}s after registration; redeploy once ListDelegatedAdministrators shows it`,
  );
}

async function isDelegatedAdministrator(
  orgsClient: OrganizationsClient,
  hubAccountId: string,
): Promise<boolean> {
  let nextToken: string | undefined;
  do {
    const page = await calling(
      "ListDelegatedAdministrators",
      () =>
        orgsClient.send(
          new ListDelegatedAdministratorsCommand({
            ServicePrincipal: STACKSETS_DELEGATED_ADMIN_SERVICE_PRINCIPAL,
            NextToken: nextToken,
          }),
        ),
      ORGANIZATIONS_HINTS,
    );
    if (page.DelegatedAdministrators?.some((a) => a.Id === hubAccountId)) {
      return true;
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return false;
}

/**
 * o-.../r-.../ou-.../ou-pool/*: every OU from the root down to the pool, then
 * a wildcard for its children.
 */
async function resolveSandboxOuPath(
  orgsClient: OrganizationsClient,
  organizationId: string,
  sandboxOuId: string,
): Promise<string> {
  const ouIds = [sandboxOuId];
  const seen = new Set(ouIds);
  let childId = sandboxOuId;
  let rootId: string | undefined;
  while (rootId === undefined) {
    const { Parents } = await calling(
      `ListParents(${childId})`,
      () => orgsClient.send(new ListParentsCommand({ ChildId: childId })),
      ORGANIZATIONS_HINTS,
    );
    const parent = Parents?.[0];
    if (!parent?.Id) {
      throw new Error(`ListParents returned no parent for ${childId}`);
    }
    if (parent.Type === "ROOT") {
      rootId = parent.Id;
    } else {
      if (seen.has(parent.Id)) {
        throw new Error(
          `ListParents returned a cyclic parent chain at ${parent.Id}`,
        );
      }
      seen.add(parent.Id);
      ouIds.unshift(parent.Id);
      childId = parent.Id;
    }
  }
  const sandboxOuPath = [organizationId, rootId, ...ouIds, "*"].join("/");
  logger.info({ message: "Resolved sandbox OU path", sandboxOuPath });
  return sandboxOuPath;
}

function namespaceStatement(
  namespace: string,
  sandboxOuPath: string,
  partition: string,
): SinkPolicyStatement {
  return {
    Sid: observabilitySinkPolicySid(namespace),
    Effect: "Allow",
    Principal: "*",
    Action: ["oam:CreateLink", "oam:UpdateLink"],
    Resource: "*",
    Condition: {
      "ForAnyValue:StringLike": {
        "aws:PrincipalOrgPaths": [sandboxOuPath],
      },
      ArnLike: {
        "aws:PrincipalArn": `arn:${partition}:iam::*:role/stacksets-exec-*`,
      },
      // ForAllValues is true for an absent key, so the key is required too
      "ForAllValues:StringEquals": {
        "oam:ResourceTypes": OBSERVABILITY_SHARED_RESOURCE_TYPES,
      },
      Null: { "oam:ResourceTypes": "false" },
    },
  };
}

function emptySinkPolicy(): SinkPolicyDocument {
  return { Version: POLICY_VERSION, Statement: [] };
}

/** What an unused sink holds: OAM refuses a policy without statements. */
function vacantSinkPolicy(): SinkPolicyDocument {
  return {
    Version: POLICY_VERSION,
    Statement: [
      {
        Sid: OBSERVABILITY_SINK_VACANT_POLICY_SID,
        Effect: "Deny",
        Principal: "*",
        Action: ["oam:CreateLink", "oam:UpdateLink"],
        Resource: "*",
      },
    ],
  };
}

function parseSinkPolicy(
  serialized: string | undefined,
  sinkArn: string,
): SinkPolicyDocument {
  if (!serialized) {
    return emptySinkPolicy();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`GetSinkPolicy ${sinkArn} returned invalid JSON`, {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new Error(`GetSinkPolicy ${sinkArn} returned a non-object policy`);
  }
  const rawStatements = parsed.Statement;
  let statements: unknown[] = [];
  if (Array.isArray(rawStatements)) {
    statements = rawStatements;
  } else if (rawStatements !== undefined) {
    statements = [rawStatements];
  }
  if (!statements.every(isRecord)) {
    throw new Error(
      `GetSinkPolicy ${sinkArn} returned a policy with a non-object statement`,
    );
  }
  return {
    ...parsed,
    Version:
      typeof parsed.Version === "string" ? parsed.Version : POLICY_VERSION,
    Statement: statements,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Replaces the namespace's statement where it stands, or appends one, and
 * drops the vacancy placeholder, whose Deny would refuse the namespace's links.
 */
function upsertNamespaceStatement(
  policy: SinkPolicyDocument,
  namespace: string,
  sandboxOuPath: string,
  partition: string,
): SinkPolicyDocument {
  const sid = observabilitySinkPolicySid(namespace);
  const replacement = namespaceStatement(namespace, sandboxOuPath, partition);
  const statements = policy.Statement.filter(
    (statement) => statement.Sid !== OBSERVABILITY_SINK_VACANT_POLICY_SID,
  );
  const index = statements.findIndex((statement) => statement.Sid === sid);
  if (index === -1) {
    statements.push(replacement);
  } else {
    statements[index] = replacement;
  }
  return { ...policy, Statement: statements };
}

function removeNamespaceStatement(
  policy: SinkPolicyDocument,
  namespace: string,
): { policy: SinkPolicyDocument; changed: boolean } {
  const sid = observabilitySinkPolicySid(namespace);
  const statements = policy.Statement.filter(
    (statement) => statement.Sid !== sid,
  );
  return {
    policy: { ...policy, Statement: statements },
    changed: statements.length !== policy.Statement.length,
  };
}

/** Nothing but the placeholder: no namespace or other statement uses the sink. */
function isVacant(policy: SinkPolicyDocument): boolean {
  return policy.Statement.every(
    (statement) => statement.Sid === OBSERVABILITY_SINK_VACANT_POLICY_SID,
  );
}

async function listSinks(oamClient: OAMClient, region: string) {
  const sinks: Array<{ Name?: string; Arn?: string }> = [];
  let nextToken: string | undefined;
  do {
    const page = await calling(`ListSinks in ${region}`, () =>
      oamClient.send(new ListSinksCommand({ NextToken: nextToken })),
    );
    sinks.push(...(page.Items ?? []));
    nextToken = page.NextToken;
  } while (nextToken);
  return sinks;
}

async function findSink(
  oamClient: OAMClient,
  name: string,
  region: string,
): Promise<string | undefined> {
  const sinks = await listSinks(oamClient, region);
  return sinks.find((sink) => sink.Name === name)?.Arn;
}

/**
 * Joins the region's shared sink, creating it if absent. IAM enforces
 * ownership of an existing sink: the role reads and writes only sinks carrying
 * the shared tag, so an untagged sink of this name fails with the tag hint.
 */
async function findOrCreateSharedSink(
  oamClient: OAMClient,
  region: string,
  tag: SinkTag,
): Promise<{ sinkArn: string; created: boolean }> {
  const existing = await findSink(oamClient, OBSERVABILITY_SINK_NAME, region);
  if (existing) {
    return { sinkArn: existing, created: false };
  }
  return createSink(oamClient, OBSERVABILITY_SINK_NAME, region, tag);
}

/** An absent policy reads as a sink without statements. */
async function getSinkPolicy(
  oamClient: OAMClient,
  sinkArn: string,
  tag: SinkTag,
): Promise<string | undefined> {
  const response = await oamClient
    .send(new GetSinkPolicyCommand({ SinkIdentifier: sinkArn }))
    .catch((error: unknown) => {
      // OAM answers this way for a sink that has no policy yet
      if ((error as Error).name === "ResourceNotFoundException") {
        return undefined;
      }
      throw wrap(`GetSinkPolicy ${sinkArn}`, error, tagHints(tag));
    });
  return response?.Policy;
}

async function putSinkPolicy(
  oamClient: OAMClient,
  sinkArn: string,
  policy: string,
  tag: SinkTag,
): Promise<void> {
  await calling(
    `PutSinkPolicy ${sinkArn}`,
    () =>
      oamClient.send(
        new PutSinkPolicyCommand({
          SinkIdentifier: sinkArn,
          Policy: policy,
        }),
      ),
    tagHints(tag),
  );
}

async function createSink(
  oamClient: OAMClient,
  name: string,
  region: string,
  tag: SinkTag,
): Promise<{ sinkArn: string; created: boolean }> {
  let response;
  try {
    response = await oamClient.send(
      new CreateSinkCommand({ Name: name, Tags: { [tag.key]: tag.value } }),
    );
  } catch (error) {
    if ((error as Error).name !== "ServiceQuotaExceededException") {
      throw wrap(`CreateSink in ${region}`, error);
    }
    // An account holds one sink per region. A shared sink left by a racing
    // create is adopted; anything else remains customer-owned.
    const sinks = await listSinks(oamClient, region);
    const ours = sinks.find((sink) => sink.Name === name)?.Arn;
    if (ours) {
      return { sinkArn: ours, created: false };
    }
    if (sinks.length === 0) {
      throw new Error(
        `${region} reports its sink quota as reached but lists no sink; retry the deployment`,
        { cause: error },
      );
    }
    const others = sinks.map((sink) => sink.Arn).join(", ");
    throw new Error(
      `${region} already holds a sink that is not ${name} (${others}); an account holds one sink per region`,
      { cause: error },
    );
  }
  if (!response.Arn) {
    throw new Error(`CreateSink in ${region} returned no ARN`);
  }
  logger.info({ message: "Created observability sink", sinkArn: response.Arn });
  return { sinkArn: response.Arn, created: true };
}

async function deleteSink(
  oamClient: OAMClient,
  sinkArn: string,
  region: string,
  tag: SinkTag,
) {
  try {
    await oamClient.send(new DeleteSinkCommand({ Identifier: sinkArn }));
  } catch (error) {
    if ((error as Error).name === "ResourceNotFoundException") {
      logger.info({ message: "Observability sink already gone", sinkArn });
      return;
    }
    throw wrap(`DeleteSink ${sinkArn}`, error, {
      ...tagHints(tag),
      ConflictException: `; links are still attached: list them with aws oam list-attached-links --sink-identifier ${sinkArn} --region ${region}, delete them in their source accounts, then retry`,
    });
  }
  logger.info({ message: "Deleted observability sink", sinkArn });
}

/** Best effort; returns how many regional mutations could not be restored. */
async function restoreMutations(
  mutations: SinkMutation[],
  context: SinksContext,
): Promise<number> {
  let notRestored = 0;
  for (const mutation of [...mutations].reverse()) {
    try {
      const oamClient = IsbClients.oam(context.env, mutation.region);
      if (mutation.created) {
        await deleteSink(
          oamClient,
          mutation.sinkArn,
          mutation.region,
          OBSERVABILITY_SINK_TAG,
        );
      } else {
        await oamClient.send(
          new PutSinkPolicyCommand({
            SinkIdentifier: mutation.sinkArn,
            // a joined sink that had no policy cannot get one back
            Policy:
              mutation.previousPolicy ?? JSON.stringify(vacantSinkPolicy()),
          }),
        );
      }
    } catch (error) {
      notRestored++;
      logger.warn({
        message: "Regional sink change could not be restored",
        sinkArn: mutation.sinkArn,
        error: error as Error,
      });
    }
  }
  return notRestored;
}

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: ObservabilitySinksEnvironmentSchema,
  moduleName: "observability-sinks",
}).handler(lambdaHandler);
