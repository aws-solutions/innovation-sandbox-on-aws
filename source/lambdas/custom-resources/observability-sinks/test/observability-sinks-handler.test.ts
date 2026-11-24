// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  CreateSinkCommand,
  DeleteSinkCommand,
  GetSinkPolicyCommand,
  ListSinksCommand,
  OAMClient,
  PutSinkPolicyCommand,
  type PutSinkPolicyCommandInput,
} from "@aws-sdk/client-oam";
import {
  ListDelegatedAdministratorsCommand,
  ListParentsCommand,
  OrganizationsClient,
  RegisterDelegatedAdministratorCommand,
} from "@aws-sdk/client-organizations";
import type { CdkCustomResourceEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OBSERVABILITY_SINK_NAME,
  OBSERVABILITY_SINK_TAG,
  OBSERVABILITY_SINK_VACANT_POLICY_SID,
  OBSERVABILITY_SINKS_RESOURCE_TYPE,
  observabilitySinkPolicySid,
  SINK_IDS_JSON_ATTRIBUTE,
  STACKSETS_DELEGATED_ADMIN_SERVICE_PRINCIPAL,
} from "@amzn/innovation-sandbox-commons/data/observability-sink-config/observability-sink-config.js";
import { ObservabilitySinksEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/observability-sinks-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { handler } from "@amzn/innovation-sandbox-observability-sinks/observability-sinks-handler.js";

const orgsMock = mockClient(OrganizationsClient);
const oamMock = mockClient(OAMClient);

const HUB_ACCOUNT_ID = "111111111111";
const ORG_MGT_ACCOUNT_ID = "222222222222";
const testEnv = {
  ...generateSchemaData(ObservabilitySinksEnvironmentSchema),
  INTERMEDIATE_ROLE_ARN: `arn:aws:iam::${HUB_ACCOUNT_ID}:role/InnovationSandbox-myisb-IntermediateRole`,
  ORG_MGT_ROLE_ARN: `arn:aws:iam::${ORG_MGT_ACCOUNT_ID}:role/InnovationSandbox-myisb-OrgMgtRole`,
};

const ORG_ID = "o-a1b2c3d4e5";
const ROOT_ID = "r-ab12";
const PARENT_OU_ID = "ou-ab12-parent01";
const POOL_OU_ID = "ou-ab12-pool0001";
const SECOND_POOL_OU_ID = "ou-ab12-pool0002";
const SINK_NAME = OBSERVABILITY_SINK_NAME;
const SINK_TAG = OBSERVABILITY_SINK_TAG;
const TAG_HINT = `; the sink must carry the tag ${SINK_TAG.key}=${SINK_TAG.value}`;
const PHYSICAL_ID = "IsbObservabilitySinks";
const ORG_HINT =
  "; on an upgrade, redeploy the AccountPool stack before the Compute stack";
const SINK_IDS: Record<string, string> = {
  "eu-west-1": "c3e1b2a4-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
  "us-east-1": "7a4da91f-c9c2-4ceb-b947-5067a87177e2",
  "us-west-2": "21f0da65-6294-4441-b1fc-9c30ddceed76",
};
// spelled out, so a change to the placeholder a sink keeps breaks these tests
const VACANT_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "InnovationSandboxNoMembers",
      Effect: "Deny",
      Principal: "*",
      Action: ["oam:CreateLink", "oam:UpdateLink"],
      Resource: "*",
    },
  ],
});
const OPERATOR_STATEMENT = {
  Sid: "OperatorStatement",
  Effect: "Allow",
  Principal: { AWS: ["333333333333"] },
  Action: ["oam:CreateLink", "oam:UpdateLink"],
  Resource: "*",
};
const DISABLED_REGION_ERROR = [
  "UnrecognizedClientException",
  "The security token included in the request is invalid",
] as const;

const baseProperties = {
  namespace: "myisb",
  organizationId: ORG_ID,
  sandboxOuId: POOL_OU_ID,
  managedRegions: ["us-west-2", "us-east-1"],
  hubAccountId: HUB_ACCOUNT_ID,
  orgMgtAccountId: HUB_ACCOUNT_ID,
  partition: "aws",
  sinkTag: SINK_TAG,
  solutionVersion: "v1",
};

const sinkIdsJson = (...regions: string[]) =>
  JSON.stringify(
    Object.fromEntries(regions.map((r) => [r, { Id: SINK_IDS[r] }])),
  );

function sinkArn(region: string, account = HUB_ACCOUNT_ID) {
  return `arn:aws:oam:${region}:${account}:sink/${SINK_IDS[region]}`;
}

function policyStatement(
  namespace: string,
  poolOuId = POOL_OU_ID,
  partition = "aws",
) {
  return {
    Sid: observabilitySinkPolicySid(namespace),
    Effect: "Allow",
    Principal: "*",
    Action: ["oam:CreateLink", "oam:UpdateLink"],
    Resource: "*",
    Condition: {
      "ForAnyValue:StringLike": {
        "aws:PrincipalOrgPaths": [
          `${ORG_ID}/${ROOT_ID}/${PARENT_OU_ID}/${poolOuId}/*`,
        ],
      },
      ArnLike: {
        "aws:PrincipalArn": `arn:${partition}:iam::*:role/stacksets-exec-*`,
      },
      "ForAllValues:StringEquals": {
        "oam:ResourceTypes": ["AWS::CloudWatch::Metric"],
      },
      Null: { "oam:ResourceTypes": "false" },
    },
  };
}

function policyFor(
  ...members: Array<{ namespace: string; poolOuId?: string }>
) {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: members.map(({ namespace, poolOuId }) =>
      policyStatement(namespace, poolOuId),
    ),
  });
}

function createEvent(
  properties: Record<string, unknown>,
  requestType: "Create" | "Update" | "Delete" = "Create",
  oldProperties: Record<string, unknown> = properties,
): CdkCustomResourceEvent {
  return {
    RequestType: requestType,
    ServiceToken: "service-token",
    ResponseURL: "https://example.com/response",
    StackId: "arn:aws:cloudformation:us-east-1:111111111111:stack/test/uuid",
    RequestId: "request-id",
    LogicalResourceId: "TestResource",
    ResourceType: OBSERVABILITY_SINKS_RESOURCE_TYPE,
    PhysicalResourceId: requestType === "Create" ? undefined : PHYSICAL_ID,
    ResourceProperties: { ServiceToken: "service-token", ...properties },
    ...(requestType === "Update"
      ? {
          OldResourceProperties: {
            ServiceToken: "service-token",
            ...oldProperties,
          },
        }
      : {}),
  } as CdkCustomResourceEvent;
}

function awsError(name: string, message = name) {
  return Object.assign(new Error(message), { name });
}

// The handler builds one OAM client per region, so region-specific answers
// come from the client the command was sent through.
function perRegion<T, I = unknown>(answer: (region: string, input: I) => T) {
  return async (input: I, getClient: () => OAMClient) =>
    answer(await getClient().config.region(), input);
}

function failureOf(request: Promise<unknown>): Promise<string> {
  return request.then(
    () => "resolved",
    (error: Error) => error.message,
  );
}

/**
 * Keeps each region's sink the way OAM does, so a test can run several
 * requests, from several namespaces, against one account. The policy and
 * unreachable-region errors are the ones a real hub account returned.
 */
function statefulOam({ unreachable = [] as string[] } = {}) {
  const sinks = new Map<string, { policy?: string; links: number }>();
  const unreachableRegions = new Set(unreachable);
  const reach = (region: string) => {
    if (unreachableRegions.has(region)) {
      throw awsError(...DISABLED_REGION_ERROR);
    }
    return sinks.get(region);
  };
  const existing = (region: string) => {
    const sink = reach(region);
    if (!sink) {
      throw awsError("ResourceNotFoundException", "Resource not found.");
    }
    return sink;
  };
  oamMock
    .on(ListSinksCommand)
    .callsFake(
      perRegion((region) =>
        reach(region) ? isbSinkIn(region) : { Items: [] },
      ),
    );
  oamMock.on(CreateSinkCommand).callsFake(
    perRegion((region) => {
      if (reach(region)) {
        throw awsError("ServiceQuotaExceededException", "max(1)");
      }
      sinks.set(region, { links: 0 });
      return { Arn: sinkArn(region) };
    }),
  );
  oamMock.on(GetSinkPolicyCommand).callsFake(
    perRegion((region) => {
      const { policy } = existing(region);
      if (policy === undefined) {
        throw awsError("ResourceNotFoundException", "Resource not found.");
      }
      return { Policy: policy };
    }),
  );
  oamMock.on(PutSinkPolicyCommand).callsFake(
    perRegion((region, input: PutSinkPolicyCommandInput) => {
      const sink = existing(region);
      const sids = (
        JSON.parse(input.Policy!) as { Statement: Array<{ Sid?: string }> }
      ).Statement.map((statement) => statement.Sid);
      if (sids.length === 0 || new Set(sids).size !== sids.length) {
        throw awsError("InvalidParameterException", "Policy validation failed");
      }
      sink.policy = input.Policy;
      return {};
    }),
  );
  oamMock.on(DeleteSinkCommand).callsFake(
    perRegion((region) => {
      if (existing(region).links > 0) {
        throw awsError("ConflictException", "Sink has attached links");
      }
      sinks.delete(region);
      return {};
    }),
  );
  return sinks;
}

const statementsIn = (policy: string | undefined) =>
  (JSON.parse(policy!) as { Statement: unknown[] }).Statement;

const isbSinkIn = (region: string) => ({
  Items: [{ Name: SINK_NAME, Arn: sinkArn(region) }],
});

// creates fail in us-west-2 only; us-east-1 succeeds
const westCreateFails = perRegion((region) => {
  if (region === "us-west-2") {
    throw awsError("AccessDeniedException", "not allowed");
  }
  return { Arn: sinkArn(region) };
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  orgsMock.reset();
  oamMock.reset();
  orgsMock.on(ListParentsCommand, { ChildId: POOL_OU_ID }).resolves({
    Parents: [{ Id: PARENT_OU_ID, Type: "ORGANIZATIONAL_UNIT" }],
  });
  orgsMock.on(ListParentsCommand, { ChildId: SECOND_POOL_OU_ID }).resolves({
    Parents: [{ Id: PARENT_OU_ID, Type: "ORGANIZATIONAL_UNIT" }],
  });
  orgsMock
    .on(ListParentsCommand, { ChildId: PARENT_OU_ID })
    .resolves({ Parents: [{ Id: ROOT_ID, Type: "ROOT" }] });
  oamMock.on(ListSinksCommand).resolves({ Items: [] });
  oamMock
    .on(CreateSinkCommand)
    .callsFake(perRegion((region) => ({ Arn: sinkArn(region) })));
  oamMock.on(GetSinkPolicyCommand).resolves({
    Policy: policyFor({ namespace: baseProperties.namespace }),
  });
  oamMock.on(PutSinkPolicyCommand).resolves({});
  oamMock.on(DeleteSinkCommand).resolves({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Custom::ObservabilitySinks create", () => {
  it("creates a tagged sink per managed region, sorted, with the OU-path policy", async () => {
    const result = await handler(
      createEvent(baseProperties),
      mockContext(testEnv),
    );

    expect(oamMock.commandCalls(CreateSinkCommand)).toHaveLength(2);
    expect(oamMock.commandCalls(CreateSinkCommand)[0]!.args[0].input).toEqual({
      Name: SINK_NAME,
      Tags: { [SINK_TAG.key]: SINK_TAG.value },
    });
    const policies = oamMock
      .commandCalls(PutSinkPolicyCommand)
      .map((call) => call.args[0].input);
    expect(policies.map((p) => p.SinkIdentifier)).toEqual([
      sinkArn("us-east-1"),
      sinkArn("us-west-2"),
    ]);
    expect(JSON.parse(policies[0]!.Policy!)).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: observabilitySinkPolicySid(baseProperties.namespace),
          Effect: "Allow",
          Principal: "*",
          Action: ["oam:CreateLink", "oam:UpdateLink"],
          Resource: "*",
          Condition: {
            "ForAnyValue:StringLike": {
              "aws:PrincipalOrgPaths": [
                `${ORG_ID}/${ROOT_ID}/${PARENT_OU_ID}/${POOL_OU_ID}/*`,
              ],
            },
            ArnLike: {
              "aws:PrincipalArn": "arn:aws:iam::*:role/stacksets-exec-*",
            },
            "ForAllValues:StringEquals": {
              "oam:ResourceTypes": ["AWS::CloudWatch::Metric"],
            },
            Null: { "oam:ResourceTypes": "false" },
          },
        },
      ],
    });

    expect(result.PhysicalResourceId).toBe(PHYSICAL_ID);
    expect(result.Data).toEqual({
      [SINK_IDS_JSON_ATTRIBUTE]: sinkIdsJson("us-east-1", "us-west-2"),
    });
    // the hub is the management account: nothing to register
    expect(orgsMock.commandCalls(ListDelegatedAdministratorsCommand)).toEqual(
      [],
    );
    expect(
      orgsMock.commandCalls(RegisterDelegatedAdministratorCommand),
    ).toEqual([]);
  });

  it("writes the partition into the execution-role condition", async () => {
    await handler(
      createEvent({
        ...baseProperties,
        managedRegions: ["us-east-1"],
        partition: "aws-us-gov",
      }),
      mockContext(testEnv),
    );

    const policy = JSON.parse(
      oamMock.commandCalls(PutSinkPolicyCommand)[0]!.args[0].input.Policy!,
    );
    expect(policy.Statement[0].Condition.ArnLike).toEqual({
      "aws:PrincipalArn": "arn:aws-us-gov:iam::*:role/stacksets-exec-*",
    });
  });

  it("builds the path for a pool OU that sits directly under the root", async () => {
    orgsMock
      .on(ListParentsCommand, { ChildId: POOL_OU_ID })
      .resolves({ Parents: [{ Id: ROOT_ID, Type: "ROOT" }] });

    await handler(
      createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
      mockContext(testEnv),
    );

    const policy = JSON.parse(
      oamMock.commandCalls(PutSinkPolicyCommand)[0]!.args[0].input.Policy!,
    );
    expect(policy.Statement[0].Condition["ForAnyValue:StringLike"]).toEqual({
      "aws:PrincipalOrgPaths": [`${ORG_ID}/${ROOT_ID}/${POOL_OU_ID}/*`],
    });
  });

  it("adopts a sink that already carries the ISB name instead of creating one", async () => {
    oamMock.on(ListSinksCommand).callsFake(
      perRegion((region) => ({
        Items:
          region === "us-east-1"
            ? [
                { Name: "customer-sink", Arn: sinkArn(region, "333333333333") },
                { Name: SINK_NAME, Arn: sinkArn(region) },
              ]
            : [],
      })),
    );

    const result = await handler(
      createEvent(baseProperties),
      mockContext(testEnv),
    );

    expect(oamMock.commandCalls(CreateSinkCommand)).toHaveLength(1);
    expect(oamMock.commandCalls(PutSinkPolicyCommand)).toHaveLength(2);
    expect(result.Data![SINK_IDS_JSON_ATTRIBUTE]).toBe(
      sinkIdsJson("us-east-1", "us-west-2"),
    );
  });

  it("adds a second namespace without replacing the first namespace policy", async () => {
    oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
    oamMock.on(GetSinkPolicyCommand).resolves({
      Policy: policyFor({ namespace: baseProperties.namespace }),
    });

    const result = await handler(
      createEvent({
        ...baseProperties,
        namespace: "second",
        sandboxOuId: SECOND_POOL_OU_ID,
        managedRegions: ["us-east-1"],
      }),
      mockContext(testEnv),
    );

    expect(oamMock.commandCalls(CreateSinkCommand)).toHaveLength(0);
    const policy = JSON.parse(
      oamMock.commandCalls(PutSinkPolicyCommand)[0]!.args[0].input.Policy!,
    );
    expect(policy.Statement).toEqual([
      policyStatement(baseProperties.namespace),
      policyStatement("second", SECOND_POOL_OU_ID),
    ]);
    expect(result.Data![SINK_IDS_JSON_ATTRIBUTE]).toBe(
      sinkIdsJson("us-east-1"),
    );
  });

  it("leaves a shared-name sink without the shared tag untouched", async () => {
    // IAM scopes GetSinkPolicy to the shared tag, so an untagged sink is refused there
    oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
    oamMock
      .on(GetSinkPolicyCommand)
      .rejects(awsError("AccessDeniedException", "not authorized"));

    await expect(
      handler(
        createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
        mockContext(testEnv),
      ),
    ).rejects.toThrow(
      `GetSinkPolicy ${sinkArn("us-east-1")} failed: AccessDeniedException: not authorized${TAG_HINT}`,
    );
    expect(oamMock.commandCalls(CreateSinkCommand)).toHaveLength(0);
    expect(oamMock.commandCalls(PutSinkPolicyCommand)).toHaveLength(0);
    expect(oamMock.commandCalls(DeleteSinkCommand)).toHaveLength(0);
  });

  it("keeps statements it does not own and accepts a single-statement policy", async () => {
    const unmanaged = {
      Sid: "OperatorStatement",
      Effect: "Allow",
      Principal: { AWS: ["333333333333"] },
      Action: ["oam:CreateLink", "oam:UpdateLink"],
      Resource: "*",
    };
    oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
    oamMock.on(GetSinkPolicyCommand).resolves({
      Policy: JSON.stringify({ Version: "2012-10-17", Statement: unmanaged }),
    });

    await handler(
      createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
      mockContext(testEnv),
    );

    const policy = JSON.parse(
      oamMock.commandCalls(PutSinkPolicyCommand)[0]!.args[0].input.Policy!,
    );
    expect(policy.Statement).toEqual([
      unmanaged,
      policyStatement(baseProperties.namespace),
    ]);
  });

  it("joins a sink that has no policy yet", async () => {
    // OAM answers GetSinkPolicy this way for a sink without a policy
    oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
    oamMock
      .on(GetSinkPolicyCommand)
      .rejects(awsError("ResourceNotFoundException", "Resource not found."));

    await handler(
      createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
      mockContext(testEnv),
    );

    expect(
      oamMock.commandCalls(PutSinkPolicyCommand)[0]!.args[0].input.Policy,
    ).toBe(policyFor({ namespace: baseProperties.namespace }));
  });

  it("replaces the placeholder of a vacant sink it joins", async () => {
    oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
    oamMock.on(GetSinkPolicyCommand).resolves({ Policy: VACANT_POLICY });

    await handler(
      createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
      mockContext(testEnv),
    );

    expect(
      oamMock.commandCalls(PutSinkPolicyCommand)[0]!.args[0].input.Policy,
    ).toBe(policyFor({ namespace: baseProperties.namespace }));
  });

  it("joins a sink whose policy names neither a version nor a statement", async () => {
    oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
    oamMock.on(GetSinkPolicyCommand).resolves({ Policy: "{}" });

    await handler(
      createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
      mockContext(testEnv),
    );

    expect(
      oamMock.commandCalls(PutSinkPolicyCommand)[0]!.args[0].input.Policy,
    ).toBe(policyFor({ namespace: baseProperties.namespace }));
  });

  it.each([
    { what: "not JSON", policy: "{", reason: "returned invalid JSON" },
    {
      what: "a JSON list",
      policy: "[]",
      reason: "returned a non-object policy",
    },
    {
      what: "JSON null",
      policy: "null",
      reason: "returned a non-object policy",
    },
    {
      what: "a JSON string",
      policy: JSON.stringify("policy"),
      reason: "returned a non-object policy",
    },
    {
      what: "a policy with a string statement",
      policy: JSON.stringify({ Statement: ["oam:CreateLink"] }),
      reason: "returned a policy with a non-object statement",
    },
  ])(
    "fails without a write when GetSinkPolicy returns $what",
    async ({ policy, reason }) => {
      oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
      oamMock.on(GetSinkPolicyCommand).resolves({ Policy: policy });

      await expect(
        handler(
          createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
          mockContext(testEnv),
        ),
      ).rejects.toThrow(`GetSinkPolicy ${sinkArn("us-east-1")} ${reason}`);
      expect(oamMock.commandCalls(PutSinkPolicyCommand)).toHaveLength(0);
    },
  );

  it("names the tag when an adopted sink cannot be re-policied", async () => {
    oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
    oamMock
      .on(PutSinkPolicyCommand)
      .rejects(awsError("AccessDeniedException", "not authorized"));

    await expect(
      handler(
        createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
        mockContext(testEnv),
      ),
    ).rejects.toThrow(
      `PutSinkPolicy ${sinkArn("us-east-1")} failed: AccessDeniedException: not authorized${TAG_HINT}`,
    );
  });

  it("follows ListSinks pagination before deciding to create", async () => {
    oamMock
      .on(ListSinksCommand)
      .resolvesOnce({
        Items: [
          { Name: "other", Arn: "arn:aws:oam:us-east-1:111111111111:sink/x" },
        ],
        NextToken: "page-2",
      })
      .resolvesOnce(isbSinkIn("us-east-1"));

    await handler(
      createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
      mockContext(testEnv),
    );

    expect(oamMock.commandCalls(ListSinksCommand)).toHaveLength(2);
    expect(oamMock.commandCalls(ListSinksCommand)[1]!.args[0].input).toEqual({
      NextToken: "page-2",
    });
    expect(oamMock.commandCalls(CreateSinkCommand)).toHaveLength(0);
  });

  it("collapses a region listed twice", async () => {
    const result = await handler(
      createEvent({
        ...baseProperties,
        managedRegions: ["us-east-1", "us-east-1"],
      }),
      mockContext(testEnv),
    );

    expect(oamMock.commandCalls(ListSinksCommand)).toHaveLength(1);
    expect(oamMock.commandCalls(CreateSinkCommand)).toHaveLength(1);
    expect(result.Data![SINK_IDS_JSON_ATTRIBUTE]).toBe(
      sinkIdsJson("us-east-1"),
    );
  });

  it("names the foreign sink when the region's one slot is taken", async () => {
    const foreign = sinkArn("us-east-1", "333333333333");
    oamMock
      .on(ListSinksCommand)
      .resolves({ Items: [{ Name: "customer-sink", Arn: foreign }] });
    oamMock
      .on(CreateSinkCommand)
      .rejects(awsError("ServiceQuotaExceededException", "max(1)"));

    await expect(
      handler(
        createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
        mockContext(testEnv),
      ),
    ).rejects.toThrow(
      `us-east-1 already holds a sink that is not ${SINK_NAME} (${foreign}); an account holds one sink per region`,
    );
  });

  it("asks for a retry when the quota is reported but no sink is listed", async () => {
    oamMock
      .on(CreateSinkCommand)
      .rejects(awsError("ServiceQuotaExceededException", "max(1)"));

    await expect(
      handler(
        createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
        mockContext(testEnv),
      ),
    ).rejects.toThrow(
      "us-east-1 reports its sink quota as reached but lists no sink; retry the deployment",
    );
  });

  it("adopts the sink a racing create left behind instead of failing on the quota", async () => {
    oamMock
      .on(ListSinksCommand)
      .resolvesOnce({ Items: [] })
      .resolves(isbSinkIn("us-east-1"));
    oamMock
      .on(CreateSinkCommand)
      .rejects(awsError("ServiceQuotaExceededException", "max(1)"));

    const result = await handler(
      createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
      mockContext(testEnv),
    );

    expect(result.Data![SINK_IDS_JSON_ATTRIBUTE]).toBe(
      sinkIdsJson("us-east-1"),
    );
    expect(oamMock.commandCalls(PutSinkPolicyCommand)).toHaveLength(1);
  });

  it("does not remove a sink adopted through the quota race when a later region fails", async () => {
    // us-east-1's ListSinks is empty on the first call only, then lists ours
    oamMock
      .on(ListSinksCommand)
      .resolvesOnce({ Items: [] })
      .callsFake(
        perRegion((region) =>
          region === "us-east-1" ? isbSinkIn(region) : { Items: [] },
        ),
      );
    oamMock.on(CreateSinkCommand).callsFake(
      perRegion((region) => {
        if (region === "us-east-1") {
          throw awsError("ServiceQuotaExceededException", "max(1)");
        }
        throw awsError("AccessDeniedException", "not allowed");
      }),
    );

    await expect(
      handler(createEvent(baseProperties), mockContext(testEnv)),
    ).rejects.toThrow("CreateSink in us-west-2 failed");
    expect(oamMock.commandCalls(DeleteSinkCommand)).toEqual([]);
  });

  it("names the failing call, region included, for other create errors", async () => {
    oamMock
      .on(CreateSinkCommand)
      .rejects(awsError("AccessDeniedException", "not allowed"));

    await expect(
      handler(
        createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
        mockContext(testEnv),
      ),
    ).rejects.toThrow(
      "CreateSink in us-east-1 failed: AccessDeniedException: not allowed",
    );
  });

  it("rejects a create that returns no ARN", async () => {
    oamMock.on(CreateSinkCommand).resolves({});

    await expect(
      handler(
        createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
        mockContext(testEnv),
      ),
    ).rejects.toThrow("CreateSink in us-east-1 returned no ARN");
  });

  it("removes the sinks it created when a later region fails, since no Delete follows a failed Create", async () => {
    oamMock.on(CreateSinkCommand).callsFake(westCreateFails);

    await expect(
      handler(createEvent(baseProperties), mockContext(testEnv)),
    ).rejects.toThrow(
      "CreateSink in us-west-2 failed: AccessDeniedException: not allowed",
    );

    expect(
      oamMock.commandCalls(DeleteSinkCommand).map((d) => d.args[0].input),
    ).toEqual([{ Identifier: sinkArn("us-east-1") }]);
  });

  it("never removes a sink it only adopted, and restores its previous policy", async () => {
    const othersOnly = policyFor({
      namespace: "second",
      poolOuId: SECOND_POOL_OU_ID,
    });
    oamMock
      .on(ListSinksCommand)
      .callsFake(
        perRegion((region) =>
          region === "us-east-1" ? isbSinkIn(region) : { Items: [] },
        ),
      );
    oamMock.on(GetSinkPolicyCommand).resolves({ Policy: othersOnly });
    oamMock.on(CreateSinkCommand).callsFake(westCreateFails);

    await expect(
      handler(createEvent(baseProperties), mockContext(testEnv)),
    ).rejects.toThrow("CreateSink in us-west-2 failed");

    expect(oamMock.commandCalls(DeleteSinkCommand)).toEqual([]);
    const puts = oamMock
      .commandCalls(PutSinkPolicyCommand)
      .map((call) => call.args[0].input);
    expect(puts).toHaveLength(2);
    expect(puts[1]).toEqual({
      SinkIdentifier: sinkArn("us-east-1"),
      Policy: othersOnly,
    });
  });

  it("restores the policy of a sink it joined when its own put fails", async () => {
    // a failed put may still have been applied
    const othersOnly = policyFor({
      namespace: "second",
      poolOuId: SECOND_POOL_OU_ID,
    });
    oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
    oamMock.on(GetSinkPolicyCommand).resolves({ Policy: othersOnly });
    oamMock
      .on(PutSinkPolicyCommand)
      .rejectsOnce(awsError("InternalServiceFault", "try later"))
      .resolves({});

    expect(
      await failureOf(
        handler(
          createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
          mockContext(testEnv),
        ),
      ),
    ).toBe(
      `PutSinkPolicy ${sinkArn("us-east-1")} failed: InternalServiceFault: try later`,
    );
    expect(
      oamMock.commandCalls(PutSinkPolicyCommand)[1]!.args[0].input,
    ).toEqual({ SinkIdentifier: sinkArn("us-east-1"), Policy: othersOnly });
  });

  it("puts the placeholder on a policy-less sink it joined when a later region fails", async () => {
    // OAM refuses a policy without statements, so the absent policy cannot return
    oamMock
      .on(ListSinksCommand)
      .callsFake(
        perRegion((region) =>
          region === "us-east-1" ? isbSinkIn(region) : { Items: [] },
        ),
      );
    oamMock
      .on(GetSinkPolicyCommand)
      .rejects(awsError("ResourceNotFoundException", "Resource not found."));
    oamMock.on(CreateSinkCommand).callsFake(westCreateFails);

    await expect(
      handler(createEvent(baseProperties), mockContext(testEnv)),
    ).rejects.toThrow("CreateSink in us-west-2 failed");

    expect(
      oamMock.commandCalls(PutSinkPolicyCommand).map((c) => c.args[0].input),
    ).toEqual([
      {
        SinkIdentifier: sinkArn("us-east-1"),
        Policy: policyFor({ namespace: baseProperties.namespace }),
      },
      { SinkIdentifier: sinkArn("us-east-1"), Policy: VACANT_POLICY },
    ]);
  });

  it("removes a created sink whose policy could not be put", async () => {
    oamMock
      .on(PutSinkPolicyCommand)
      .rejects(awsError("InternalServiceFault", "try later"));

    await expect(
      handler(
        createEvent({ ...baseProperties, managedRegions: ["us-east-1"] }),
        mockContext(testEnv),
      ),
    ).rejects.toThrow(
      `PutSinkPolicy ${sinkArn("us-east-1")} failed: InternalServiceFault: try later`,
    );
    expect(
      oamMock.commandCalls(DeleteSinkCommand).map((d) => d.args[0].input),
    ).toEqual([{ Identifier: sinkArn("us-east-1") }]);
  });

  it("reports the original failure and the sinks left behind when the cleanup fails", async () => {
    oamMock.on(CreateSinkCommand).callsFake(westCreateFails);
    oamMock
      .on(DeleteSinkCommand)
      .rejects(awsError("InternalServiceFault", "try later"));

    await expect(
      handler(createEvent(baseProperties), mockContext(testEnv)),
    ).rejects.toThrow(
      "CreateSink in us-west-2 failed: AccessDeniedException: not allowed; 1 regional sink change(s) this request may have made could not be restored, see the function log",
    );
  });

  it("fails when the OU tree cannot be walked to the root", async () => {
    orgsMock
      .on(ListParentsCommand, { ChildId: PARENT_OU_ID })
      .resolves({ Parents: [] });

    await expect(
      handler(createEvent(baseProperties), mockContext(testEnv)),
    ).rejects.toThrow(`ListParents returned no parent for ${PARENT_OU_ID}`);
    expect(oamMock.commandCalls(CreateSinkCommand)).toHaveLength(0);
  });

  it("fails fast when the parent chain never reaches the root", async () => {
    orgsMock
      .on(ListParentsCommand, { ChildId: PARENT_OU_ID })
      .resolves({ Parents: [{ Id: POOL_OU_ID, Type: "ORGANIZATIONAL_UNIT" }] });

    await expect(
      handler(createEvent(baseProperties), mockContext(testEnv)),
    ).rejects.toThrow(
      `ListParents returned a cyclic parent chain at ${POOL_OU_ID}`,
    );
    expect(orgsMock.commandCalls(ListParentsCommand)).toHaveLength(2);
    expect(oamMock.commandCalls(CreateSinkCommand)).toHaveLength(0);
  });

  it("points at the AccountPool stack only when an Organizations read is denied", async () => {
    orgsMock
      .on(ListParentsCommand, { ChildId: POOL_OU_ID })
      .rejects(awsError("AccessDeniedException", "not authorized"));
    await expect(
      handler(createEvent(baseProperties), mockContext(testEnv)),
    ).rejects.toThrow(
      `ListParents(${POOL_OU_ID}) failed: AccessDeniedException: not authorized${ORG_HINT}`,
    );

    orgsMock
      .on(ListParentsCommand, { ChildId: POOL_OU_ID })
      .rejects(awsError("TooManyRequestsException", "slow down"));
    await expect(
      handler(createEvent(baseProperties), mockContext(testEnv)),
    ).rejects.toThrow(
      `ListParents(${POOL_OU_ID}) failed: TooManyRequestsException: slow down`,
    );
  });

  it("rejects malformed properties before calling anything", async () => {
    await expect(
      handler(
        createEvent({ ...baseProperties, managedRegions: [] }),
        mockContext(testEnv),
      ),
    ).rejects.toThrow(
      `Invalid ${OBSERVABILITY_SINKS_RESOURCE_TYPE} properties`,
    );
    expect(orgsMock.calls()).toHaveLength(0);
    expect(oamMock.calls()).toHaveLength(0);
  });
});

describe("Custom::ObservabilitySinks update", () => {
  it("re-puts the policy on the existing sinks and keeps the physical id", async () => {
    oamMock.on(ListSinksCommand).callsFake(perRegion(isbSinkIn));

    const result = await handler(
      createEvent(baseProperties, "Update"),
      mockContext(testEnv),
    );

    expect(oamMock.commandCalls(CreateSinkCommand)).toHaveLength(0);
    expect(oamMock.commandCalls(PutSinkPolicyCommand)).toHaveLength(2);
    // re-running replaces its own statement rather than adding a second one
    for (const call of oamMock.commandCalls(PutSinkPolicyCommand)) {
      expect(call.args[0].input.Policy).toBe(
        policyFor({ namespace: baseProperties.namespace }),
      );
    }
    expect(result.PhysicalResourceId).toBe(PHYSICAL_ID);
    expect(result.Data).toEqual({
      [SINK_IDS_JSON_ATTRIBUTE]: sinkIdsJson("us-east-1", "us-west-2"),
    });
  });

  it("removes only its own statement from a dropped region another namespace still uses", async () => {
    oamMock.on(ListSinksCommand).callsFake(perRegion(isbSinkIn));
    oamMock.on(GetSinkPolicyCommand).resolves({
      Policy: policyFor(
        { namespace: baseProperties.namespace },
        { namespace: "second", poolOuId: SECOND_POOL_OU_ID },
      ),
    });

    const result = await handler(
      createEvent(
        { ...baseProperties, managedRegions: ["us-east-1"] },
        "Update",
        baseProperties,
      ),
      mockContext(testEnv),
    );

    const puts = oamMock
      .commandCalls(PutSinkPolicyCommand)
      .map((call) => call.args[0].input);
    expect(puts.map((p) => p.SinkIdentifier)).toEqual([
      sinkArn("us-east-1"),
      sinkArn("us-west-2"),
    ]);
    expect(JSON.parse(puts[1]!.Policy!).Statement).toEqual([
      policyStatement("second", SECOND_POOL_OU_ID),
    ]);
    expect(oamMock.commandCalls(DeleteSinkCommand)).toHaveLength(0);
    // the dropped region leaves the map the link StackSet deploys from
    expect(result.Data![SINK_IDS_JSON_ATTRIBUTE]).toBe(
      sinkIdsJson("us-east-1"),
    );
  });

  it("vacates, but keeps, the sink of a dropped region it is the last member of", async () => {
    // its links there stay attached until the link StackSet update that follows
    oamMock.on(ListSinksCommand).callsFake(perRegion(isbSinkIn));

    await handler(
      createEvent(
        { ...baseProperties, managedRegions: ["us-east-1"] },
        "Update",
        baseProperties,
      ),
      mockContext(testEnv),
    );

    expect(
      oamMock.commandCalls(PutSinkPolicyCommand).map((c) => c.args[0].input),
    ).toEqual([
      {
        SinkIdentifier: sinkArn("us-east-1"),
        Policy: policyFor({ namespace: baseProperties.namespace }),
      },
      { SinkIdentifier: sinkArn("us-west-2"), Policy: VACANT_POLICY },
    ]);
    expect(oamMock.commandCalls(DeleteSinkCommand)).toHaveLength(0);
  });

  it("keeps statements it does not own in a dropped region", async () => {
    oamMock.on(ListSinksCommand).callsFake(perRegion(isbSinkIn));
    oamMock.on(GetSinkPolicyCommand).resolves({
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          OPERATOR_STATEMENT,
          policyStatement(baseProperties.namespace),
        ],
      }),
    });

    await handler(
      createEvent(
        { ...baseProperties, managedRegions: ["us-east-1"] },
        "Update",
        baseProperties,
      ),
      mockContext(testEnv),
    );

    const westPut =
      oamMock.commandCalls(PutSinkPolicyCommand)[1]!.args[0].input;
    expect(westPut.SinkIdentifier).toBe(sinkArn("us-west-2"));
    expect(statementsIn(westPut.Policy)).toEqual([OPERATOR_STATEMENT]);
  });

  it("fails on any other error in a dropped region, restoring what it changed", async () => {
    oamMock.on(ListSinksCommand).callsFake(
      perRegion((region) => {
        if (region === "us-west-2") {
          throw awsError("ThrottlingException", "slow down");
        }
        return isbSinkIn(region);
      }),
    );

    expect(
      await failureOf(
        handler(
          createEvent(
            { ...baseProperties, managedRegions: ["us-east-1"] },
            "Update",
            baseProperties,
          ),
          mockContext(testEnv),
        ),
      ),
    ).toBe("ListSinks in us-west-2 failed: ThrottlingException: slow down");
    const ownPolicy = policyFor({ namespace: baseProperties.namespace });
    expect(
      oamMock.commandCalls(PutSinkPolicyCommand).map((c) => c.args[0].input),
    ).toEqual([
      { SinkIdentifier: sinkArn("us-east-1"), Policy: ownPolicy },
      { SinkIdentifier: sinkArn("us-east-1"), Policy: ownPolicy },
    ]);
  });

  it("skips a dropped region whose ListSinks an SCP refuses", async () => {
    oamMock.on(ListSinksCommand).callsFake(
      perRegion((region) => {
        if (region === "eu-west-1") {
          throw awsError("AccessDeniedException", "explicit deny in an SCP");
        }
        return isbSinkIn(region);
      }),
    );

    await expect(
      handler(
        createEvent(
          { ...baseProperties, managedRegions: ["us-east-1"] },
          "Update",
          { ...baseProperties, managedRegions: ["eu-west-1", "us-east-1"] },
        ),
        mockContext(testEnv),
      ),
    ).resolves.toMatchObject({
      Data: { [SINK_IDS_JSON_ATTRIBUTE]: sinkIdsJson("us-east-1") },
    });
    expect(
      oamMock
        .commandCalls(PutSinkPolicyCommand)
        .map((c) => c.args[0].input.SinkIdentifier),
    ).toEqual([sinkArn("us-east-1")]);
  });

  it("fails when a dropped region's sink refuses the policy read, restoring what it changed", async () => {
    oamMock.on(ListSinksCommand).callsFake(perRegion(isbSinkIn));
    oamMock.on(GetSinkPolicyCommand).callsFake(
      perRegion((region) => {
        if (region === "eu-west-1") {
          throw awsError("AccessDeniedException", "not authorized");
        }
        return { Policy: policyFor({ namespace: baseProperties.namespace }) };
      }),
    );

    expect(
      await failureOf(
        handler(
          createEvent(
            { ...baseProperties, managedRegions: ["us-east-1"] },
            "Update",
            { ...baseProperties, managedRegions: ["eu-west-1", "us-east-1"] },
          ),
          mockContext(testEnv),
        ),
      ),
    ).toBe(
      `GetSinkPolicy ${sinkArn("eu-west-1")} failed: AccessDeniedException: not authorized${TAG_HINT}`,
    );
    expect(
      oamMock
        .commandCalls(PutSinkPolicyCommand)
        .map((c) => c.args[0].input.SinkIdentifier),
    ).toEqual([sinkArn("us-east-1"), sinkArn("us-east-1")]);
  });

  it("fails when a dropped region's sink refuses the policy write, restoring what it changed", async () => {
    oamMock.on(ListSinksCommand).callsFake(perRegion(isbSinkIn));
    oamMock.on(PutSinkPolicyCommand).callsFake(
      perRegion((region) => {
        if (region === "eu-west-1") {
          throw awsError("AccessDeniedException", "explicit deny in an SCP");
        }
        return {};
      }),
    );

    expect(
      await failureOf(
        handler(
          createEvent(
            { ...baseProperties, managedRegions: ["us-east-1"] },
            "Update",
            { ...baseProperties, managedRegions: ["eu-west-1", "us-east-1"] },
          ),
          mockContext(testEnv),
        ),
      ),
    ).toBe(
      `PutSinkPolicy ${sinkArn("eu-west-1")} failed: AccessDeniedException: explicit deny in an SCP${TAG_HINT}; 1 regional sink change(s) this request may have made could not be restored, see the function log`,
    );
    // the refused put is recorded first, so its restore is attempted and refused too
    expect(
      oamMock
        .commandCalls(PutSinkPolicyCommand)
        .map((c) => c.args[0].input.SinkIdentifier),
    ).toEqual([
      sinkArn("us-east-1"),
      sinkArn("eu-west-1"),
      sinkArn("eu-west-1"),
      sinkArn("us-east-1"),
    ]);
  });

  it("replaces its own statement when its pool OU moves, leaving other namespaces alone", async () => {
    const movedOuId = "ou-ab12-pool0003";
    orgsMock.on(ListParentsCommand, { ChildId: movedOuId }).resolves({
      Parents: [{ Id: PARENT_OU_ID, Type: "ORGANIZATIONAL_UNIT" }],
    });
    oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
    oamMock.on(GetSinkPolicyCommand).resolves({
      Policy: policyFor(
        { namespace: baseProperties.namespace },
        { namespace: "second", poolOuId: SECOND_POOL_OU_ID },
      ),
    });
    const current = { ...baseProperties, managedRegions: ["us-east-1"] };

    await handler(
      createEvent({ ...current, sandboxOuId: movedOuId }, "Update", current),
      mockContext(testEnv),
    );

    const policy = JSON.parse(
      oamMock.commandCalls(PutSinkPolicyCommand)[0]!.args[0].input.Policy!,
    );
    expect(policy.Statement).toEqual([
      policyStatement(baseProperties.namespace, movedOuId),
      policyStatement("second", SECOND_POOL_OU_ID),
    ]);
  });

  it("rejects old properties that do not parse before calling anything", async () => {
    await expect(
      handler(
        createEvent(baseProperties, "Update", {
          ...baseProperties,
          managedRegions: [],
        }),
        mockContext(testEnv),
      ),
    ).rejects.toThrow(
      `Invalid old ${OBSERVABILITY_SINKS_RESOURCE_TYPE} properties`,
    );
    expect(orgsMock.calls()).toHaveLength(0);
    expect(oamMock.calls()).toHaveLength(0);
  });

  it("removes the sink it created when a later step fails", async () => {
    oamMock.on(CreateSinkCommand).callsFake(westCreateFails);

    await expect(
      handler(createEvent(baseProperties, "Update"), mockContext(testEnv)),
    ).rejects.toThrow("CreateSink in us-west-2 failed");
    expect(
      oamMock.commandCalls(DeleteSinkCommand).map((d) => d.args[0].input),
    ).toEqual([{ Identifier: sinkArn("us-east-1") }]);
  });
});

describe("Custom::ObservabilitySinks from a member-account hub", () => {
  const memberHubProperties = {
    ...baseProperties,
    orgMgtAccountId: ORG_MGT_ACCOUNT_ID,
  };
  const listed = { DelegatedAdministrators: [{ Id: HUB_ACCOUNT_ID }] };
  const notListed = { DelegatedAdministrators: [] };

  it("registers nothing when the hub is already a StackSets delegated administrator", async () => {
    orgsMock.on(ListDelegatedAdministratorsCommand).resolves(listed);

    await handler(createEvent(memberHubProperties), mockContext(testEnv));

    expect(
      orgsMock.commandCalls(ListDelegatedAdministratorsCommand)[0]!.args[0]
        .input,
    ).toEqual({
      ServicePrincipal: STACKSETS_DELEGATED_ADMIN_SERVICE_PRINCIPAL,
      NextToken: undefined,
    });
    expect(
      orgsMock.commandCalls(RegisterDelegatedAdministratorCommand),
    ).toEqual([]);
    expect(oamMock.commandCalls(CreateSinkCommand)).toHaveLength(2);
  });

  it("finds the hub on a later page before deciding to register", async () => {
    orgsMock
      .on(ListDelegatedAdministratorsCommand)
      .resolvesOnce({ DelegatedAdministrators: [], NextToken: "page-2" })
      .resolvesOnce(listed);

    await handler(createEvent(memberHubProperties), mockContext(testEnv));

    expect(
      orgsMock.commandCalls(ListDelegatedAdministratorsCommand)[1]!.args[0]
        .input.NextToken,
    ).toBe("page-2");
    expect(
      orgsMock.commandCalls(RegisterDelegatedAdministratorCommand),
    ).toEqual([]);
  });

  it("points at the AccountPool stack when listing delegated administrators is denied", async () => {
    orgsMock
      .on(ListDelegatedAdministratorsCommand)
      .rejects(awsError("AccessDeniedException", "not authorized"));

    await expect(
      handler(createEvent(memberHubProperties), mockContext(testEnv)),
    ).rejects.toThrow(
      `ListDelegatedAdministrators failed: AccessDeniedException: not authorized${ORG_HINT}`,
    );
    expect(oamMock.commandCalls(CreateSinkCommand)).toHaveLength(0);
  });

  it("registers the hub and waits until it is listed before creating sinks", async () => {
    orgsMock
      .on(ListDelegatedAdministratorsCommand)
      .resolvesOnce(notListed)
      .resolves(listed);
    orgsMock.on(RegisterDelegatedAdministratorCommand).resolves({});

    await handler(createEvent(memberHubProperties), mockContext(testEnv));

    const registrations = orgsMock.commandCalls(
      RegisterDelegatedAdministratorCommand,
    );
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.args[0].input).toEqual({
      AccountId: HUB_ACCOUNT_ID,
      ServicePrincipal: STACKSETS_DELEGATED_ADMIN_SERVICE_PRINCIPAL,
    });
    expect(
      orgsMock.commandCalls(ListDelegatedAdministratorsCommand),
    ).toHaveLength(2);
    expect(oamMock.commandCalls(CreateSinkCommand)).toHaveLength(2);
  });

  it("gives up after the wait budget when the registration never shows", async () => {
    vi.useFakeTimers();
    orgsMock.on(ListDelegatedAdministratorsCommand).resolves(notListed);
    orgsMock.on(RegisterDelegatedAdministratorCommand).resolves({});
    // Middy's early-timeout guard runs on a real timer, so the fixture's
    // 100 ms budget could expire while this test advances fake time.
    const context = {
      ...mockContext(testEnv),
      getRemainingTimeInMillis: () => 60_000,
    };

    const outcome = handler(createEvent(memberHubProperties), context).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(0);
    // the check before registering and the first check after it, then a wait
    expect(
      orgsMock.commandCalls(ListDelegatedAdministratorsCommand),
    ).toHaveLength(2);
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(3_000);
    }

    expect(await outcome).toBe(
      `Hub ${HUB_ACCOUNT_ID} is not listed as a StackSets delegated administrator 30s after registration; redeploy once ListDelegatedAdministrators shows it`,
    );
    expect(
      orgsMock.commandCalls(ListDelegatedAdministratorsCommand),
    ).toHaveLength(11);
    expect(oamMock.commandCalls(CreateSinkCommand)).toHaveLength(0);
  });

  it("treats a concurrent registration as success", async () => {
    orgsMock
      .on(ListDelegatedAdministratorsCommand)
      .resolvesOnce(notListed)
      .resolves(listed);
    orgsMock
      .on(RegisterDelegatedAdministratorCommand)
      .rejects(awsError("AccountAlreadyRegisteredException"));

    await expect(
      handler(createEvent(memberHubProperties), mockContext(testEnv)),
    ).resolves.toMatchObject({ PhysicalResourceId: PHYSICAL_ID });
  });

  it("surfaces a refused registration with the trusted-access hint", async () => {
    orgsMock.on(ListDelegatedAdministratorsCommand).resolves(notListed);
    orgsMock
      .on(RegisterDelegatedAdministratorCommand)
      .rejects(awsError("AccessDeniedException", "trusted access is off"));

    await expect(
      handler(createEvent(memberHubProperties), mockContext(testEnv)),
    ).rejects.toThrow(
      "RegisterDelegatedAdministrator failed: AccessDeniedException: trusted access is off; StackSets trusted access must be enabled in AWS Organizations",
    );
    expect(oamMock.commandCalls(CreateSinkCommand)).toHaveLength(0);
  });
});

describe("Custom::ObservabilitySinks delete", () => {
  it("deletes the sinks it finds in the listed regions and keeps the event's physical id", async () => {
    oamMock.on(ListSinksCommand).callsFake(
      perRegion((region) => ({
        Items:
          region === "us-east-1"
            ? [{ Name: SINK_NAME, Arn: sinkArn(region) }]
            : [{ Name: "customer-sink", Arn: sinkArn(region, "333333333333") }],
      })),
    );

    const result = await handler(
      createEvent(baseProperties, "Delete"),
      mockContext(testEnv),
    );

    expect(
      oamMock.commandCalls(DeleteSinkCommand).map((d) => d.args[0].input),
    ).toEqual([{ Identifier: sinkArn("us-east-1") }]);
    expect(result.PhysicalResourceId).toBe(PHYSICAL_ID);
    expect(orgsMock.calls()).toHaveLength(0);
  });

  it("removes only its own statement while another namespace still uses the sink", async () => {
    oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
    oamMock.on(GetSinkPolicyCommand).resolves({
      Policy: policyFor(
        { namespace: baseProperties.namespace },
        { namespace: "second", poolOuId: SECOND_POOL_OU_ID },
      ),
    });

    await handler(
      createEvent(
        { ...baseProperties, managedRegions: ["us-east-1"] },
        "Delete",
      ),
      mockContext(testEnv),
    );

    expect(oamMock.commandCalls(DeleteSinkCommand)).toHaveLength(0);
    expect(
      oamMock.commandCalls(PutSinkPolicyCommand).map((c) => c.args[0].input),
    ).toEqual([
      {
        SinkIdentifier: sinkArn("us-east-1"),
        Policy: policyFor({ namespace: "second", poolOuId: SECOND_POOL_OU_ID }),
      },
    ]);
  });

  it("changes nothing on a repeated delete once another namespace holds the sink alone", async () => {
    oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
    oamMock.on(GetSinkPolicyCommand).resolves({
      Policy: policyFor({ namespace: "second", poolOuId: SECOND_POOL_OU_ID }),
    });

    await handler(
      createEvent(
        { ...baseProperties, managedRegions: ["us-east-1"] },
        "Delete",
      ),
      mockContext(testEnv),
    );

    expect(oamMock.commandCalls(PutSinkPolicyCommand)).toHaveLength(0);
    expect(oamMock.commandCalls(DeleteSinkCommand)).toHaveLength(0);
  });

  it("treats a sink that is already gone as deleted", async () => {
    oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
    oamMock
      .on(DeleteSinkCommand)
      .rejects(awsError("ResourceNotFoundException", "no such sink"));

    await expect(
      handler(
        createEvent(
          { ...baseProperties, managedRegions: ["us-east-1"] },
          "Delete",
        ),
        mockContext(testEnv),
      ),
    ).resolves.toMatchObject({ PhysicalResourceId: PHYSICAL_ID });
  });

  it("points at the attached links when a sink cannot be deleted", async () => {
    oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
    oamMock
      .on(DeleteSinkCommand)
      .rejects(awsError("ConflictException", "Sink has attached links"));

    await expect(
      handler(
        createEvent(
          { ...baseProperties, managedRegions: ["us-east-1"] },
          "Delete",
        ),
        mockContext(testEnv),
      ),
    ).rejects.toThrow(
      `DeleteSink ${sinkArn("us-east-1")} failed: ConflictException: Sink has attached links; links are still attached: list them with aws oam list-attached-links --sink-identifier ${sinkArn("us-east-1")} --region us-east-1, delete them in their source accounts, then retry`,
    );
  });

  it("keeps a sink that holds a statement ISB did not write", async () => {
    oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
    oamMock.on(GetSinkPolicyCommand).resolves({
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          OPERATOR_STATEMENT,
          policyStatement(baseProperties.namespace),
        ],
      }),
    });

    await handler(
      createEvent(
        { ...baseProperties, managedRegions: ["us-east-1"] },
        "Delete",
      ),
      mockContext(testEnv),
    );

    expect(oamMock.commandCalls(DeleteSinkCommand)).toHaveLength(0);
    expect(
      oamMock.commandCalls(PutSinkPolicyCommand).map((c) => c.args[0].input),
    ).toEqual([
      {
        SinkIdentifier: sinkArn("us-east-1"),
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [OPERATOR_STATEMENT],
        }),
      },
    ]);
  });

  it("deletes a vacant sink and one without a policy", async () => {
    oamMock.on(ListSinksCommand).callsFake(perRegion(isbSinkIn));
    oamMock.on(GetSinkPolicyCommand).callsFake(
      perRegion((region) => {
        if (region === "us-west-2") {
          throw awsError("ResourceNotFoundException", "Resource not found.");
        }
        return { Policy: VACANT_POLICY };
      }),
    );

    await handler(createEvent(baseProperties, "Delete"), mockContext(testEnv));

    expect(oamMock.commandCalls(PutSinkPolicyCommand)).toHaveLength(0);
    expect(
      oamMock.commandCalls(DeleteSinkCommand).map((d) => d.args[0].input),
    ).toEqual([
      { Identifier: sinkArn("us-west-2") },
      { Identifier: sinkArn("us-east-1") },
    ]);
  });

  it("names the tag when an untagged sink cannot be deleted", async () => {
    oamMock.on(ListSinksCommand).resolves(isbSinkIn("us-east-1"));
    oamMock
      .on(DeleteSinkCommand)
      .rejects(awsError("AccessDeniedException", "not authorized"));

    await expect(
      handler(
        createEvent(
          { ...baseProperties, managedRegions: ["us-east-1"] },
          "Delete",
        ),
        mockContext(testEnv),
      ),
    ).rejects.toThrow(
      `DeleteSink ${sinkArn("us-east-1")} failed: AccessDeniedException: not authorized${TAG_HINT}`,
    );
  });

  it("skips deletion, without failing the stack, when the properties do not parse", async () => {
    const result = await handler(
      createEvent(
        { ...baseProperties, managedRegions: "not-a-list" },
        "Delete",
      ),
      mockContext(testEnv),
    );

    expect(result.PhysicalResourceId).toBe(PHYSICAL_ID);
    expect(oamMock.calls()).toHaveLength(0);
  });
});

describe("Custom::ObservabilitySinks across requests and namespaces", () => {
  const eastOnly = { ...baseProperties, managedRegions: ["us-east-1"] };
  const secondInWest = {
    ...baseProperties,
    namespace: "second",
    sandboxOuId: SECOND_POOL_OU_ID,
    managedRegions: ["us-west-2"],
  };
  const run = (
    properties: Record<string, unknown>,
    requestType: "Create" | "Update" | "Delete",
    oldProperties?: Record<string, unknown>,
  ) =>
    handler(
      createEvent(properties, requestType, oldProperties),
      mockContext(testEnv),
    );

  it("leaves no sink once every namespace that used a dropped region is gone", async () => {
    const sinks = statefulOam();
    await run(baseProperties, "Create");
    // a namespace's link StackSet attaches its links after its sink resource
    sinks.get("us-east-1")!.links = 1;
    sinks.get("us-west-2")!.links = 1;

    await run(eastOnly, "Update", baseProperties);
    expect(sinks.get("us-west-2")!.policy).toBe(VACANT_POLICY);
    // and the StackSet update that follows removes the dropped region's link
    sinks.get("us-west-2")!.links = 0;

    await run(secondInWest, "Create");
    expect(statementsIn(sinks.get("us-west-2")!.policy)).toEqual([
      policyStatement("second", SECOND_POOL_OU_ID),
    ]);

    // a namespace's links are gone before its sink resource is deleted
    await run(secondInWest, "Delete");
    sinks.get("us-east-1")!.links = 0;
    await run(eastOnly, "Delete");

    expect([...sinks.keys()]).toEqual([]);
  });

  it("rolls back the addition of a region the hub cannot call", async () => {
    const sinks = statefulOam({ unreachable: ["us-west-2"] });
    await run(eastOnly, "Create");
    const eastPolicy = sinks.get("us-east-1")!.policy;

    expect(await failureOf(run(baseProperties, "Update", eastOnly))).toBe(
      `ListSinks in us-west-2 failed: ${DISABLED_REGION_ERROR.join(": ")}`,
    );
    // CloudFormation's rollback Update swaps the old and new properties
    await expect(
      run(eastOnly, "Update", baseProperties),
    ).resolves.toMatchObject({
      Data: { [SINK_IDS_JSON_ATTRIBUTE]: sinkIdsJson("us-east-1") },
    });
    expect([...sinks.keys()]).toEqual(["us-east-1"]);
    expect(sinks.get("us-east-1")!.policy).toBe(eastPolicy);
  });

  it("rolls back the addition of a region by vacating the sink it created there", async () => {
    const sinks = statefulOam();
    await run(eastOnly, "Create");
    // the Update succeeds, a later resource fails, and the stack rolls back
    await run(baseProperties, "Update", eastOnly);
    await run(eastOnly, "Update", baseProperties);
    expect(sinks.get("us-west-2")!.policy).toBe(VACANT_POLICY);

    // a retried addition rejoins the sink whose id the link template holds
    await run(baseProperties, "Update", eastOnly);
    expect(statementsIn(sinks.get("us-west-2")!.policy)).toEqual([
      policyStatement(baseProperties.namespace),
    ]);
    expect(oamMock.commandCalls(CreateSinkCommand)).toHaveLength(2);
  });
});

describe("shared sink identity", () => {
  it("keeps the literals through which namespaces of any version share a sink", () => {
    expect(OBSERVABILITY_SINK_NAME).toBe("InnovationSandbox-Metrics");
    expect(OBSERVABILITY_SINK_TAG).toEqual({
      key: "aws-solutions:isb-id",
      value: "shared_observability_isb",
    });
    expect(observabilitySinkPolicySid("myisb")).toBe(
      "InnovationSandboxNamespacemyisb",
    );
    expect(OBSERVABILITY_SINK_VACANT_POLICY_SID).toBe(
      "InnovationSandboxNoMembers",
    );
  });
});
