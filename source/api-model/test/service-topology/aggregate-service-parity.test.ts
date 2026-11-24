// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parity of the aggregate `IsbApi` service with the per-domain services, their
 * `server-<domain>` projections, and the committed server package's exports. See
 * `README.md` in this folder for what each leg guards, why drift is silent, and
 * how the model is parsed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const modelRoot = join(import.meta.dirname, "..", "..");
const smithyDir = join(modelRoot, "src", "main", "smithy");

interface ServiceShape {
  operations: Set<string>;
  errors: Set<string>;
}

function names(listBody: string | undefined): Set<string> {
  return new Set(
    (listBody ?? "")
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

/** Every `service` shape in the model with its declared operations and errors. */
function serviceShapes(): Map<string, ServiceShape> {
  const services = new Map<string, ServiceShape>();
  for (const file of readdirSync(smithyDir).filter((f) =>
    f.endsWith(".smithy"),
  )) {
    // Strip `//`/`///` comments first, so a commented-out service template (e.g.
    // a "how to add a domain" snippet) cannot register as a real service or
    // swallow the following real declaration. Only comments preceded by
    // whitespace/line start are stripped, which leaves `://` in doc URLs alone.
    const text = readFileSync(join(smithyDir, file), "utf8").replace(
      /(^|\s)\/\/[^\n]*/g,
      "$1",
    );
    const servicePattern = /service\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
    let match: RegExpExecArray | null;
    while ((match = servicePattern.exec(text)) !== null) {
      const name = match[1]!;
      const body = match[2]!;
      services.set(name, {
        operations: names(/operations:\s*\[([\s\S]*?)\]/.exec(body)?.[1]),
        errors: names(/errors:\s*\[([\s\S]*?)\]/.exec(body)?.[1]),
      });
    }
  }
  return services;
}

/** The service shape name each `server-*` projection's SSDK plugin targets. */
function serverProjectionServiceNames(): Set<string> {
  const config = JSON.parse(
    readFileSync(join(modelRoot, "smithy-build.json"), "utf8"),
  ) as {
    projections?: Record<
      string,
      { plugins?: { "typescript-ssdk-codegen"?: { service?: string } } }
    >;
  };
  const names = new Set<string>();
  for (const [name, projection] of Object.entries(config.projections ?? {})) {
    if (!name.startsWith("server-")) continue;
    const serviceId = projection.plugins?.["typescript-ssdk-codegen"]?.service;
    if (serviceId) names.add(serviceId.split("#").pop()!);
  }
  return names;
}

describe("aggregate service topology", () => {
  const services = serviceShapes();
  const aggregate = services.get("IsbApi");
  const domainServices = new Map(
    [...services].filter(([name]) => name !== "IsbApi"),
  );

  it("gives every aggregate operation exactly one domain-service owner", () => {
    expect(aggregate, "the aggregate IsbApi service must exist").toBeDefined();

    const ownerCount = new Map<string, number>();
    for (const { operations } of domainServices.values()) {
      for (const operation of operations) {
        ownerCount.set(operation, (ownerCount.get(operation) ?? 0) + 1);
      }
    }

    // Same operation set as the aggregate (no orphan on either side)...
    expect([...ownerCount.keys()].sort((a, b) => a.localeCompare(b))).toEqual(
      [...aggregate!.operations].sort((a, b) => a.localeCompare(b)),
    );
    // ...and each owned by exactly one domain service.
    for (const [operation, count] of ownerCount) {
      expect(count, `operation ${operation} has ${count} domain owners`).toBe(
        1,
      );
    }
  });

  it("keeps every domain service's error list equal to the aggregate's", () => {
    // The service-level errors bind to every operation, and the generated server
    // serializes them; a domain service silently dropping (or adding) one would
    // change that Lambda's error serialization without failing anything else.
    for (const [name, { errors }] of domainServices) {
      expect(
        [...errors].sort((a, b) => a.localeCompare(b)),
        `service ${name} errors`,
      ).toEqual([...aggregate!.errors].sort((a, b) => a.localeCompare(b)));
    }
  });

  it("wires each server-<domain> SSDK projection to a domain service, and every domain service without a projection to a hand-written Lambda", () => {
    // SandboxAgentApi's Lambda stays hand-written (not SSDK-generated), so it
    // has no server-<domain> projection even though it still feeds the
    // aggregate client and OpenAPI. An orphan projection (naming a domain
    // service that doesn't exist) is still a drift; a domain service simply
    // lacking one is expected only for entries in this set.
    // TODO: remove "SandboxAgentApi" once its Lambda handler is migrated to a
    // generated SSDK server (adding a server-sandbox-agent projection).
    const serverlessDomainServices = new Set<string>();

    const projectionServices = serverProjectionServiceNames();
    for (const serviceName of projectionServices) {
      expect(
        domainServices.has(serviceName),
        `server projection targets ${serviceName}, which is not a domain service`,
      ).toBe(true);
    }

    const domainsExpectingProjection = [...domainServices.keys()].filter(
      (name) => !serverlessDomainServices.has(name),
    );
    expect([...projectionServices].sort((a, b) => a.localeCompare(b))).toEqual(
      domainsExpectingProjection.sort((a, b) => a.localeCompare(b)),
    );
  });

  it("exports each registered domain from the committed server package", () => {
    // Ties the third leg down: services ↔ projections (above) ↔ the committed
    // exports map consumers resolve through. `validateServerManifest` enforces
    // the same at generation time; this fails earlier, without a build.
    const manifest = JSON.parse(
      readFileSync(join(modelRoot, "..", "api-server", "package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> };
    const config = JSON.parse(
      readFileSync(join(modelRoot, "smithy-build.json"), "utf8"),
    ) as { projections?: Record<string, unknown> };
    const domains = Object.keys(config.projections ?? {})
      .filter((name) => name.startsWith("server-"))
      .map((name) => `./${name.slice("server-".length)}`)
      .sort((a, b) => a.localeCompare(b));
    expect(
      Object.keys(manifest.exports ?? {}).sort((a, b) => a.localeCompare(b)),
    ).toEqual(domains);
  });
});
