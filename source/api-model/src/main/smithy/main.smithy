$version: "2"

namespace com.amazon.isb

use aws.api#service
use aws.auth#sigv4
use aws.protocols#restJson1

// Model layout. The model is split across files, all merged by Smithy under
// `sources` by namespace:
//   - `common.smithy` — the JSend envelope, shared errors, and shared scalars
//     (`ContinuationToken`, `OwnerEmail`);
//   - `<domain>.smithy` (e.g. `lease-templates.smithy`) — each domain's operations,
//     shapes, and its per-domain service shape (e.g. `LeaseTemplatesApi`);
//   - this file — the aggregate `IsbApi` service.
//
// Service topology. ISB runs a Lambda per domain, so each domain has its own
// service shape whose generated `<Domain>ApiService` interface types that Lambda's
// handler to only its operations. `IsbApi` is the aggregate service that lists every
// operation and drives the single client, OpenAPI document, and (later) CLI model.
// smithy-build.json therefore has one `aggregate` projection (client + OpenAPI on
// `IsbApi`) and one `server-<domain>` projection (SSDK on each domain service); see
// `scripts/generate.mjs` for how the per-domain server outputs merge into one package
// with a subpath per domain. Every operation must be listed in both its domain service and
// `IsbApi` — `aggregate-service-parity.test.ts` enforces that. (Contrast DeepRacer,
// which keeps ONE service + ONE Lambda and groups domains with Smithy `resource`
// shapes; ISB's per-domain-Lambda topology is why we diverge to per-domain services.)
// Implementation/migration notes (NOT customer-facing — kept out of the emitted
// OpenAPI `info.description`, which is sourced from the `///` doc below):
//   - Additive during migration: this model describes a subset of the pre-Smithy
//     contract and is not yet authoritative for it. CDK owns paths, methods, and
//     integrations; handlers and middleware own wire behavior; operations move
//     under this model one domain at a time.
//   - The JSend envelope is written by the generated `restJson1` serializer for
//     migrated domains (a boundary shim restores the pre-Smithy wire) and by the
//     Middy middleware in `source/common/lambda/middleware/` for the rest. It is
//     modeled explicitly so generated clients deserialize the real wire format.
//   - The non-standard wire names below predate current AWS naming conventions;
//     the v1.3.0 compatibility decision changed only `pageSize` to `maxResults`.
//     Standardizing the rest needs a coordinated, versioned API change.
// Wire-format notes:
//   - Every response body is a JSend envelope: `{ status, data }` on success and
//     `{ status, message?, data? }` on failure.
//   - Pagination and collection fields use the wire names `pageIdentifier`,
//     `nextPageIdentifier`, and `result`; resource identifiers use `uuid`. The
//     page-size query parameter is `maxResults`.
/// Innovation Sandbox on AWS enables cloud administrators to automate the
/// management of temporary sandbox environments by implementing service
/// control policies, spend controls, and account recycling mechanisms.
///
/// The API is organized into these domains:
///
/// - **Accounts**: Register and manage sandbox accounts, cleanup runs, and
///   account lifecycle actions.
/// - **Blueprints**: Register and manage CloudFormation StackSet-backed
///   blueprints.
/// - **Configurations**: Read and update solution settings for leases, cleanup,
///   notifications, maintenance, terms of service, and cost reporting.
/// - **Leases**: Request and manage temporary sandbox access, lifecycle actions,
///   sharing, and principal assignments.
/// - **Lease templates**: Define the reusable budget, duration, blueprint, and
///   visibility settings used to request leases.
/// - **Permission sets**: Discover IAM Identity Center permission sets available
///   for lease permission profiles.
/// - **Principals**: Search IAM Identity Center users and groups for lease
///   assignments.
/// - **Sandbox Agent**: AI agent that lets users interact with their sandbox
///   account via natural language.
@service(sdkId: "Isb", arnNamespace: "execute-api")
@sigv4(name: "execute-api")
@restJson1
@title("Innovation Sandbox on AWS")
service IsbApi {
    // API-contract version (AWS-idiomatic fixed date). Reset manually and freeze
    // on release; it is not a build/release date and does not auto-change.
    version: "2026-08-25"
    operations: [
        ListLeaseTemplates
        CreateLeaseTemplate
        GetLeaseTemplate
        UpdateLeaseTemplate
        DeleteLeaseTemplate
        GetConfigurations
        GetLeasesConfiguration
        UpdateLeasesConfiguration
        GetCleanupConfiguration
        UpdateCleanupConfiguration
        GetNotificationConfiguration
        UpdateNotificationConfiguration
        GetMaintenanceConfiguration
        UpdateMaintenanceConfiguration
        GetTermsOfServiceConfiguration
        UpdateTermsOfServiceConfiguration
        GetCostReportingConfiguration
        UpdateCostReportingConfiguration
        GetAgentConfiguration
        UpdateAgentConfiguration
        ListAgentModelCatalog
        PutAgentModelCatalogEntry
        SearchPrincipals
        ListAccounts
        RegisterAccount
        GetAccount
        RetryCleanup
        EjectAccount
        QuarantineAccount
        ListUnregisteredAccounts
        ListCleanupReports
        SkipCooldown
        ListLeases
        RequestLease
        ListSharedLeases
        GetLease
        UpdateLease
        FreezeLease
        ReviewLease
        TerminateLease
        UnfreezeLease
        GetLeaseAssignments
        UpdateLeaseAssignments
        GetLeaseCostSummary
        GetLeaseCostHistory
        GetLeaseBedrockTokenHistory
        GetLeaseBreachHistory
        ListStackSets
        ListBlueprints
        RegisterBlueprint
        GetBlueprint
        UpdateBlueprint
        DeleteBlueprint
        ListPermissionSets
        ListAgentHistory
        GetSandboxSpacesUsage
        ListAgentModels
    ]
    errors: [
        ValidationError
        UnauthenticatedError
        AccessDeniedError
        InternalServerError
    ]
}
