# API Model

This package contains the Smithy model and build configuration for generating
the private TypeScript API client and server bindings.

## Model layout and service topology

The model is split by namespace-merged files under `src/main/smithy/`:

- `common.smithy` — the JSend envelope, shared errors, and shared scalars.
- `<domain>.smithy` — each domain's operations and shapes, plus its per-domain
  service shape (e.g. `LeaseTemplatesApi`).
- `main.smithy` — the aggregate `IsbApi` service, listing every operation.

The **aggregate** `IsbApi` service drives the single client + OpenAPI (+ future
CLI); each **per-domain** service drives that domain's server SSDK. Their
projections are configured in `smithy-build.json` (`aggregate`, and one
`server-<domain>` per domain). `scripts/generate.mjs` copies each domain's generated
_sources_ into the committed `@amzn/innovation-sandbox-api-server` package as
`domains/<domain>/`, exported as the subpath
`@amzn/innovation-sandbox-api-server/<domain>` (CJS + type declarations). The
server package's shell — its `package.json` and tsconfigs — is
committed, not generated; generation validates it against what codegen requires
and fails with an actionable error on drift.

### Adding a domain / Lambda

1. Add `<domain>.smithy` with the domain's operations, shapes, and a
   `@restJson1 service <Domain>Api { operations: [...] }`.
2. Append those operations to the aggregate `IsbApi` in `main.smithy`
   (`test/service-topology/` fails if the two ever diverge).
3. Add a `server-<domain>` projection to `smithy-build.json` (SSDK targeting
   `com.amazon.isb#<Domain>Api`, package `@amzn/innovation-sandbox-api-server`).
   The domain list is derived from these projections — there is no separate
   registry.
4. Add the domain's `exports["./<domain>"]` entry (pointing at
   `./dist-types/<domain>/index.d.ts` and `./dist-cjs/<domain>/index.js`) to the
   committed `source/api-server/package.json`; if codegen brings a new runtime
   dependency, add it there too and refresh `package-lock.json`. Generation and
   `test/service-topology/` both fail until this matches.
5. In the Lambda, build the handler with `get<Domain>ApiServiceHandler(...)` and
   `jsendValidationCustomizer(...)`, importing from
   `@amzn/innovation-sandbox-api-server/<domain>`.

The shared response/validation glue in `common/lambda/smithy/` and the aggregate
client are reused unchanged.

## HTTP path naming

Public HTTP path segments use lower camel case when they contain multiple words,
including top-level domains (`/leaseTemplates`, `/permissionSets`,
`/sandboxAgent`) and new subresources or actions. Smithy projection names,
package subpaths, and source directories may remain kebab-case because they are
build-time identifiers rather than public HTTP paths.

`/accounts/{awsAccountId}/cleanup-reports` predates this convention and remains
unchanged for backward compatibility. It is the only grandfathered kebab-case
public path segment and must not be used as a precedent for new routes.

The generated Smithy server router handles path labels independently of segment
casing. `/leaseTemplates/{leaseTemplateId}` provides the regression coverage for
path-parameter routing under a multi-word domain. Because `/leaseTemplates`
remains the canonical path, existing consumers require no alias or migration.

## Generate the bindings

From the repository root, use the supported generation command:

```bash
npm run smithy:generate
```

From this package directory, the equivalent entry point is:

```bash
node scripts/generate.mjs
```

The script runs Gradle when its inputs or published outputs have changed, then
publishes the generated client into `../api-client` and server bindings into
`../api-server`.

### Build scripts layout

The build tooling lives under `scripts/`, split into thin CLI entry points and
reusable modules:

```text
scripts/
  generate.mjs               # `npm run generate` — codegen + publish (main)
  verify-compatibility.mjs   # `npm run verify:compatibility -- --reference <ref>`
  compatibility-exceptions.json  # allowlist of accepted incompatible changes (verify:compatibility config)
  lib/
    paths.mjs                # package-root-anchored filesystem constants
    domains.mjs              # serverDomains + generated-projection paths
    fingerprint.mjs          # directory walk, input/output fingerprints, cache
    gradle.mjs               # launcher selection, wrapper/version integrity, Brazil
    publish.mjs              # publish client/server sources + manifest validation
    lifecycle.mjs            # signal-safe cleanup and the build lock
    subprocess.mjs           # spawn-result helpers shared by the verify commands
    compatibility.mjs        # compatibility-diff logic
```

The generation cache keys on a hash of the Gradle inputs, the Smithy model, and
every file under `scripts/`, so editing any script module forces a regenerate.
`scripts/compatibility-exceptions.json` is excluded from that hash — it is
verify:compatibility config, not a codegen input, so editing an exception does
not trigger regeneration.

### Bootstrap manifests

Generated source under `source/api-client` and `source/api-server` is ignored,
but their `package.json` files are committed. `npm ci` needs these manifests to
recognize both workspaces and install their locked dependencies before Smithy
generation runs.

The two packages differ in how the committed manifest is held to codegen:

- **client** — the manifest is generated: `scripts/generate.mjs` publishes the
  projection atomically, rewrites it for this npm-only repository, and requires
  the result to match the committed copy byte-for-byte;
- **server** — the manifest (and tsconfigs) are committed source:
  `validateServerManifest` checks them against what codegen requires and fails
  with an actionable error on drift.

Either way, if code generation changes package metadata or dependencies, update
the corresponding `package.json` and the root lockfile. The Smithy model remains
the source of truth for generated source.

## Run Gradle directly

To run only the Smithy and TypeScript code generation from this directory:

```bash
./gradlew build
```

On Windows:

```bat
gradlew.bat build
```

Under Brazil, use PeruGradle's launcher because the build fleet cannot download
the Gradle distribution from `services.gradle.org`:

```bash
run-gradlew build
```

The public Gradle wrapper ultimately invokes Java as follows:

```bash
"$JAVA_HOME/bin/java" \
  -classpath gradle/wrapper/gradle-wrapper.jar \
  org.gradle.wrapper.GradleWrapperMain build
```

The build requires the configured Java 21 toolchain. Generated files are written
under:

```text
build/smithyprojections/isb-api-model/aggregate/typescript-client-codegen
build/smithyprojections/isb-api-model/aggregate/openapi
build/smithyprojections/isb-api-model/server-<domain>/typescript-ssdk-codegen
```

### Expected generator warnings

Direct Gradle generation currently emits the following expected warnings. This
inventory covers Smithy validation and code generation only; it does not accept
or suppress API Gateway import warnings. The `failOnWarnings: true` disposable
import in Task 3.8c remains a separate, uncompleted cutover gate.

| Warning                                                                 | Why it is expected                                                                                                                                                                                                                                                                                                                                                    | When to act                                                                                                                                                                                         |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HttpMethodSemantics.MissingIdempotentTrait` for `UpdateBlueprint`      | The deployed contract uses legacy `PUT`, but the operation has PATCH-style optional fields. Each call performs a partial read-modify-write and refreshes `meta.lastEditTime`, so an ambiguous retry can perform another write or overwrite a concurrent edit. The operation is intentionally not marked `@idempotent`; its model documentation records the rationale. | Revisit only as a versioned contract/implementation change that makes retries genuinely idempotent. Do not add `@idempotent` merely to silence validation.                                          |
| `smithy.api#Long`: JavaScript numbers are IEEE-754                      | `Lease.ttl` is a Unix-epoch-seconds value. It must be `Long` because valid timestamps cross the signed 32-bit `Integer` ceiling in 2038; operational TTL values remain far below JavaScript's `Number.MAX_SAFE_INTEGER`. Handler tests cover values above the signed 32-bit ceiling.                                                                                  | Act if the API can emit a value above JavaScript's safe-integer ceiling. Do not narrow `ttl` to `Integer`; use an explicitly compatible representation if its range ever grows that large.          |
| `required member mode` is `strict`                                      | Each server projection deliberately sets `requiredMemberMode` to `strict`, so generated handlers cannot treat modeled `@required` members as `undefined`. The message is repeated once per server projection.                                                                                                                                                         | Treat removing `@required` as a breaking change and run compatibility verification. Do not weaken the generated server types merely to silence the warning.                                         |
| `No API Gateway integration trait found for ...`                        | The canonical OpenAPI is deployment-neutral and therefore has no `aws.apigateway#integration` traits. CDK's `prepareApiGatewaySpec` adds the six Lambda integrations in memory during synthesis. The message is repeated for every operation.                                                                                                                         | Act if an operation is absent from the CDK-prepared deployment document or maps to the wrong Lambda; do not add deployment-specific Lambda ARNs to the Smithy model.                                |
| `Adding schemas to the generated OpenAPI model directly ...` (`SEVERE`) | The OpenAPI plugin emits this generic Java logger message for every `jsonAdd` pointer beneath `/components/schemas`. All such entries in this project end in `/example`: they add documentation examples only, not schemas or constraints. Generated clients and servers do not need this documentation metadata.                                                     | Act if a `jsonAdd` entry beneath `/components/schemas` does anything other than add an `example`. Property examples are validated against the generated schemas by `test/openapi-examples.test.ts`. |

The unprefixed and bracketed copies of these messages are duplicate logger
renderings, not separate generation failures. A clean build currently reports
`WARNING: 1, NOTE: 1`; the warning is the documented `UpdateBlueprint`
idempotency decision, and the note is informational. Any additional warning or
`SEVERE` message is a signal to investigate. A successful projection ends with
`Completed projection`; Smithy validation errors fail the build.

## Gradle versus `scripts/generate.mjs`

Running Gradle directly is useful for debugging the Smithy model or code
generator, but it is not the complete repository generation workflow. Direct
Gradle execution does not:

- verify that the public and Brazil Gradle versions agree;
- verify the committed wrapper JAR against Gradle's published SHA-256;
- skip generation when the inputs and published output are unchanged;
- lock generation against concurrent processes;
- clear the previous Smithy projection before generation;
- restore files that `run-gradlew` modifies under Brazil;
- publish both packages atomically while preserving installed dependencies;
- rewrite the generated client manifest and validate the committed server
  manifest against codegen's requirements; or
- record both generated-output fingerprints used by the cache.

Use `npm run smithy:generate` or `node scripts/generate.mjs` when updating the
repository. Use the direct Gradle commands only when inspecting the raw
projection or diagnosing code generation.

## Verification

Run the API-model unit tests from this package:

```bash
npm test
```

This package-local command does not require Java. The repository-level
`npm test` first runs `smithy:prepare`, which generates and compiles both
ignored packages before Vitest resolves their imports. Unchanged generated
outputs skip Gradle; a clean checkout requires Java 21 for this
pre-test preparation. This is a local developer prerequisite; CodeBuild already
provides Corretto 21.

### Inspect the server bindings

The generated server package serves the entire `/leaseTemplates` domain in
production — all five operations (list, create, get, update, delete). The Lambda
is entirely Smithy-served: `@smithy/server-apigateway`'s `convertEvent` turns the
API Gateway event into an `HttpRequest`, the generated per-domain
`LeaseTemplatesApi` service handler routes and serializes, and the response is
converted back in the Lambda handler.
Every other API is still handwritten.

The two protocol behaviours that made the earlier pilot conclude the routes had to
stay handwritten — the generated deserializer dropping unknown members, and
malformed JSON serializing as `{}` with
`x-amzn-errortype: SerializationException` instead of the JSend `ValidationError`
— are resolved without a parallel protocol stack: the model validates what it can
express and Zod runs on top (in each create/update operation) for what it cannot
(`strictObject` unknown keys, refined formats), while a
`convert-to-isb-response` shim reshapes framework exceptions and maps the response to
the deployed `{statusCode, headers, body}` shape (fixing header casing). The
serializer's body is passed through, so its deviations from the deployed bytes
(members alphabetized, nulls dropped, timestamps normalized to milliseconds) are
accepted, as is the unmodified request (stricter restJson1 `Content-Type`/`Accept`/
typed-`maxResults` rules) — none is shimmed away.
See `source/common/lambda/smithy/` for that shim and
`source/lambdas/api/lease-templates/src/smithy/lease-template-operations.ts` for
the operations, and

```bash
npm test --workspace @amzn/innovation-sandbox-lease-templates -- \
  lease-templates-handler.test.ts
npm test --workspace @amzn/innovation-sandbox-commons -- \
  api-gateway-handler.test.ts
```

for the operation-boundary behavior and shared generated-pipeline error bridge.
The `test/model-parity/` suite in this package asserts that this model and the
persistence schema declare exactly the same members, which is what keeps the two
halves of the round trip from drifting (see `test/model-parity/README.md`).

### Compatibility verification

Compatibility verification is a manual check because it requires a Git checkout
with access to the reference branch or tag. Run it from this package or the
repository root, always naming the reference explicitly.

For a branch, a bare branch name or an explicit branch ref is accepted:

```bash
npm run smithy:verify:compatibility -- --reference dev/v1.3.1
npm run smithy:verify:compatibility -- --reference refs/heads/dev/v1.3.1
```

From the repository root, use the Smithy-prefixed entry point:

```bash
npm run smithy:verify:compatibility -- --reference dev/v1.3.1
```

For a tag, use the complete tag ref:

```bash
npm run smithy:verify:compatibility -- --reference refs/tags/v1.3.0
```

Bare names always mean branches, even when a tag has the same name. Requiring
`refs/tags/` avoids silently choosing between an identically named branch and
tag.

The command performs these steps:

1. Require `--reference <branch-or-tag>`; no environment or Git-upstream
   fallback is used.
2. Fetch that exact branch or tag into its canonical local ref.
3. Require the fetched reference tip to be an ancestor of `HEAD`. A stale
   candidate fails before reading either model.
4. Materialize the reference model with `git show`, without checking it out
   or using an unconstrained merge base.
5. Invoke the Smithy 1.72.0 CLI pinned by `gradle.properties` and reject
   `DANGER` and `ERROR` compatibility events.

If the reference branch or tag does not yet contain
`source/api-model/src/main/smithy`, verification reports that there is no prior
baseline and skips only the diff.

Incompatible changes fail unless `compatibility-exceptions.json` contains an
exact event `id` and `shape`, a concrete reason, and an unexpired ISO date.
Expired, broad, duplicate, and unused exceptions fail verification. Exceptions
are temporary review artifacts, not a way to redefine compatibility policy.

## Update Gradle

A Gradle update changes four files that must stay synchronized:

```text
gradle/wrapper/gradle-wrapper.properties
gradle/wrapper/gradle-wrapper.jar
gradle/wrapper/gradle-wrapper.jar.sha256
gradle-version
```

From this directory:

1. Regenerate the public wrapper for the selected version:

   ```bash
   ./gradlew wrapper --gradle-version <version> --distribution-type bin
   ```

2. Set `distributionSha256Sum` in `gradle-wrapper.properties` to Gradle's
   published SHA-256 for `gradle-<version>-bin.zip`.
3. Replace `gradle-wrapper.jar.sha256` with Gradle's published
   `gradle-<version>-wrapper.jar.sha256` value. Confirm the committed jar
   matches it:

   ```bash
   printf '%s  %s\n' "$(cat gradle/wrapper/gradle-wrapper.jar.sha256)" \
     gradle/wrapper/gradle-wrapper.jar | sha256sum --check
   ```

4. Update the Brazil selector:

   ```bash
   brazil-build --update-gradle-version
   ```

   This command updates only `gradle-version`; it does not regenerate or
   checksum the public wrapper.

5. Run `node scripts/generate.mjs`, `npm test`, and the manual compatibility
   command with the intended reference branch or tag before committing all four
   files together.

The verifier accepts Brazil resolving a patch release and using the `-all`
distribution while the public wrapper uses `-bin`, but it rejects a
minor-version mismatch, wrapper-JAR tampering, and invalid or missing
checksums.
