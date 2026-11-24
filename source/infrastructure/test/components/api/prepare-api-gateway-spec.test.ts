// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  API_DOMAINS,
  DomainLambdaArns,
  EXCLUDED_DOMAINS,
  OpenApiDocument,
  prepareApiGatewaySpec,
} from "@amzn/innovation-sandbox-infrastructure/components/api/prepare-api-gateway-spec";

const HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

const contractPath = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "docs",
  "openapi",
  "innovation-sandbox-api.json",
);
const contract = JSON.parse(
  readFileSync(contractPath, "utf8"),
) as OpenApiDocument;

const lambdaArns: DomainLambdaArns = {
  accounts: "arn:accounts",
  blueprints: "arn:blueprints",
  configurations: "arn:configurations",
  leases: "arn:leases",
  leaseTemplates: "arn:lease-templates",
  permissionSets: "arn:permission-sets",
  principals: "arn:principals",
  sandboxAgent: "arn:sandbox-agent",
};

const methods = (document: OpenApiDocument) =>
  Object.entries(document.paths).flatMap(([pathName, pathItem]) =>
    Object.keys(pathItem)
      .filter((key) => HTTP_METHODS.has(key))
      .map((method) => `${method.toUpperCase()} ${pathName}`),
  );

describe("prepareApiGatewaySpec", () => {
  it("keeps API_DOMAINS in sync with the generated contract's path segments", () => {
    // The contract is the single source of truth for domains; API_DOMAINS mirrors
    // it to provide the ApiDomain / DomainLambdaArns types. If the contract adds or
    // renames a domain, this fails until API_DOMAINS (and the Lambda wiring) follow
    // — unless the domain is in EXCLUDED_DOMAINS (not runtime-routable yet).
    const fromContract = [
      ...new Set(Object.keys(contract.paths).map((p) => p.split("/")[1])),
    ].filter((domain) => !EXCLUDED_DOMAINS.has(domain ?? ""));
    expect([...API_DOMAINS].sort()).toEqual(fromContract.sort());
  });

  it("keeps every generated operation (except EXCLUDED_DOMAINS) and literal configuration route", () => {
    const spec = prepareApiGatewaySpec(contract, lambdaArns);

    const expectedMethods = methods(contract).filter(
      (m) => !EXCLUDED_DOMAINS.has(m.split(" ")[1]?.split("/")[1] ?? ""),
    );
    expect(methods(spec).sort()).toEqual(expectedMethods.sort());
    expect(spec.paths["/permissionSets"]).toBeDefined();
    expect(spec.paths["/configurations/{section}"]).toBeUndefined();
    // Per-section config paths use literal paths (no /{section} pattern).
    // Sub-resource paths like /configurations/agent/models/{modelId} are allowed.
    const configSectionPaths = Object.keys(contract.paths).filter(
      (pathName) =>
        pathName.startsWith("/configurations/") &&
        !pathName.startsWith("/configurations/agent/"),
    );
    expect(configSectionPaths.length).toBeGreaterThan(0);
    expect(
      configSectionPaths.every((pathName) => !pathName.includes("{")),
    ).toBe(true);
  });

  it("sets the TLS security policy and endpoint access mode", () => {
    const spec = prepareApiGatewaySpec(contract, lambdaArns);

    expect(spec["x-amazon-apigateway-security-policy"]).toBe(
      "SecurityPolicy_TLS12_PFS_2025_EDGE",
    );
    expect(spec["x-amazon-apigateway-endpoint-access-mode"]).toBe("STRICT");
  });

  it("preserves the public contract and does not mutate its input", () => {
    const pristine = structuredClone(contract);
    const spec = prepareApiGatewaySpec(contract, lambdaArns);

    expect(contract).toEqual(pristine);
    expect(spec.components?.schemas).toEqual(contract.components?.schemas);
    expect(spec.servers).toEqual(contract.servers);
    expect(spec.info).toEqual(contract.info);
    expect(JSON.stringify(spec)).toContain('"examples"');
    expect(JSON.stringify(spec)).toContain('"requestBody"');
  });

  it("adds the appropriate domain Lambda integration to every operation", () => {
    const spec = prepareApiGatewaySpec(contract, lambdaArns);

    for (const [pathName, pathItem] of Object.entries(spec.paths)) {
      const domain = pathName.split("/")[1] as keyof DomainLambdaArns;
      for (const [method, value] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) {
          continue;
        }
        const operation = value as Record<string, unknown>;
        expect(
          operation["x-amazon-apigateway-integration"],
          `${method.toUpperCase()} ${pathName}`,
        ).toEqual({
          type: "aws_proxy",
          httpMethod: "POST",
          uri: {
            "Fn::Sub": [
              "arn:${AWS::Partition}:apigateway:${AWS::Region}:lambda:path/" +
                "2015-03-31/functions/${LambdaArn}/invocations",
              { LambdaArn: lambdaArns[domain] },
            ],
          },
        });
      }
    }
  });

  it("uses uniform AWS_IAM and explicitly leaves gateway validation disabled", () => {
    const spec = prepareApiGatewaySpec(contract, lambdaArns);

    expect(spec.security).toEqual([{ "aws.auth.sigv4": [] }]);
    expect(spec.components?.securitySchemes?.["aws.auth.sigv4"]).toBeDefined();
    expect(spec.components?.securitySchemes?.isbIdentity).toBeUndefined();
    expect(spec["x-amazon-apigateway-request-validators"]).toEqual({
      none: {
        validateRequestBody: false,
        validateRequestParameters: false,
      },
    });
    expect(spec["x-amazon-apigateway-request-validator"]).toBe("none");
  });

  it("fails closed on unknown domains and operation-level auth overrides", () => {
    const unknownDomain = structuredClone(contract);
    unknownDomain.paths["/unknown"] = {
      get: { responses: { "200": { description: "ok" } } },
    };
    expect(() => prepareApiGatewaySpec(unknownDomain, lambdaArns)).toThrow(
      /no Lambda integration mapping/,
    );

    const authOverride = structuredClone(contract);
    const accounts = authOverride.paths["/accounts"]?.get;
    if (typeof accounts !== "object" || accounts === null) {
      throw new Error("test fixture has no GET /accounts operation");
    }
    (accounts as Record<string, unknown>).security = [];
    expect(() => prepareApiGatewaySpec(authOverride, lambdaArns)).toThrow(
      /operation-level security/,
    );
  });

  it("throws when an operation is malformed", () => {
    const malformed = structuredClone(contract);
    (malformed.paths["/accounts"] as Record<string, unknown>).get =
      "not-an-operation";
    expect(() => prepareApiGatewaySpec(malformed, lambdaArns)).toThrow(
      /is not an operation/,
    );
  });

  it("throws when a domain's Lambda ARN is missing", () => {
    const missingArn = { ...lambdaArns, accounts: "" } as DomainLambdaArns;
    expect(() => prepareApiGatewaySpec(contract, missingArn)).toThrow(
      /no Lambda ARN supplied/,
    );
  });
});
