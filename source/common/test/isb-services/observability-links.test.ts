// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ListAttachedLinksCommand, OAMClient } from "@aws-sdk/client-oam";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import {
  listLinkedAccounts,
  parseSinkIds,
  sinkArn,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-token-cost/index.js";

const oamMock = mockClient(OAMClient);
const SINK = "arn:aws:oam:us-east-1:111111111111:sink/sink-east";

const linkTo = (account: string) => ({
  LinkArn: `arn:aws:oam:us-east-1:${account}:link/${account.slice(-4)}`,
  Label: `sandbox-${account.slice(-1)}`,
});

beforeEach(() => {
  oamMock.reset();
});

describe("parseSinkIds", () => {
  it("maps each region to its sink id", () => {
    expect(
      parseSinkIds(
        '{"us-east-1":{"Id":"sink-east"},"us-west-2":{"Id":"sink-west"}}',
      ),
    ).toEqual(
      new Map([
        ["us-east-1", "sink-east"],
        ["us-west-2", "sink-west"],
      ]),
    );
  });

  it("rejects a map without ids", () => {
    expect(() => parseSinkIds('{"us-east-1":{}}')).toThrow(/Id/);
    expect(() => parseSinkIds("not json")).toThrow(SyntaxError);
  });
});

describe("sinkArn", () => {
  it("builds the sink ARN for the hub's partition and account", () => {
    expect(
      sinkArn({
        partition: "aws-us-gov",
        accountId: "111111111111",
        region: "us-gov-west-1",
        sinkId: "abc-123",
      }),
    ).toBe("arn:aws-us-gov:oam:us-gov-west-1:111111111111:sink/abc-123");
  });
});

describe("listLinkedAccounts", () => {
  it("collects the account of every attached link across pages", async () => {
    oamMock
      .on(ListAttachedLinksCommand)
      .resolvesOnce({ Items: [linkTo("222222222222")], NextToken: "page-2" })
      .resolvesOnce({ Items: [linkTo("333333333333")] });

    const accounts = await listLinkedAccounts(new OAMClient({}), SINK);

    expect(accounts).toEqual(new Set(["222222222222", "333333333333"]));
    const calls = oamMock.commandCalls(ListAttachedLinksCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args[0].input).toEqual({
      SinkIdentifier: SINK,
      MaxResults: 1000,
      NextToken: undefined,
    });
    expect(calls[1]!.args[0].input.NextToken).toBe("page-2");
  });

  it("takes the account from LinkArn, not from Label", async () => {
    oamMock.on(ListAttachedLinksCommand).resolves({
      Items: [{ ...linkTo("222222222222"), Label: "444444444444" }],
    });

    expect(await listLinkedAccounts(new OAMClient({}), SINK)).toEqual(
      new Set(["222222222222"]),
    );
  });

  it("fails on a link without a usable ARN rather than counting it", async () => {
    oamMock
      .on(ListAttachedLinksCommand)
      .resolves({ Items: [{ Label: "no-arn" }] });

    await expect(listLinkedAccounts(new OAMClient({}), SINK)).rejects.toThrow(
      /Malformed ARN/,
    );
  });

  it("fails on a link whose account segment is not an account id", async () => {
    oamMock.on(ListAttachedLinksCommand).resolves({
      Items: [{ LinkArn: "arn:aws:oam:us-east-1:not-an-account:link/x" }],
    });

    await expect(listLinkedAccounts(new OAMClient({}), SINK)).rejects.toThrow(
      /12 digits/,
    );
  });

  it("returns an empty set for a sink with no links, with or without an Items field", async () => {
    oamMock
      .on(ListAttachedLinksCommand)
      .resolvesOnce({ Items: [] })
      .resolvesOnce({});

    expect(await listLinkedAccounts(new OAMClient({}), SINK)).toEqual(
      new Set(),
    );
    expect(await listLinkedAccounts(new OAMClient({}), SINK)).toEqual(
      new Set(),
    );
  });
});
