$version: "2"

namespace com.amazon.isb

use aws.protocols#restJson1

// Per-domain service for the configurations Lambda. It binds only this domain's
// operations, so the generated `ConfigurationsApiService` types the Lambda's
// handler to exactly these — while the aggregate `IsbApi` (main.smithy) binds the
// same operations for the shared client/OpenAPI.
//
// Server-only: this service feeds only the `server-configurations` SSDK projection.
// It deliberately omits the `@service` (sdkId) and `@sigv4` traits that `IsbApi`
// carries — a client/CLI must be generated from the aggregate `IsbApi`, never from a
// per-domain service (auth is enforced by middleware ahead of the Smithy handler).
//
// Section-dependent bodies: `PUT /configurations/{section}` and
// `GET /configurations/{section}` vary their body/response by the section, which a
// single `{section}`-labelled operation cannot type. Each section is therefore its
// own operation on a literal path (`/configurations/leases`, …) — wire-identical to
// the pre-Smithy contract (the client already sends the concrete path), but fully
// typed in and out. Field-level validation the model cannot express — strict
// unknown-key rejection, the `leases` cross-field rule, and the `notification`
// SES `emailFrom` verification — stays in each operation's Zod re-parse of
// `ConfigPutBodySchemas[section]`, exactly as the Lease Templates domain does.
@restJson1
@title("Innovation Sandbox on AWS — Configurations")
service ConfigurationsApi {
    version: "2026-07-31"
    operations: [
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
    ]
    errors: [
        ValidationError
        UnauthenticatedError
        AccessDeniedError
        InternalServerError
    ]
}

// ---------------------------------------------------------------------------
// Aggregate read
// ---------------------------------------------------------------------------
/// Returns every configuration section plus the deploy-time fields the settings
/// UI needs. A never-saved section is returned with its code-default field values,
/// a null `lastSavedBy`, and no `meta`.
@http(method: "GET", uri: "/configurations", code: 200)
@readonly
@tags(["configurations"])
operation GetConfigurations {
    output := {
        @required
        status: JSendStatus

        @required
        data: AdminConfiguration
    }
}

// ---------------------------------------------------------------------------
// Per-section operations
// ---------------------------------------------------------------------------
// Each section is a literal path. `UpdateXConfiguration` is @idempotent (PUT
// replaces the section) and carries the optional `meta` whose `lastEditTime` is the
// optimistic-concurrency token: a mismatch against the stored value is a 409
// (ConflictError). `lastSavedBy` is server-owned — the handler strips any supplied
// value — so it is absent from the writable input.
/// Reads the `leases` configuration section: its current values (or code
/// defaults if never saved) plus the `lastSavedBy` audit field. Fails fast with
/// 500 if the stored record fails schema validation (unlike `GetConfigurations`,
/// which skips invalid sections). Accessible by Admin, Manager, and User roles.
@http(method: "GET", uri: "/configurations/leases", code: 200)
@readonly
@tags(["configurations"])
operation GetLeasesConfiguration {
    output := with [LeasesConfigurationOutputMixin] {}
}

/// Replaces the `leases` configuration section. All configuration fields are
/// required, including `groupAssignmentMode`. Existing records that predate this
/// field are read as `NONE`, and the next save persists that value. Uses optimistic
/// concurrency: echo `meta.lastEditTime` from a prior read to detect a concurrent
/// edit (409 `ConflictError` on mismatch);
/// omit it on the first save. M2M callers are rejected with 403 — the audit trail
/// requires a human email identity. Admin role only.
@examples([
    {
        title: "Save the leases configuration"
        input: {
            requireMaxBudget: true
            maxBudget: 100
            requireMaxDuration: true
            maxDurationHours: 168
            maxLeasesPerUser: 3
            ttl: 30
            allowUserLeaseTermination: true
            leaseRequestWindowHours: 168
            maxLeaseRequestsPerWindow: 10
            leaseSharingEnabled: false
            enablePrincipalSearch: true
            groupAssignmentMode: "NONE"
            allowPredictiveBudgetControls: false
            serviceBreakdownEnabled: false
            allowBedrockTokenMonitoring: false
            meta: { lastEditTime: "2026-04-04T12:30:00.000Z" }
        }
        output: {
            status: "success"
            data: {
                requireMaxBudget: true
                maxBudget: 100
                requireMaxDuration: true
                maxDurationHours: 168
                maxLeasesPerUser: 3
                ttl: 30
                allowUserLeaseTermination: true
                leaseRequestWindowHours: 168
                maxLeaseRequestsPerWindow: 10
                leaseSharingEnabled: false
                enablePrincipalSearch: true
                groupAssignmentMode: "NONE"
                allowPredictiveBudgetControls: false
                serviceBreakdownEnabled: false
                allowBedrockTokenMonitoring: false
                lastSavedBy: "admin@example.com"
                meta: { createdTime: "2026-04-04T12:30:00.000Z", lastEditTime: "2026-04-04T12:30:00.000Z" }
            }
        }
    }
    {
        title: "Concurrent-edit conflict"
        input: {
            requireMaxBudget: true
            maxBudget: 100
            requireMaxDuration: true
            maxDurationHours: 168
            maxLeasesPerUser: 3
            ttl: 30
            allowUserLeaseTermination: true
            leaseRequestWindowHours: 168
            maxLeaseRequestsPerWindow: 10
            leaseSharingEnabled: false
            enablePrincipalSearch: true
            groupAssignmentMode: "ALL"
            allowPredictiveBudgetControls: false
            serviceBreakdownEnabled: false
            allowBedrockTokenMonitoring: false
            meta: { lastEditTime: "2026-04-04T12:30:00.000Z" }
        }
        error: {
            shapeId: ConflictError
            content: {
                status: "fail"
                data: {
                    errors: [
                        {
                            message: "Configuration was modified by another administrator. Reload to see the latest values."
                        }
                    ]
                }
            }
        }
    }
])
@http(method: "PUT", uri: "/configurations/leases", code: 200)
@idempotent
@tags(["configurations"])
operation UpdateLeasesConfiguration {
    input := with [LeasesConfigMixin, ConfigurationWriteEnvelopeMixin] {}
    output := with [LeasesConfigurationOutputMixin] {}
    errors: [
        ConflictError
        UnsupportedMediaTypeError
    ]
}

/// Reads the `cleanup` configuration section: its current values (or code
/// defaults if never saved) plus the `lastSavedBy` audit field. Fails fast with
/// 500 if the stored record fails schema validation (unlike `GetConfigurations`,
/// which skips invalid sections). Accessible by Admin, Manager, and User roles.
@http(method: "GET", uri: "/configurations/cleanup", code: 200)
@readonly
@tags(["configurations"])
operation GetCleanupConfiguration {
    output := with [CleanupConfigurationOutputMixin] {}
}

/// Replaces the `cleanup` configuration section (full replacement — every section
/// field is required). Uses optimistic concurrency: echo `meta.lastEditTime` from
/// a prior read to detect a concurrent edit (409 `ConflictError` on mismatch);
/// omit it on the first save. M2M callers are rejected with 403 — the audit trail
/// requires a human email identity. Admin role only.
@http(method: "PUT", uri: "/configurations/cleanup", code: 200)
@idempotent
@tags(["configurations"])
operation UpdateCleanupConfiguration {
    input := with [CleanupConfigMixin, ConfigurationWriteEnvelopeMixin] {}
    output := with [CleanupConfigurationOutputMixin] {}
    errors: [
        ConflictError
        UnsupportedMediaTypeError
    ]
}

/// Reads the `notification` configuration section: its current values (or code
/// defaults if never saved) plus the `lastSavedBy` audit field. Fails fast with
/// 500 if the stored record fails schema validation (unlike `GetConfigurations`,
/// which skips invalid sections). Accessible by Admin, Manager, and User roles.
@http(method: "GET", uri: "/configurations/notification", code: 200)
@readonly
@tags(["configurations"])
operation GetNotificationConfiguration {
    output := with [NotificationConfigurationOutputMixin] {}
}

/// Replaces the `notification` configuration section (full replacement — every
/// section field is required). Uses optimistic concurrency: echo `meta.lastEditTime`
/// from a prior read to detect a concurrent edit (409 `ConflictError` on mismatch);
/// omit it on the first save. M2M callers are rejected with 403 — the audit trail
/// requires a human email identity. Admin role only.
@http(method: "PUT", uri: "/configurations/notification", code: 200)
@idempotent
@tags(["configurations"])
operation UpdateNotificationConfiguration {
    input := with [NotificationConfigMixin, ConfigurationWriteEnvelopeMixin] {}
    output := with [NotificationConfigurationOutputMixin] {}
    errors: [
        ConflictError
        UnsupportedMediaTypeError
    ]
}

/// Reads the `maintenance` configuration section: its current values (or code
/// defaults if never saved) plus the `lastSavedBy` audit field. Fails fast with
/// 500 if the stored record fails schema validation (unlike `GetConfigurations`,
/// which skips invalid sections). Accessible by Admin, Manager, and User roles.
@http(method: "GET", uri: "/configurations/maintenance", code: 200)
@readonly
@tags(["configurations"])
operation GetMaintenanceConfiguration {
    output := with [MaintenanceConfigurationOutputMixin] {}
}

/// Replaces the `maintenance` configuration section (full replacement — every
/// section field is required). Uses optimistic concurrency: echo `meta.lastEditTime`
/// from a prior read to detect a concurrent edit (409 `ConflictError` on mismatch);
/// omit it on the first save. M2M callers are rejected with 403 — the audit trail
/// requires a human email identity. Admin role only.
@http(method: "PUT", uri: "/configurations/maintenance", code: 200)
@idempotent
@tags(["configurations"])
operation UpdateMaintenanceConfiguration {
    input := with [MaintenanceConfigMixin, ConfigurationWriteEnvelopeMixin] {}
    output := with [MaintenanceConfigurationOutputMixin] {}
    errors: [
        ConflictError
        UnsupportedMediaTypeError
    ]
}

/// Reads the `termsOfService` configuration section: its current values (or code
/// defaults if never saved) plus the `lastSavedBy` audit field. Fails fast with
/// 500 if the stored record fails schema validation (unlike `GetConfigurations`,
/// which skips invalid sections). Accessible by Admin, Manager, and User roles.
@http(method: "GET", uri: "/configurations/termsOfService", code: 200)
@readonly
@tags(["configurations"])
operation GetTermsOfServiceConfiguration {
    output := with [TermsOfServiceConfigurationOutputMixin] {}
}

/// Replaces the `termsOfService` configuration section (full replacement — every
/// section field is required). Uses optimistic concurrency: echo `meta.lastEditTime`
/// from a prior read to detect a concurrent edit (409 `ConflictError` on mismatch);
/// omit it on the first save. M2M callers are rejected with 403 — the audit trail
/// requires a human email identity. Admin role only.
@http(method: "PUT", uri: "/configurations/termsOfService", code: 200)
@idempotent
@tags(["configurations"])
operation UpdateTermsOfServiceConfiguration {
    input := with [TermsOfServiceConfigMixin, ConfigurationWriteEnvelopeMixin] {}
    output := with [TermsOfServiceConfigurationOutputMixin] {}
    errors: [
        ConflictError
        UnsupportedMediaTypeError
    ]
}

/// Reads the `costReporting` configuration section: its current values (or code
/// defaults if never saved) plus the `lastSavedBy` audit field. Fails fast with
/// 500 if the stored record fails schema validation (unlike `GetConfigurations`,
/// which skips invalid sections). Accessible by Admin, Manager, and User roles.
@http(method: "GET", uri: "/configurations/costReporting", code: 200)
@readonly
@tags(["configurations"])
operation GetCostReportingConfiguration {
    output := with [CostReportingConfigurationOutputMixin] {}
}

/// Replaces the `costReporting` configuration section (full replacement — every
/// section field is required). Uses optimistic concurrency: echo `meta.lastEditTime`
/// from a prior read to detect a concurrent edit (409 `ConflictError` on mismatch);
/// omit it on the first save. M2M callers are rejected with 403 — the audit trail
/// requires a human email identity. Admin role only.
@http(method: "PUT", uri: "/configurations/costReporting", code: 200)
@idempotent
@tags(["configurations"])
operation UpdateCostReportingConfiguration {
    input := with [CostReportingConfigMixin, ConfigurationWriteEnvelopeMixin] {}
    output := with [CostReportingConfigurationOutputMixin] {}
    errors: [
        ConflictError
        UnsupportedMediaTypeError
    ]
}

/// Reads the `agent` configuration section: its current values (or code defaults
/// if never saved) plus the `lastSavedBy` audit field. Governs the Sandbox Spaces
/// chat feature and its per-principal token budget.
@http(method: "GET", uri: "/configurations/agent", code: 200)
@readonly
@tags(["configurations"])
operation GetAgentConfiguration {
    output := with [AgentConfigurationOutputMixin] {}
}

/// Replaces the `agent` configuration section. Uses optimistic concurrency:
/// echo `meta.lastEditTime` from a prior read to detect a concurrent edit (409
/// `ConflictError` on mismatch); omit it on the first save. Admin role only.
@examples([
    {
        title: "Save the agent configuration"
        input: { sandboxSpacesEnabled: true }
        output: {
            status: "success"
            data: { sandboxSpacesEnabled: true, lastSavedBy: "admin@example.com" }
        }
    }
])
@http(method: "PUT", uri: "/configurations/agent", code: 200)
@idempotent
@tags(["configurations"])
operation UpdateAgentConfiguration {
    input := with [AgentConfigMixin, ConfigurationWriteEnvelopeMixin] {}
    output := with [AgentConfigurationOutputMixin] {}
    errors: [
        ConflictError
        UnsupportedMediaTypeError
    ]
}

// ---------------------------------------------------------------------------
// Aggregate shape
// ---------------------------------------------------------------------------
/// The full configuration the settings UI loads: every section (each with its
/// audit fields) plus the deploy-time fields resolved outside the config store.
structure AdminConfiguration {
    @required
    leases: LeasesConfiguration

    @required
    cleanup: CleanupConfiguration

    @required
    notification: NotificationConfiguration

    @required
    maintenance: MaintenanceConfiguration

    @required
    termsOfService: TermsOfServiceConfiguration

    @required
    costReporting: CostReportingConfiguration

    @required
    agent: AgentConfiguration

    /// Regions the account pool is configured to manage.
    // Resolved from the AccountPoolConfig SSM parameter, not the config store.
    @required
    isbManagedRegions: RegionList

    @required
    awsAccessPortalUrl: String

    /// Bedrock inference profile patterns from the Account Pool deploy parameter; empty when unset.
    @required
    bedrockInferenceProfilePatterns: BedrockInferenceProfilePatternList
}

list RegionList {
    member: String
}

list BedrockInferenceProfilePatternList {
    member: String
}

// ---------------------------------------------------------------------------
// Shared audit shapes
// ---------------------------------------------------------------------------
/// Server-owned audit envelope echoed on each section. A never-saved section has
/// no `lastSavedBy`: the member is simply absent on the wire.
/// `meta` is absent until the section has been saved at least once — but when
/// present it always carries both timestamps.
// A never-saved `lastSavedBy` is emitted as `undefined` (not an explicit null) so
// the member is absent on the wire; the frontend re-coalesces it to `null`.
@mixin
structure ConfigurationAuditMixin {
    /// Email of the last administrator to save the section, or a `system:` sentinel.
    // `@sensitive` so the generated client's logger redacts the admin address.
    lastSavedBy: SensitiveEmail

    meta: ConfigurationResponseMetadata
}

/// Optimistic-concurrency envelope accepted on a section write. Only
/// `meta.lastEditTime` is read (the concurrency token); the server derives the rest.
/// `createdTime` is server-owned and is deliberately NOT part of the write contract;
/// `lastSavedBy` is server-owned and stripped if supplied.
@mixin
structure ConfigurationWriteEnvelopeMixin {
    meta: ConfigurationWriteMetadata
}

/// Response metadata. Both timestamps are `@required`: a saved section always
/// carries both, and a partial `meta` must never be sent back — a `meta` missing
/// `lastEditTime` would drop the concurrency token and silently downgrade the next
/// write to a first-save.
// The store writes both timestamps together. `schemaVersion` is a persistence
// concern, intentionally not on the wire.
//
// The timestamps are opaque ISO 8601 strings, NOT `Timestamp`s, on purpose:
// `lastEditTime` is the optimistic-concurrency token the store compares by exact
// string equality (`#meta.#lastEditTime = :expected`). Modeling it as a
// `Timestamp` would round-trip the value through a `Date` on read and write, and
// the serializer's canonical form can differ from the stored string (e.g. a
// dropped `.000` millisecond fraction) — making a write's echoed token mismatch
// the stored one and 409 spuriously. As opaque strings both pass through
// byte-for-byte.
structure ConfigurationResponseMetadata {
    @required
    createdTime: String

    /// The optimistic-concurrency token: a write must echo the value it last read,
    /// or the store rejects it with a 409. Opaque — echoed back unchanged.
    @required
    lastEditTime: String
}

/// Write-side metadata: only the optimistic-concurrency token. `createdTime` is
/// server-owned and excluded; a first save omits `lastEditTime` entirely.
structure ConfigurationWriteMetadata {
    lastEditTime: String
}

/// An email address (or a `system:` sentinel for `lastSavedBy`).
// `@sensitive` so the generated client's logger middleware redacts it rather than
// emitting the address in cleartext logs.
@sensitive
string SensitiveEmail

// ---------------------------------------------------------------------------
// Section field mixins (writable fields) and their read structures
// ---------------------------------------------------------------------------
// Each section has a `<Section>ConfigMixin` of writable fields (the PUT input and
// the read structure share it) and a `<Section>Configuration` read structure that
// adds the audit fields. The output mixins carry the `data` envelope so every
// section operation shares one output shape.
/// Lease request/budget/duration policy.
@mixin
structure LeasesConfigMixin {
    @required
    requireMaxBudget: Boolean

    @required
    @range(min: 0, max: 1000000000)
    maxBudget: Integer

    @required
    requireMaxDuration: Boolean

    @required
    @range(min: 0, max: 87600)
    maxDurationHours: Integer

    @required
    @range(min: 1)
    maxLeasesPerUser: Integer

    /// Number of days the solution stores expired lease records before purging
    /// them.
    @required
    @range(min: 1, max: 3650)
    ttl: Integer

    /// Whether users can self-terminate their own active leases.
    @required
    allowUserLeaseTermination: Boolean

    /// Rolling window duration (hours) for rate-limiting lease requests.
    // The cross-field rule (`<= ttl * 24`) is inexpressible in Smithy and enforced
    // by the operation's Zod re-parse.
    @required
    @range(min: 1)
    leaseRequestWindowHours: Integer

    /// Maximum number of leases a user can request within the rolling window.
    @required
    @range(min: 1)
    maxLeaseRequestsPerWindow: Integer

    /// Whether the multi-user lease-sharing feature is globally enabled.
    @required
    leaseSharingEnabled: Boolean

    /// Whether the `GET /principals/search` typeahead API is available.
    @required
    enablePrincipalSearch: Boolean

    /// Controls whether IDC groups can be selected for lease assignments.
    /// Existing stored configurations that predate this policy are read as `NONE`.
    /// Existing group assignments are retained when set to `NONE`.
    @required
    groupAssignmentMode: GroupAssignmentMode

    /// Predictive Budget Controls feature gate: allows templates and leases to
    /// opt into spend-rate limits, cost projection and predicted-cost thresholds.
    @required
    allowPredictiveBudgetControls: Boolean

    /// Whether per-service cost breakdown is collected.
    @required
    serviceBreakdownEnabled: Boolean

    /// Feature gate for monitored Bedrock token cost tracking.
    @required
    allowBedrockTokenMonitoring: Boolean
}

structure LeasesConfiguration with [LeasesConfigMixin, ConfigurationAuditMixin] {}

enum GroupAssignmentMode {
    /// New associations may be created for any IDC group.
    ALL

    /// New IDC group-to-lease associations are disabled.
    NONE
}

/// Account cleanup retry/validation policy.
@mixin
structure CleanupConfigMixin {
    @required
    @range(min: 1)
    numberOfFailedAttemptsToCancelCleanup: Integer

    @required
    @range(min: 1)
    waitBeforeRetryFailedAttemptSeconds: Integer

    @required
    @range(min: 1)
    numberOfSuccessfulAttemptsToFinishCleanup: Integer

    @required
    @range(min: 1)
    waitBeforeRerunSuccessfulAttemptSeconds: Integer

    @required
    validation: CleanupValidation

    /// Hours to hold an account in the CleanUp OU after a successful cleanup before
    /// returning it to Available (`0` = disabled; max 8640 = 360 days).
    @required
    @range(min: 0, max: 8640)
    cooldownPeriodHours: Integer

    // Records are stored in DynamoDB (implementation note).
    /// Days to retain cleanup reports.
    @required
    @range(min: 14, max: 3650)
    reportRetentionDays: Integer
}

structure CleanupValidation {
    /// Action taken when post-cleanup Resource Explorer validation finds resources
    /// remaining in the account.
    @required
    failureAction: CleanupFailureAction
}

enum CleanupFailureAction {
    QUARANTINE = "Quarantine"
    WARN = "Warn"
    SILENT = "Silent"
}

structure CleanupConfiguration with [CleanupConfigMixin, ConfigurationAuditMixin] {}

/// Notification delivery: which channels are active and the SES sender.
@mixin
structure NotificationConfigMixin {
    /// From address used for SES notification emails; an empty string leaves
    /// SES unable to deliver even when `sesEnabled` is true.
    // The email format and SES identity verification are enforced by the
    // operation, not the model. `@sensitive` (via `SensitiveEmail`) so the
    // generated client redacts it.
    @required
    @length(max: 254)
    emailFrom: SensitiveEmail

    /// Whether SES email delivery is enabled. Defaults to true when not configured.
    @required
    sesEnabled: Boolean

    /// Whether publishing to the shared SNS integration topic is enabled.
    /// Defaults to false when not configured.
    @required
    snsIntegrationTopicEnabled: Boolean
}

structure NotificationConfiguration with [NotificationConfigMixin, ConfigurationAuditMixin] {}

/// Maintenance-mode toggle.
@mixin
structure MaintenanceConfigMixin {
    /// When true, prevents creation of new leases. Fresh installs default to true.
    @required
    enabled: Boolean
}

structure MaintenanceConfiguration with [MaintenanceConfigMixin, ConfigurationAuditMixin] {}

/// Terms-of-service content shown at sign-in.
@mixin
structure TermsOfServiceConfigMixin {
    /// Terms-of-service text displayed to users before requesting a lease.
    @required
    @length(max: 10000)
    content: String
}

structure TermsOfServiceConfiguration with [TermsOfServiceConfigMixin, ConfigurationAuditMixin] {}

/// Cost-report grouping policy.
@mixin
structure CostReportingConfigMixin {
    /// Valid cost-report-group values selectable on lease templates.
    @required
    costReportGroups: CostReportGroupList

    /// Whether a cost report group is required on lease templates.
    @required
    requireCostReportGroup: Boolean
}

@length(max: 250)
list CostReportGroupList {
    member: CostReportGroup
}

@length(min: 1, max: 50)
string CostReportGroup

structure CostReportingConfiguration with [CostReportingConfigMixin, ConfigurationAuditMixin] {}

@mixin
structure AgentConfigMixin {
    /// Global Sandbox Spaces capability. `true` turns the feature on for
    /// every role with an active lease (still subject to the enabled-model
    /// catalog gate); `false` turns it off entirely.
    @required
    sandboxSpacesEnabled: Boolean
}

structure AgentConfiguration with [AgentConfigMixin, ConfigurationAuditMixin] {}

// Output-envelope mixins: one per section so the read/update operations share a
// single `{status, data}` output shape typed to that section.
@mixin
structure LeasesConfigurationOutputMixin {
    @required
    status: JSendStatus

    @required
    data: LeasesConfiguration
}

@mixin
structure CleanupConfigurationOutputMixin {
    @required
    status: JSendStatus

    @required
    data: CleanupConfiguration
}

@mixin
structure NotificationConfigurationOutputMixin {
    @required
    status: JSendStatus

    @required
    data: NotificationConfiguration
}

@mixin
structure MaintenanceConfigurationOutputMixin {
    @required
    status: JSendStatus

    @required
    data: MaintenanceConfiguration
}

@mixin
structure TermsOfServiceConfigurationOutputMixin {
    @required
    status: JSendStatus

    @required
    data: TermsOfServiceConfiguration
}

@mixin
structure CostReportingConfigurationOutputMixin {
    @required
    status: JSendStatus

    @required
    data: CostReportingConfiguration
}

@mixin
structure AgentConfigurationOutputMixin {
    @required
    status: JSendStatus

    @required
    data: AgentConfiguration
}

// ---------------------------------------------------------------------------
// Agent Model Catalog — GET + PUT (upsert)
// ---------------------------------------------------------------------------
/// Returns all agent-model catalog rows, enabled and disabled, for the Admin
/// Settings table and for lease-template model selection.
/// Pricing rate fields are optional — present if provided during initial
/// catalog entry creation or populated later.
/// Readable by every role; only Admin may change a row.
@http(method: "GET", uri: "/configurations/agent/models", code: 200)
@readonly
@tags(["configurations"])
@paginated(inputToken: "nextToken", outputToken: "data.nextToken", pageSize: "maxResults", items: "data.models")
operation ListAgentModelCatalog {
    input := {
        /// Pagination cursor from a previous response. Omit to start from the beginning.
        @httpQuery("nextToken")
        nextToken: String

        /// Maximum number of models to return per page. Omit for the default page size.
        /// Clients must follow `nextToken` until absent to retrieve the full catalog.
        @httpQuery("maxResults")
        @range(min: 1, max: 500)
        maxResults: Integer
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: AgentModelCatalogData
    }
}

/// Creates a Bedrock model catalog entry or updates its enabled state.
/// When creating an entry, omit `expectedLastEditTime` and provide `modelType`.
/// The service looks the model up in Amazon Bedrock as that type and stores its
/// canonical metadata.
/// When updating an existing entry, provide its current `meta.lastEditTime` and
/// omit `modelType`; the operation updates only its enabled state.
@http(method: "PUT", uri: "/configurations/agent/models/{modelId}", code: 200)
@idempotent
@tags(["configurations"])
operation PutAgentModelCatalogEntry {
    input := {
        @required
        @httpLabel
        modelId: String

        /// Whether this model is available in the chat UI.
        @required
        enabled: Boolean

        /// OCC token from the prior read's `meta.lastEditTime`.
        /// Omit on the first call; required on subsequent calls.
        expectedLastEditTime: String

        /// Whether `modelId` is a foundation model or an inference profile.
        /// Required when creating an entry; rejected when updating one.
        modelType: AgentModelType
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: AgentModelCatalogEntry
    }

    errors: [
        ConflictError
    ]
}

// ---------------------------------------------------------------------------
// Agent Model Catalog shapes
// ---------------------------------------------------------------------------
/// The `data` payload of `GET /configurations/agent/models`.
structure AgentModelCatalogData {
    @required
    models: AgentModelCatalogList

    /// Present only when additional pages exist.
    nextToken: String
}

list AgentModelCatalogList {
    member: AgentModelCatalogEntry
}

/// A single catalog row as returned by the configurations API.
structure AgentModelCatalogEntry {
    @required
    modelId: String

    @required
    displayName: String

    @required
    provider: String

    /// Geographic availability prefix: `"global"`, `"us"`, `"eu"`, etc.
    /// Kept as String — derived from Bedrock's inferenceProfileId prefix; open-ended
    /// as AWS adds new profile regions over time.
    @required
    availability: String

    description: String

    /// Whether this entry is a foundation model or a system-defined inference profile.
    modelType: AgentModelType

    /// ID of the foundation model this entry invokes; a foundation model's own ID.
    foundationModelId: String

    /// Name of the foundation model this entry invokes.
    foundationModelName: String

    /// How the rates were sourced.
    pricingSource: AgentModelPricingSource

    /// ISO 8601 instant of the last pricing refresh.
    pricingRefreshedAt: String

    inputPricePer1KTokens: Double

    outputPricePer1KTokens: Double

    cacheReadPricePer1KTokens: Double

    cacheWritePricePer1KTokens: Double

    /// Whether this model is available for selection in the chat UI.
    @required
    enabled: Boolean

    /// ISO 8601 instant when this model was first added to the catalog.
    @required
    addedAt: String

    /// Email of the admin who last toggled this entry.
    @required
    lastSavedBy: SensitiveEmail

    /// OCC envelope. Present on every catalog row.
    @required
    meta: ConfigurationResponseMetadata
}
