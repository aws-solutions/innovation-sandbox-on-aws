$version: "2"

namespace com.amazon.isb

use aws.protocols#restJson1

// Per-domain service for the leaseTemplates Lambda. It binds only this domain's
// operations, so the generated `LeaseTemplatesApiService` types the Lambda's
// handler to exactly these five — while the aggregate `IsbApi` (main.smithy) binds
// the same operations for the shared client/OpenAPI.
//
// Server-only: this service feeds only the `server-lease-templates` SSDK projection.
// It deliberately omits the `@service` (sdkId) and `@sigv4` traits that `IsbApi`
// carries — a client/CLI must be generated from the aggregate `IsbApi`, never from a
// per-domain service (auth is enforced by middleware ahead of the Smithy handler).
@restJson1
@title("Innovation Sandbox on AWS — Lease Templates")
service LeaseTemplatesApi {
    version: "2026-07-31"
    operations: [
        ListLeaseTemplates
        CreateLeaseTemplate
        GetLeaseTemplate
        UpdateLeaseTemplate
        DeleteLeaseTemplate
    ]
    errors: [
        ValidationError
        UnauthenticatedError
        AccessDeniedError
        InternalServerError
    ]
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
/// Lists lease templates visible to the caller.
///
/// PRIVATE templates are filtered at the query layer for callers without the
/// Admin or Manager role, so neither the result set nor the pagination token
/// discloses a PRIVATE template's identifier.
@http(method: "GET", uri: "/leaseTemplates", code: 200)
@readonly
@tags(["leaseTemplates"])
// pageIdentifier/nextPageIdentifier are the pre-Smithy wire names, kept for backward compatibility (not renamed to nextToken).
@paginated(
    inputToken: "pageIdentifier"
    pageSize: "maxResults"
    outputToken: "data.nextPageIdentifier"
    items: "data.result"
)
operation ListLeaseTemplates {
    input := {
        // pageIdentifier's target is `@sensitive` because it encodes internal
        // identifiers. The nonstandard public name is retained from the pre-Smithy
        // contract.
        /// Opaque continuation token from a previous response. Server-owned;
        /// clients must not construct or interpret it.
        @httpQuery("pageIdentifier")
        pageIdentifier: ContinuationToken

        // Validation is performed by generated deserialization (a `restJson1` 400)
        // rather than the pre-Smithy Zod field error — an accepted deviation.
        /// Maximum page size. The operation defaults it to 2000 when absent. A
        /// non-numeric, out-of-range, or repeated value is rejected as a 400.
        @range(min: 1, max: 2000)
        @httpQuery("maxResults")
        maxResults: Integer
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: LeaseTemplatePage
    }
}

/// Creates a lease template.
///
/// Not idempotent: the identifier is generated server-side per invocation, so a
/// retried request creates a second template. Callers must not retry.
@http(method: "POST", uri: "/leaseTemplates", code: 201)
@tags(["leaseTemplates"])
@examples([
    {
        title: "Create a lease template"
        input: {
            name: "Example Template"
            description: "Example Template Description"
            requiresApproval: true
            visibility: "PUBLIC"
            maxSpend: 100
            leaseDurationInHours: 24
            budgetThresholds: [
                {
                    dollarsSpent: 80
                    action: "ALERT"
                }
            ]
            durationThresholds: [
                {
                    hoursRemaining: 12
                    action: "ALERT"
                }
            ]
            costReportGroup: "Engineering"
            blueprintId: "12345678-90ab-4cde-8f12-34567890abcd"
            allowOwnerToShareLease: false
            predictiveBudgetEnabled: false
            bedrockTokenMonitoringEnabled: false
            sandboxSpacesEnabled: false
        }
        output: {
            status: "success"
            data: {
                uuid: "12345678-90ab-4cde-8f12-34567890abcd"
                name: "Example Template"
                description: "Example Template Description"
                requiresApproval: true
                createdBy: "user@example.com"
                visibility: "PUBLIC"
                maxSpend: 100
                budgetThresholds: [
                    {
                        dollarsSpent: 80
                        action: "ALERT"
                    }
                ]
                leaseDurationInHours: 24
                durationThresholds: [
                    {
                        hoursRemaining: 12
                        action: "ALERT"
                    }
                ]
                costReportGroup: "Engineering"
                blueprintId: "12345678-90ab-4cde-8f12-34567890abcd"
                blueprintName: "Web-Application-Blueprint"
                allowOwnerToShareLease: false
                predictiveBudgetEnabled: false
                bedrockTokenMonitoringEnabled: false
                sandboxSpacesEnabled: false
                meta: { createdTime: "2023-05-01T12:00:00Z", lastEditTime: "2023-05-01T12:00:00Z", schemaVersion: 1 }
            }
        }
    }
])
operation CreateLeaseTemplate {
    input := with [LeaseTemplateWritableMixin] {}

    output := {
        @required
        status: JSendStatus

        /// The created template, placed directly in `data` rather than under a
        /// further key.
        @required
        data: LeaseTemplate
    }

    errors: [
        ConflictError
        UnsupportedMediaTypeError
    ]
}

/// Retrieves a single lease template.
///
/// A PRIVATE template is reported as 404 rather than 403 to callers without the
/// Admin or Manager role, so the response does not disclose that the identifier
/// exists.
@http(method: "GET", uri: "/leaseTemplates/{leaseTemplateId}", code: 200)
@readonly
@tags(["leaseTemplates"])
operation GetLeaseTemplate {
    input := {
        /// Lease template UUID. The API Gateway path segment is named
        /// `leaseTemplateName`, but the value is the template's UUID, not its
        /// display name.
        @required
        @httpLabel
        leaseTemplateId: String
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: LeaseTemplate
    }

    errors: [
        NotFoundError
    ]
}

/// Replaces a lease template.
///
/// The body carries the full template, not a patch. `uuid`, `createdBy` and
/// `blueprintName` are server-owned and are not part of the writable input;
/// supplying them is rejected as an unknown member. `createdBy` is preserved
/// from the existing template on write.
///
/// Omitting `predictiveBudgetEnabled` keeps the stored value. A sent
/// `rateLimits` list replaces the stored list; a non-empty list requires
/// `predictiveBudgetEnabled`, and an empty list is always accepted. Omitting
/// `rateLimits` keeps the stored list while `predictiveBudgetEnabled` is true
/// and clears it otherwise. A `PREDICTED` budget threshold likewise requires
/// `predictiveBudgetEnabled`.
///
/// The write is conditioned on the template as read for validation; if it
/// changed in between, the update fails with ConflictError and is not applied.
@http(method: "PUT", uri: "/leaseTemplates/{leaseTemplateId}", code: 200)
@idempotent
@tags(["leaseTemplates"])
@examples([
    {
        title: "Replace a lease template"
        input: {
            leaseTemplateId: "12345678-90ab-4cde-8f12-34567890abcd"
            name: "Example Template"
            description: "Example Template Description"
            requiresApproval: true
            visibility: "PUBLIC"
            maxSpend: 100
            leaseDurationInHours: 24
            budgetThresholds: [
                {
                    dollarsSpent: 80
                    action: "ALERT"
                }
            ]
            durationThresholds: [
                {
                    hoursRemaining: 12
                    action: "ALERT"
                }
            ]
            costReportGroup: "Engineering"
            blueprintId: "12345678-90ab-4cde-8f12-34567890abcd"
            allowOwnerToShareLease: false
            predictiveBudgetEnabled: false
            bedrockTokenMonitoringEnabled: false
            sandboxSpacesEnabled: false
            meta: { createdTime: "2023-05-01T12:00:00Z", lastEditTime: "2023-05-01T12:00:00Z", schemaVersion: 1 }
        }
        output: {
            status: "success"
            data: {
                uuid: "12345678-90ab-4cde-8f12-34567890abcd"
                name: "Example Template"
                description: "Example Template Description"
                requiresApproval: true
                createdBy: "user@example.com"
                visibility: "PUBLIC"
                maxSpend: 100
                budgetThresholds: [
                    {
                        dollarsSpent: 80
                        action: "ALERT"
                    }
                ]
                leaseDurationInHours: 24
                durationThresholds: [
                    {
                        hoursRemaining: 12
                        action: "ALERT"
                    }
                ]
                costReportGroup: "Engineering"
                blueprintId: "12345678-90ab-4cde-8f12-34567890abcd"
                blueprintName: "Web-Application-Blueprint"
                allowOwnerToShareLease: false
                predictiveBudgetEnabled: false
                bedrockTokenMonitoringEnabled: false
                sandboxSpacesEnabled: false
                meta: { createdTime: "2023-05-01T12:00:00Z", lastEditTime: "2023-05-01T12:00:00Z", schemaVersion: 1 }
            }
        }
    }
])
operation UpdateLeaseTemplate {
    input := with [LeaseTemplateWritableBaseMixin] {
        /// Lease template UUID. The API Gateway path segment is named
        /// `leaseTemplateName`, but the value is the template's UUID, not its
        /// display name.
        @required
        @httpLabel
        leaseTemplateId: String

        // The store overrides `createdTime` from the persisted record, and omitting
        // `meta` also clears the persistence-only `schemaVersion` on the stored item.
        /// Accepted rather than ignored: the `meta` sent in the request is written
        /// back, overriding only `createdTime`. Omitting `meta` clears
        /// `lastEditTime`, so a client performing a read-modify-write must echo it
        /// back.
        meta: Metadata

        /// Permission set assigned when an assignment does not specify an override.
        defaultPermissionSetArn: PermissionSetArn

        /// Permission sets available for assignment overrides. The default is
        /// implicitly allowed and this list is capped at 20 entries.
        allowedPermissionSetArns: PermissionSetArnList

        /// Spend-rate limits, each with its own action. A non-empty list
        /// requires `predictiveBudgetEnabled`. When sent, it replaces the stored
        /// list. See the operation for omission rules.
        rateLimits: RateLimitList
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: LeaseTemplate
    }

    errors: [
        NotFoundError
        ConflictError
        UnsupportedMediaTypeError
    ]
}

// The pre-Smithy response body is `{"status":"success","data":null}`. Smithy
// cannot model a member whose only value is `null`, so `data` is absent from
// this output and restored at the Lambda boundary.
/// Deletes a lease template.
///
/// Idempotent: deleting a template that does not exist also returns success.
@http(method: "DELETE", uri: "/leaseTemplates/{leaseTemplateId}", code: 200)
@idempotent
@tags(["leaseTemplates"])
operation DeleteLeaseTemplate {
    input := {
        /// Lease template UUID. The API Gateway path segment is named
        /// `leaseTemplateName`, but the value is the template's UUID, not its
        /// display name.
        @required
        @httpLabel
        leaseTemplateId: String
    }

    // No operation-specific errors: deleting a missing template deliberately
    // returns success (idempotent), so this never produces a NotFoundError.
    output := {
        @required
        status: JSendStatus
    }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------
// The wire uses `result` and `nextPageIdentifier` rather than the more common
// `items` and `nextToken`, retained from the pre-Smithy contract.
/// Paginated payload. `nextPageIdentifier` is null on the final page.
structure LeaseTemplatePage {
    @required
    result: LeaseTemplateList

    // Its target is `@sensitive` so it stays out of generated-client logs.
    /// Opaque continuation token.
    nextPageIdentifier: ContinuationToken
}

list LeaseTemplateList {
    member: LeaseTemplate
}

@length(max: 20)
list PermissionSetArnList {
    member: PermissionSetArn
}

// These fields are `Double`, not integral: the persistence schema constrains
// them with `z.number().gt(0)` and does not require whole numbers, so an
// integral type would fail to deserialize a 1.5-hour value.
//
// Smithy gap: `@range` is inclusive-only, so it cannot express the pre-Smithy
// `.gt(0)` for a `Double` — `min: 1` wrongly rejects `0 < v < 1` and `min: 0`
// wrongly accepts `0`. The positivity bound is therefore left unmodeled here and
// enforced by the operation's Zod re-parse; these `Double` members carry no
// `@range`. (The re-parse repeats validation the model already ran; its
// per-request cost is negligible — see `smithy-migration.md` §5.)
/// Budget and duration settings shared by the template and its create input.
/// The hour and dollar fields accept fractional values, so a 1.5-hour template
/// is valid; each must be greater than zero.
@mixin
structure LeaseTemplateConfigMixin {
    // No `@range`: `.gt(0)` is not expressible (see the mixin doc); Zod enforces it.
    maxSpend: Double

    budgetThresholds: BudgetThresholdList

    // No `@range`: `.gt(0)` is not expressible (see the mixin doc); Zod enforces it.
    leaseDurationInHours: Double

    durationThresholds: DurationThresholdList

    @length(min: 1, max: 50)
    costReportGroup: String
}

// The pre-Smithy `PUT` parses the body with the same schema as `POST`, which is
// why the create and update inputs share this mixin.
/// The client-writable members of a lease template, shared by the create and
/// update inputs. Both accept the same set — requiredness and constraints are
/// identical and neither operation is a patch.
///
/// `uuid`, `createdBy` and `blueprintName` are deliberately absent — they are
/// server-owned.
@mixin
structure LeaseTemplateWritableBaseMixin with [LeaseTemplateConfigMixin] {
    @required
    @length(min: 1, max: 50)
    name: String

    description: String

    @required
    requiresApproval: Boolean

    visibility: Visibility

    /// Blueprint to attach. `blueprintName` is resolved server-side.
    blueprintId: String

    allowOwnerToShareLease: Boolean

    /// Opt-in: spend rates, cost projection, predicted-cost thresholds and caps.
    predictiveBudgetEnabled: Boolean

    /// Opt-in: monitored Bedrock token cost tracking. Must be true when
    /// `sandboxSpacesEnabled` is true.
    bedrockTokenMonitoringEnabled: Boolean

    /// Whether leases created from this template have Sandbox Spaces turned on.
    /// `true` requires `bedrockTokenMonitoringEnabled`; otherwise the request
    /// is rejected with 400.
    sandboxSpacesEnabled: Boolean

    /// Sandbox Spaces: subset of the globally enabled model IDs this template
    /// permits. Unset inherits the global enabled set.
    allowedModelIds: AgentModelIdList

    /// Sandbox Spaces: model preselected for new chats on leases from this
    /// template. Must be enabled and, when a subset is set, one of allowedModelIds.
    defaultModelId: String
}

/// Sandbox Spaces model-id subset permitted by a lease template (capped at 100).
@length(max: 100)
list AgentModelIdList {
    member: String
}

// Kept separate from the base mixin so update-input fields that predate
// permission profiles retain their generated member order.
/// Client-writable lease-template fields, including optional permission-profile
/// ARN configuration.
@mixin
structure LeaseTemplateWritableMixin with [LeaseTemplateWritableBaseMixin] {
    /// Permission set assigned when an assignment does not specify an override.
    defaultPermissionSetArn: PermissionSetArn

    /// Permission sets available for assignment overrides. The default is
    /// implicitly allowed and this list is capped at 20 entries.
    allowedPermissionSetArns: PermissionSetArnList

    /// Spend-rate limits, each with its own action. A non-empty list
    /// requires `predictiveBudgetEnabled`.
    rateLimits: RateLimitList
}

structure LeaseTemplate with [LeaseTemplateConfigMixin] {
    // "uuid" is the existing public field name; renaming it is a wire-compatibility
    // decision, not a persistence-type correction in the model.
    /// Unique identifier for the lease template.
    @required
    uuid: String

    @required
    @length(min: 1, max: 50)
    name: String

    description: String

    @required
    requiresApproval: Boolean

    // Its target is `@sensitive` so the generated client's logger middleware
    // redacts it rather than emitting the address in cleartext logs.
    /// Owner email.
    @required
    createdBy: OwnerEmail

    @required
    visibility: Visibility

    blueprintId: String

    /// Resolved from the blueprint store; not client-provided.
    blueprintName: String

    @required
    allowOwnerToShareLease: Boolean

    @required
    predictiveBudgetEnabled: Boolean

    @required
    bedrockTokenMonitoringEnabled: Boolean

    /// Snapshot used to determine Sandbox Spaces availability.
    sandboxSpacesEnabled: Boolean

    /// Sandbox Spaces: subset of globally enabled model IDs this template permits.
    allowedModelIds: AgentModelIdList

    /// Sandbox Spaces default model preselected for new chats.
    defaultModelId: String

    meta: Metadata

    /// Backend-hydrated metadata for the default permission set.
    defaultPermissionSet: PermissionSetReference

    /// Backend-hydrated metadata for the effective allowed set, including the
    /// default. Missing cache entries remain represented as UNAVAILABLE.
    allowedPermissionSets: PermissionSetReferenceList

    /// Spend-rate limits, each with its own action.
    rateLimits: RateLimitList
}

// `schemaVersion` is a persistence concern, but the pre-Smithy API currently
// returns it. It remains modeled during the additive migration so the
// generated-client pilot preserves the existing service boundary; removing it
// requires a coordinated contract change.
/// Server-owned record metadata.
structure Metadata {
    // `restJson1` serializes a bare Timestamp as epoch seconds, so the format is
    // declared explicitly to preserve the ISO 8601 strings the API returns.
    /// Time when the resource was created, as an ISO 8601 string.
    @timestampFormat("date-time")
    createdTime: Timestamp

    @timestampFormat("date-time")
    lastEditTime: Timestamp

    // Retained for backward compatibility; scheduled for removal during the Lease
    // Template domain cutover (implementation note, not customer-facing).
    @deprecated(message: "Scheduled for removal in a future API version.")
    schemaVersion: Integer
}

structure BudgetThreshold {
    /// Must be less than maxSpend when maxSpend is set (on a lease, its value
    /// after the update).
    @required
    // No `@range`: the pre-Smithy `.gt(0)` is not expressible with the inclusive-only
    // `@range` (`min: 1` rejects `0 < v < 1`, `min: 0` accepts `0`). Zod enforces it.
    dollarsSpent: Double

    @required
    action: ThresholdAction

    /// Whether the threshold fires on reported spend or on projected spend.
    /// Absent means REPORTED.
    /// PREDICTED requires predictiveBudgetEnabled (on a lease, its value after
    /// the update).
    triggerOn: BudgetTriggerSource
}

enum BudgetTriggerSource {
    REPORTED = "REPORTED"
    PREDICTED = "PREDICTED"
}

/// One spend-rate limit: the measured rate of `basis` reaching `rate` (USD per
/// hour or per day) takes `action`. The rate must be greater than zero, and a
/// list may not repeat a (basis, rate) pair; both rules are enforced by the
/// service rather than by a schema constraint.
structure RateLimitEntry {
    @required
    basis: RateBasis

    // No `@range`: `.gt(0)` is not expressible with the inclusive-only `@range`.
    /// Spend-rate threshold in USD per the period selected by basis.
    @required
    rate: Double

    @required
    action: ThresholdAction
}

@length(max: 10)
list RateLimitList {
    member: RateLimitEntry
}

list BudgetThresholdList {
    member: BudgetThreshold
}

structure DurationThreshold {
    @required
    // No `@range`: the pre-Smithy `.gt(0)` is not expressible with the inclusive-only
    // `@range` (`min: 1` rejects `0 < v < 1`, `min: 0` accepts `0`). Zod enforces it.
    hoursRemaining: Double

    @required
    action: ThresholdAction
}

list DurationThresholdList {
    member: DurationThreshold
}

enum ThresholdAction {
    ALERT
    FREEZE_ACCOUNT
}

/// Lease-template visibility: `PUBLIC` templates are visible to all users;
/// `PRIVATE` templates are visible only to Admin and Manager roles.
enum Visibility {
    PUBLIC
    PRIVATE
}
