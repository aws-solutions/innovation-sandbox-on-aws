// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ListAttachedLinksCommand, OAMClient } from "@aws-sdk/client-oam";
import { build as buildArn, parse as parseArn } from "@aws-sdk/util-arn-parser";
import { z } from "zod";

import { SINK_ID_MAPPING_KEY } from "@amzn/innovation-sandbox-commons/data/observability-sink-config/observability-sink-config.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

/** The sink custom resource's output, {"<region>":{"Id":"<sink id>"}}, passed through unchanged. */
const SinkIdsByRegionSchema = z.record(
  z.string(),
  z.object({ [SINK_ID_MAPPING_KEY]: z.string().min(1) }),
);

/** A managed region the sink map does not cover; named so an alarm can tell a redeploy from a throttle. */
export class MissingSinkError extends Error {
  constructor(region: string) {
    super(
      `no sink for ${region}: redeploy the Compute stack after changing the managed regions`,
    );
    this.name = "MissingSinkError";
  }
}

/** region -> sink id */
export function parseSinkIds(json: string): Map<string, string> {
  const parsed = SinkIdsByRegionSchema.parse(JSON.parse(json));
  return new Map(
    Object.entries(parsed).map(([region, entry]) => [
      region,
      entry[SINK_ID_MAPPING_KEY],
    ]),
  );
}

export function sinkArn(args: {
  partition: string;
  accountId: string;
  region: string;
  sinkId: string;
}): string {
  return buildArn({
    partition: args.partition,
    service: "oam",
    region: args.region,
    accountId: args.accountId,
    resource: `sink/${args.sinkId}`,
  });
}

/**
 * The accounts whose links are attached to one sink, which are the accounts
 * the hub can read in that region. The response has no account id field: it is
 * the account field of `LinkArn`, the link living in the source account.
 * `Label` is only the account name under the `$AccountName` template.
 */
export async function listLinkedAccounts(
  oamClient: OAMClient,
  sinkIdentifier: string,
): Promise<Set<string>> {
  const accounts = new Set<string>();
  let nextToken: string | undefined;
  do {
    const page = await oamClient.send(
      new ListAttachedLinksCommand({
        SinkIdentifier: sinkIdentifier,
        MaxResults: 1000,
        NextToken: nextToken,
      }),
    );
    for (const link of page.Items ?? []) {
      accounts.add(
        AwsAccountIdSchema.parse(parseArn(link.LinkArn ?? "").accountId),
      );
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return accounts;
}
