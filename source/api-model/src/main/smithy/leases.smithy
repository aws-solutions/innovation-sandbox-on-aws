$version: "2"

namespace com.amazon.isb

use aws.protocols#restJson1

// Per-domain service for the leases Lambda. It binds only this domain's twelve
// operations, so the generated `LeasesApiService` types the Lambda's handler to
// exactly these — while the aggregate `IsbApi` (main.smithy) binds the same
// operations for the shared client/OpenAPI.
//
// Server-only: this service feeds only the `server-leases` SSDK projection. It
// deliberately omits the `@service` (sdkId) and `@sigv4` traits that `IsbApi`
// carries — a client/CLI must be generated from the aggregate `IsbApi`, never from
// a per-domain service (auth is enforced by middleware ahead of the Smithy handler).
//
// Accepted deviations (documented, consistent with the other domains; see
// `zod-validation-supplements.md` and `timestamp-modeling.md`):
//   1. Status-conditional requiredness is FLATTENED to an optional superset. The
//      persisted `Lease` is a Zod discriminatedUnion of Pending / ApprovalDenied /
//      Monitored / Expired, each of which makes a different set of members
//      `@required`. Smithy has no discriminated-union-with-per-variant-requiredness,
//      so the wire `Lease` is the UNION of every variant's members with ONLY the
//      always-present intersection marked `@required` (`userEmail`, `uuid`,
//      `status`, `originalLeaseTemplateUuid`, `originalLeaseTemplateName`).
//      Status-specific members (`awsAccountId`, `approvedBy`, `startDate`,
//      `expirationDate`, `lastCheckedDate`, `totalCostAccrued`, `endDate`, `ttl`)
//      are optional in the superset. The runtime `is*Lease` guards remain
//      OPERATION logic (they gate state transitions), not request-shape validation.
//   2. `meta.schemaVersion` is dropped from the wire (persisted, never a public
//      field), exactly as `AccountMetadata` does — only the timestamps are public.
//   3. ALL lease timestamps are modeled as raw `String`, not `@timestamp`
//      (`startDate`, `expirationDate`, `lastCheckedDate`, `endDate`, the lock's
//      `acquiredAt`/`expiresAt`, `LeaseMetadata` times, `AssignmentView.addedDate`).
//      The handler returns persisted strings through `JSON.stringify`; the frontend
//      reads them directly. `DynamoLeaseStore.update` carries a `meta.lastEditTime`
//      conditional against its server-read snapshot. Assignment PUT compares the
//      state used for validation, independently of monitoring metadata timestamps.
//   4. `maxResults` on the list operations is parsed by the generated
//      `restJson1` deserializer (`strictParseInt32`): a plain decimal integer only.
//      The pre-Smithy `z.coerce.number()` also accepted a leading `+`, leading
//      zeros, surrounding whitespace, and hex; those spellings now return 400. A
//      well-formed in-range integer is unaffected. The same cross-domain pagination
//      tightening documented for Accounts.
//   5. The 429 rate-limit response (`data.retryAt`, thrown by
//      `LeaseRequestRateLimitExceededError`) is a DELEGATED JSend error and is NOT
//      modeled — matching the no-typed-model convention for handler-thrown errors
//      that carry a custom payload.
//   6. `RequestLease` / `UpdateLease` / `UpdateLeaseAssignments` keep a strict Zod
//      re-parse (unknown-key rejection, cross-field/format rules, null-to-clear
//      semantics on PATCH) as an OPERATION supplement. `ReviewLease` also re-parses
//      its body `.strict()` (only to reject unknown keys — the model already
//      validates the `action` enum), and `ListSharedLeases` re-validates its
//      `userId` query param's IDC-principal-id format (modeled as an open
//      `String`). All enumerated in `zod-validation-supplements.md`.
//   7. Persisted `null` read-path members are DROPPED from the wire, not emitted as
//      `null`. `approvedBy`, `awsAccountId`, `blueprintId`, and `blueprintName` are
//      commonly persisted as `null` (blueprint-less templates, un-approved or
//      un-provisioned leases), and the pre-Smithy handler returned them as explicit
//      `null` via `JSON.stringify`. The `restJson1` serializer omits a structure
//      member whose value is `null`, so these appear absent rather than `null` on
//      the wire. This IS an observable wire-format change (absent vs explicit
//      `null`) with no *current* frontend behavior change — every consumer treats an
//      absent member and a `null` member identically (all four are optional), though
//      a future consumer distinguishing the two would see it. Distinct from
//      deviation #2 (`schemaVersion`, never public) and #3 (timestamps as `String`).
@restJson1
@title("Innovation Sandbox on AWS — Leases")
service LeasesApi {
    version: "2026-07-31"
    operations: [
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
    ]
    errors: [
        ValidationError
        UnauthenticatedError
        AccessDeniedError
        InternalServerError
    ]
}

// ---------------------------------------------------------------------------
// Shared lease scalars & enums
// ---------------------------------------------------------------------------
// Injected by the handler on read paths, never persisted, so it is absent from the
// base `Lease` shape and added by the read/unfreeze outputs. The `@pattern` matches
// the handler's path-parameter guard.
/// A lease's public identifier: the base64url-encoded `{userEmail, uuid}` composite
/// key (URL-safe alphabet, no padding). Present on read/unfreeze outputs and list
/// items; absent from the `Lease` returned by `RequestLease`/`UpdateLease`.
@pattern("^[A-Za-z0-9_-]+$")
string LeaseId

// Union of the Pending / ApprovalDenied / Monitored / Expired Zod variants'
// discriminators.
/// Every lease lifecycle status.
enum LeaseStatus {
    PENDING_APPROVAL = "PendingApproval"
    APPROVAL_DENIED = "ApprovalDenied"
    ACTIVE = "Active"
    FROZEN = "Frozen"
    PROVISIONING = "Provisioning"
    EXPIRED = "Expired"
    BUDGET_EXCEEDED = "BudgetExceeded"
    MANUALLY_TERMINATED = "ManuallyTerminated"
    USER_TERMINATED = "UserTerminated"
    ACCOUNT_QUARANTINED = "AccountQuarantined"
    EJECTED = "Ejected"
    PROVISIONING_FAILED = "ProvisioningFailed"
}

// Preemption rules implemented as `BlockingLockIntents` in `lease.ts`.
/// Intent recorded on a lease's concurrency lock. Critical intents
/// (`TERMINATE`, `FREEZE`) can preempt overridable ones (`UPDATE`, `PUBLISH`,
/// `UNFREEZE`).
enum LeaseLockIntent {
    TERMINATE
    FREEZE
    UPDATE
    PUBLISH
    UNFREEZE
}

// Lowercase wire values retained from the pre-Smithy contract.
/// The access path by which a shared lease reaches a user: a direct principal
/// assignment or membership in an assigned group. Wire values are lowercase.
enum SharedLeaseAccessType {
    DIRECT = "direct"
    GROUP = "group"
}

/// The review decision for a pending lease.
enum ReviewAction {
    APPROVE = "Approve"
    DENY = "Deny"
}

// Wire values are camelCase, matching `AssignmentSyncStatusSchema`.
/// Per-principal reconciliation status of a lease assignment. Each in-flight
/// state pairs with the failure it becomes if it never settles
/// (`granting` → `grantFailed`, `revoking` → `revokeFailed`):
/// - `active` — desired and assigned.
/// - `granting` — desired, not yet assigned; an operation is in flight.
/// - `revoking` — assigned but on its way out.
/// - `suspended` — intentionally not assigned because the lease grants nobody
///   access (frozen or terminal, or a freeze/terminate in flight); expected,
///   not a failure.
/// - `grantFailed` — desired and settled, but no assignment exists.
/// - `revokeFailed` — settled, but an assignment exists that should not: either
///   the principal is no longer desired, or the lease grants no access.
enum AssignmentSyncStatus {
    /// Desired and assigned.
    ACTIVE = "active"

    /// Desired, not yet assigned; an operation is in flight.
    GRANTING = "granting"

    /// Assigned but on its way out.
    REVOKING = "revoking"

    /// Intentionally not assigned because the lease grants nobody access (frozen
    /// or terminal, or a freeze/terminate in flight); expected, not a failure.
    SUSPENDED = "suspended"

    /// Desired and settled, but no assignment exists.
    GRANT_FAILED = "grantFailed"

    /// Settled, but an assignment exists that should not: either the principal is
    /// no longer desired, or the lease grants no access.
    REVOKE_FAILED = "revokeFailed"
}

// ---------------------------------------------------------------------------
// Lease shape (flattened optional superset — see service-doc deviation #1)
// ---------------------------------------------------------------------------
// All members of the flattened `Lease` superset, shared by the base `Lease`
// output and the `leaseId`-injected read outputs (`LeaseWithId`, `SharedLease`)
// via mixin so requiredness stays identical across them.
//
// `@required` is ONLY the always-present intersection across all four Zod
// variants. The template-picked budget/duration fields and `meta` are
// `.optional()` in their source schemas (`lease-template.ts`, `metadata.ts`), so
// they are optional here too; the status-specific members are present in some
// variants only, so they are optional in the superset.
@mixin
structure LeaseFields {
    // `@sensitive` (`OwnerEmail`) so generated logging redacts it.
    /// Lease owner / assignee email. Half of the composite key.
    @required
    userEmail: OwnerEmail

    // Modeled `String` (the existing public field name), like `LeaseTemplate.uuid`.
    /// Server-generated lease UUID. Half of the composite key.
    @required
    uuid: String

    @required
    status: LeaseStatus

    // `z.uuid()`, kept as an open `String` (format enforced by Zod, not `@pattern`).
    /// UUID of the lease template this lease was requested from.
    @required
    originalLeaseTemplateUuid: String

    /// Name copied from the template at request time.
    @required
    @length(min: 1, max: 50)
    originalLeaseTemplateName: String

    // Zod `FreeTextSchema`; the max length is enforced by the Zod re-parse on write,
    // not modeled here — matching how the template's `description` is left as an open
    // `String`.
    /// Free-text requester comments (max 1000 characters).
    comments: String

    // `@sensitive` (`OwnerEmail`).
    /// Set only for a cross-user (on-behalf) request; the elevated caller's email.
    createdBy: OwnerEmail

    // Nullability is a Zod concern, not modeled; a blueprint-less template leaves it
    // absent.
    /// Blueprint copied from the template for deployment. Absent when the template had
    /// none.
    blueprintId: String

    blueprintName: String

    allowOwnerToShareLease: Boolean

    /// Predictive budget controls opt-in. Copied from the template at creation
    /// and replaceable through `UpdateLease`.
    predictiveBudgetEnabled: Boolean

    /// Bedrock token monitoring opt-in. Saved at creation as the template's
    /// preference, or true when the template enables Sandbox Spaces, and
    /// replaceable through `UpdateLease`.
    bedrockTokenMonitoringEnabled: Boolean

    /// Snapshot of the source template's Sandbox Spaces on/off setting.
    sandboxSpacesEnabled: Boolean

    /// Snapshot of the template's Sandbox Spaces model subset — the lease's own
    /// copy, so a later template edit never changes enforcement under a running
    /// lease.
    allowedModelIds: AgentModelIdList

    /// Snapshot of the template's Sandbox Spaces default model, preselected first
    /// when a chat opens under this lease.
    defaultModelId: String

    /// Predicted spend now, in USD, as of the last threshold check. The next
    /// check compares against it. Lease Monitoring and Token Poll exclude
    /// Sandbox Spaces estimated token cost.
    lastPredictedSpend: Double

    /// Spend so far, in USD, as of the last threshold check, with the
    /// monitored Bedrock token cost in place of the billed Bedrock part
    /// where token monitoring is on, never below the billed total. The next
    /// check compares against it. Lease Monitoring and Token Poll exclude
    /// Sandbox Spaces estimated token cost.
    lastEvaluatedSpend: Double

    /// Most recently evaluated hourly spend rate.
    lastEvaluatedHourlySpendRate: Double

    /// Most recently evaluated daily spend rate.
    lastEvaluatedDailySpendRate: Double

    /// Declarative desired principal assignments (owner + shared users/groups),
    /// each optionally enriched with display metadata for the assignments UI.
    desiredAssignments: DesiredAssignmentWithDisplayList

    /// Record-level optimistic lock for in-flight assignment/lifecycle operations.
    resourceLock: LeaseResourceLock

    // --- template-picked budget/duration fields (all `.optional()` in
    // lease-template.ts) ---
    // No `@range`: the pre-Smithy `.gt(0)` is inclusive-`@range`-inexpressible on a
    // `Double`; Zod owns the positivity bound (see leaseTemplates' identical note).
    maxSpend: Double

    budgetThresholds: BudgetThresholdList

    // No `@range`: see `maxSpend`.
    leaseDurationInHours: Double

    durationThresholds: DurationThresholdList

    @length(min: 1, max: 50)
    costReportGroup: String

    // `schemaVersion` is dropped from the wire (deviation #2); timestamps are raw
    // `String` (deviation #3).
    /// Record metadata (creation and last-edit timestamps).
    meta: LeaseMetadata

    // --- status-specific members (present in Monitored/Expired variants only;
    // optional in the flattened superset — deviation #1) ---
    awsAccountId: AwsAccountId

    // A Zod union with no single canonical type, so modeled as an open `String`.
    /// Approver email or the literal `AUTO_APPROVED`.
    approvedBy: String

    // Raw `String` for byte-faithful passthrough (deviation #3).
    /// ISO 8601 instant.
    startDate: String

    expirationDate: String

    lastCheckedDate: String

    totalCostAccrued: Double

    endDate: String

    // `Long`, not `Integer`: a Unix-epoch-second timestamp crosses the signed 32-bit
    // ceiling (2,147,483,647 → Jan 2038), so a 32-bit `Integer` would overflow / fall
    // outside the contract for valid persisted records.
    /// TTL as a Unix-epoch-seconds timestamp. Present on terminal/denied leases.
    ttl: Long
}

// The hydrated members are repeated on each public projection so they append
// after every pre-existing member. Moving them into LeaseFields would insert
// them before LeaseWithId/SharedLease's local members and trigger Smithy's
// ChangedMemberOrder compatibility check.
/// The public lease projection. Body-returning writes (`RequestLease`,
/// `UpdateLease`) emit this WITHOUT `leaseId`; read paths emit `LeaseWithId`.
structure Lease with [LeaseFields] {
    /// Backend-hydrated metadata for the default permission set.
    defaultPermissionSet: PermissionSetReference

    /// Backend-hydrated metadata for the effective allowed set, including the
    /// default. Missing cache entries remain represented as UNAVAILABLE.
    allowedPermissionSets: PermissionSetReferenceList

    /// Spend-rate limits stored on this lease, each with its own action. Copied
    /// from the template at creation and replaceable through `UpdateLease`.
    /// Evaluated only while `predictiveBudgetEnabled` is true.
    rateLimits: RateLimitList
}

/// A `Lease` that carries the `leaseId` (base64url composite key). Returned by
/// `GetLease`, `UnfreezeLease`, and as the `ListLeases` result items.
structure LeaseWithId with [LeaseFields] {
    @required
    leaseId: LeaseId

    /// Backend-hydrated metadata for the default permission set.
    defaultPermissionSet: PermissionSetReference

    /// Backend-hydrated metadata for the effective allowed set, including the
    /// default. Missing cache entries remain represented as UNAVAILABLE.
    allowedPermissionSets: PermissionSetReferenceList

    /// Enabled catalog narrowed to this lease's allowed models. Set by
    /// `GetLease` and `UnfreezeLease` when Sandbox Spaces is enabled globally
    /// and on the lease, resolved on each read so disabling a model takes
    /// effect on the next fetch. Unset otherwise and on list responses.
    selectableModels: SelectableModelList

    /// Spend-rate limits stored on this lease, each with its own action. Copied
    /// from the template at creation and replaceable through `UpdateLease`.
    /// Evaluated only while `predictiveBudgetEnabled` is true.
    rateLimits: RateLimitList
}

/// One model a lease user may select for a Sandbox Space turn.
structure SelectableModel {
    @required
    modelId: String

    @required
    displayName: String

    @required
    provider: String
}

list SelectableModelList {
    member: SelectableModel
}

// Mirrors the `SharedLease` service type.
/// A `Lease` reachable through a shared assignment, with the access path and
/// (for group access) the group that granted it. Also carries the `leaseId`.
structure SharedLease with [LeaseFields] {
    @required
    leaseId: LeaseId

    @required
    accessType: SharedLeaseAccessType

    /// The IDC group display name that granted access, present only for
    /// `group` access.
    sourceGroupName: String

    /// Backend-hydrated metadata for the default permission set.
    defaultPermissionSet: PermissionSetReference

    /// Backend-hydrated metadata for the effective allowed set, including the
    /// default. Missing cache entries remain represented as UNAVAILABLE.
    allowedPermissionSets: PermissionSetReferenceList

    /// Enabled catalog narrowed to this lease's allowed models. Set by
    /// `GetLease` and `UnfreezeLease` when Sandbox Spaces is enabled globally
    /// and on the lease, resolved on each read so disabling a model takes
    /// effect on the next fetch. Unset otherwise and on list responses.
    selectableModels: SelectableModelList

    /// Spend-rate limits stored on this lease, each with its own action. Copied
    /// from the template at creation and replaceable through `UpdateLease`.
    /// Evaluated only while `predictiveBudgetEnabled` is true.
    rateLimits: RateLimitList
}

// `schemaVersion` is intentionally dropped from the wire (deviation #2); timestamps
// are raw `String` (deviation #3).
/// Lease record metadata: creation and last-edit timestamps.
structure LeaseMetadata {
    createdTime: String
    lastEditTime: String
}

// `LeaseResourceLockSchema`. Timestamps are raw `String` (deviation #3); the
// frontend reads `expiresAt` directly (`parseDatetime(resourceLock.expiresAt) > now()`).
/// A lease's record-level optimistic lock, held while assignment processing runs.
/// Clients read it to gate lease actions; a lock whose `expiresAt` has passed is
/// treated as absent.
structure LeaseResourceLock {
    /// Identifier of the operation holding the lock.
    @required
    @length(min: 1)
    ownerId: String

    /// When the lock was acquired.
    @required
    acquiredAt: String

    /// When the lock expires; past this point the lock is treated as absent.
    @required
    expiresAt: String

    /// Lease-specific lock context (the operation holding the lock).
    meta: LeaseLockMeta
}

// The generic `ResourceLock.meta` string map narrowed to the single `intent` key
// (`LeaseLockMetaSchema`).
/// Lock context for a lease.
structure LeaseLockMeta {
    /// The operation the lock was taken for.
    @required
    intent: LeaseLockIntent
}

// `DesiredAssignmentSchema`.
/// A caller-supplied desired assignment: the target principal and its kind. Used by
/// `RequestLease` and `UpdateLeaseAssignments` request bodies.
structure DesiredAssignment {
    // `IdcPrincipalIdSchema`; format enforced by Zod, so kept an open `String`.
    /// IDC principal id.
    @required
    principalId: String

    @required
    principalType: PrincipalType

    /// Permission set selected for this principal. Absent callers use the lease default.
    permissionSetArn: PermissionSetArn
}

list DesiredAssignmentList {
    member: DesiredAssignment
}

// `DesiredAssignmentWithDisplaySchema`, as persisted on the lease.
/// A desired assignment enriched with display metadata.
structure DesiredAssignmentWithDisplay {
    @required
    principalId: String

    @required
    principalType: PrincipalType

    displayName: String

    // `@sensitive` (`OwnerEmail`).
    email: OwnerEmail

    permissionSetArn: PermissionSetArn
}

list DesiredAssignmentWithDisplayList {
    member: DesiredAssignmentWithDisplay
}

// ---------------------------------------------------------------------------
// Assignments view (server TypeScript contract — model-only, no Zod schema)
// ---------------------------------------------------------------------------
/// One row of the assignments view: the union of a lease's desired set and its
/// live assignments, annotated with reconciliation state. Rows sourced only from
/// the desired set have no assignment yet, so `assigneeEmail`/`addedBy`/`addedDate`
/// are absent.
structure AssignmentView {
    /// IDC user id (for `USER` assignments) or group id (for `GROUP` assignments).
    @required
    principalId: String

    /// Whether this is a direct user or a group assignment.
    @required
    principalType: PrincipalType

    /// Display name of the user or group.
    @required
    displayName: String

    // `@sensitive` (`OwnerEmail`).
    /// Email of the assigned user (USER assignments only).
    assigneeEmail: OwnerEmail

    // `@sensitive` (`OwnerEmail`).
    /// Email of the user who created this assignment. Absent for a principal that is
    /// desired but not yet granted.
    addedBy: OwnerEmail

    addedDate: String

    /// True for the lease owner, whose access is implicit and not removable.
    @required
    isOwner: Boolean

    /// Whether the principal is in the lease's desired set. This cannot be inferred
    /// from `syncStatus`.
    @required
    isDesired: Boolean

    @required
    syncStatus: AssignmentSyncStatus

    /// Backend-hydrated permission set details. Legacy ARN-less records resolve
    /// to the immutable built-in user permission set.
    @required
    permissionSet: PermissionSetReference
}

list AssignmentViewList {
    member: AssignmentView
}

/// The assignments view plus the operation currently reconciling it.
structure LeaseAssignmentsView {
    @required
    assignments: AssignmentViewList

    operationInProgress: LeaseLockIntent
}

// ---------------------------------------------------------------------------
// Cost history view (server TypeScript contract — model-only, no Zod schema)
// ---------------------------------------------------------------------------
// Mirrors `cost-history-api.types.ts`, the one definition the producer and the
// frontend both import. Timestamps are raw `String` (deviation #3), and the
// contract's `T | null` members are plain optional members (deviation #7), so the
// serializer omits them. Every rate-derived figure below is absent in a lease's
// first reporting interval, and for the life of one that never opted into
// prediction.
/// The window a rate is measured over.
enum RateBasis {
    HOURLY
    DAILY
}

/// What crossed a threshold: reported spend, projected spend, a spend rate, or time
/// remaining. `MAX_SPEND` is the lease's maximum spend and `EXPIRY` its end, which
/// both terminate the lease.
enum BreachTriggeredBy {
    REPORTED
    PREDICTED
    RATE
    MAX_SPEND
    DURATION
    EXPIRY
}

/// What a breach did. `TERMINATE` is recorded only on a `MAX_SPEND` or `EXPIRY` breach.
enum BreachAction {
    ALERT
    FREEZE_ACCOUNT
    TERMINATE
}

/// Which schedule evaluated a breach: `LEASE_MONITORING` or `TOKEN_POLL`.
/// Only the token poll records the monitored Bedrock token cost.
enum BreachEvaluatedBy {
    LEASE_MONITORING
    TOKEN_POLL
}

/// The kind of insight computed for a breach's notification.
enum InsightKind {
    COMPOSITION
    CHANGE
    NEW_ENTRANT
}

/// Cumulative cost keyed by Cost Explorer service name.
map ServiceBreakdown {
    key: String
    value: Double
}

/// One row of the paginated reported series.
structure CostHistoryResultRow {
    @required
    timestamp: String

    @required
    billedCostAccrued: Double

    /// The projection standing when this row re-based it. Absent where no rate
    /// existed then.
    predictedCostAtRefresh: Double

    /// Absent where the deployment collects no breakdown, or on a fallback-served
    /// lease — which is not the same as an empty breakdown.
    serviceBreakdown: ServiceBreakdown
}

list CostHistoryResultRowList {
    member: CostHistoryResultRow
}

/// One Bedrock token reading, flattened per region per model. `monitoredBedrockTokenCost` is
/// lease-wide as of `timestamp`, so it repeats across the rows sharing one and
/// summing it across rows double-counts. It prices only the tokens attributed to
/// a model, each at the rate when it was counted; a token with no rate adds
/// nothing. It is absent only on older rows saved unpriced.
structure TokenSeriesRow {
    @required
    timestamp: String

    @required
    region: String

    /// The Bedrock ModelId, or "unattributed" for counts that could not be matched
    /// to a model; those counts are never priced into `monitoredBedrockTokenCost`.
    @required
    modelId: String

    @required
    input: Double

    @required
    output: Double

    @required
    cacheRead: Double

    @required
    cacheWrite: Double

    monitoredBedrockTokenCost: Double
}

list TokenSeriesRowList {
    member: TokenSeriesRow
}

/// The insight sent in a breach's notification, stored verbatim.
structure BreachInsight {
    @required
    kind: InsightKind

    @required
    service: String

    @required
    amount: Double

    /// `COMPOSITION` only: the service's share of the spend figure used for
    /// the threshold comparison.
    shareOfComparedSpend: Double

    /// `CHANGE` only; signed, so a fall is negative.
    changePercent: Double
}

/// A threshold that fired, from the stored breach records.
structure BreachEntry {
    @required
    timestamp: String

    @required
    triggeredBy: BreachTriggeredBy

    @required
    action: BreachAction

    /// The dollar threshold crossed. Absent on a `RATE`, `DURATION` or `EXPIRY` breach.
    thresholdDollars: Double

    /// The cap exceeded and its basis, on a `RATE` breach.
    thresholdRate: Double

    thresholdRateBasis: RateBasis

    /// The hours before the lease's end, on a `DURATION` breach.
    thresholdHoursRemaining: Double

    @required
    billedCostAtFire: Double

    predictedCostAtFire: Double

    /// The rate in force when the threshold fired, and its basis. Absent on a `MAX_SPEND`,
    /// `DURATION` or `EXPIRY` breach, and where no rate was in force.
    rateAtFire: Double

    rateSourceAtFire: RateBasis

    @required
    evaluatedBy: BreachEvaluatedBy

    /// Spend at the time of the breach where the evaluator compared a figure
    /// other than the bill alone. Null on a `LEASE_MONITORING` breach. On a
    /// `TOKEN_POLL` breach, the spend with the monitored Bedrock token
    /// cost substituted for the billed Bedrock slice, never below the billed
    /// total.
    evaluatedSpendAtFire: Double

    /// The monitored Bedrock term substituted into `evaluatedSpendAtFire`,
    /// before its floor at the billed total. Absent on a `LEASE_MONITORING`
    /// breach, and on a `TOKEN_POLL` breach where none was substituted: no
    /// priced token row yet, or no billed Bedrock slice to replace.
    monitoredBedrockTokenCostAtFire: Double

    insight: BreachInsight
}

list BreachEntryList {
    member: BreachEntry
}

/// One newest-observation per-service figure with its change since the prior
/// observation.
structure CurrentServiceEntry {
    @required
    service: String

    @required
    amount: Double

    /// The service's share of `billedCostAccrued`.
    @required
    shareOfBilledCost: Double

    /// Absent until a second observation exists to difference against.
    changePercent: Double
}

list CurrentServiceEntryList {
    member: CurrentServiceEntry
}

/// Lease-level headline figures, computed from the newest data. Everything here
/// describes the instant given by `lastCheckedAt`, so it can be up to an hour old.
structure CostHistoryCurrent {
    @required
    billedCostAccrued: Double

    /// Never absent: with no rate it falls back to the figure the projection is
    /// anchored on, the lease's `lastEvaluatedSpend` where Bedrock token monitoring
    /// is on and that is present, and the reported total otherwise.
    @required
    predictedCost: Double

    hourlyRate: Double

    dailyRate: Double

    /// The measurement window behind each rate, in hours — the only thing that
    /// stops a rate extrapolated from a short window being read as established.
    /// Absent exactly when the matching rate is.
    hourlyRateWindowHours: Double

    dailyRateWindowHours: Double

    rateSource: RateBasis

    /// Absent when the lease has no `maxSpend`, or the rate is zero or unavailable.
    hoursToBudgetExhaustion: Double

    @required
    latestPeriodStart: String

    @required
    lastReportedAt: String

    @required
    lastCheckedAt: String

    /// Newest per-service figures. Empty means no share can be expressed (no
    /// breakdown collected, a fallback-served lease, a breakdown covering only part
    /// of the reported total, or a non-positive `billedCostAccrued`), NOT that nothing was
    /// spent. Where non-empty, shares sum to 1.00 because the smallest is a residual.
    @required
    services: CurrentServiceEntryList
}

/// The cost-summary payload.
structure CostSummaryData {
    /// Absent when no reading is available, which is not the same as a lease with
    /// no spend.
    current: CostHistoryCurrent
}

/// The cost-history payload, newest-first, so a client differencing it walks
/// backwards.
structure CostHistoryData {
    /// The paginated reported series.
    @required
    result: CostHistoryResultRowList

    nextPageIdentifier: ContinuationToken
}

/// The Bedrock token-history payload, newest-first, so a client differencing it
/// walks backwards.
structure BedrockTokenHistoryData {
    /// The paginated token series, one entry per reading per region and model.
    @required
    result: TokenSeriesRowList

    nextPageIdentifier: ContinuationToken
}

/// The breach-history payload, newest-first.
structure BreachHistoryData {
    /// The paginated thresholds that fired.
    @required
    result: BreachEntryList

    nextPageIdentifier: ContinuationToken
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------
/// Paginated list of leases. Admin/Manager callers list all leases (or filter by
/// `userEmail`); a regular caller may only list their own (`userEmail` must be
/// their own, else 403 `AccessDeniedError`). Each result item carries a `leaseId`.
/// `maxResults` caps at 2000.
@http(method: "GET", uri: "/leases", code: 200)
@readonly
@tags(["leases"])
// pageIdentifier/nextPageIdentifier are the pre-Smithy wire names, kept for backward compatibility (not renamed to nextToken).
@paginated(
    inputToken: "pageIdentifier"
    pageSize: "maxResults"
    outputToken: "data.nextPageIdentifier"
    items: "data.result"
)
operation ListLeases {
    input := {
        @httpQuery("pageIdentifier")
        pageIdentifier: ContinuationToken

        @httpQuery("maxResults")
        @range(min: 1, max: 2000)
        maxResults: Integer

        // `@sensitive` (`OwnerEmail`).
        /// Optional owner filter.
        @httpQuery("userEmail")
        userEmail: OwnerEmail
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: ListLeasesResult
    }
}

// `error` is a store-side validation-warning string the handler forwards verbatim
// (it returns the raw store result); modeled to keep the response byte-faithful.
/// `error` is an optional diagnostic warning string. It is non-contractual, not a
/// failure.
structure ListLeasesResult {
    @required
    result: LeaseWithIdList

    nextPageIdentifier: ContinuationToken

    error: String
}

list LeaseWithIdList {
    member: LeaseWithId
}

/// Paginated list of leases shared with a user, by access path. Admin/Manager may
/// query any user; a regular IDC caller may query only their own `userId` (else
/// 403 `AccessDeniedError`; M2M callers without an elevated role are refused).
/// Each item carries a `leaseId`, its `accessType`, and (for group access)
/// `sourceGroupName`. `maxResults` caps at 100.
@http(method: "GET", uri: "/leases/shared", code: 200)
@readonly
@tags(["leases"])
// pageIdentifier/nextPageIdentifier are the pre-Smithy wire names, kept for backward compatibility (not renamed to nextToken).
@paginated(
    inputToken: "pageIdentifier"
    pageSize: "maxResults"
    outputToken: "data.nextPageIdentifier"
    items: "data.result"
)
operation ListSharedLeases {
    input := {
        @httpQuery("pageIdentifier")
        pageIdentifier: ContinuationToken

        @httpQuery("maxResults")
        @range(min: 1, max: 100)
        maxResults: Integer

        // `IdcPrincipalIdSchema`; format enforced by Zod, so an open `String`.
        /// The IDC user whose shared leases to list.
        @required
        @httpQuery("userId")
        userId: String

        @required
        @httpQuery("accessType")
        accessType: SharedLeaseAccessType
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: ListSharedLeasesResult
    }
}

structure ListSharedLeasesResult {
    @required
    result: SharedLeaseList

    nextPageIdentifier: ContinuationToken

    error: String
}

list SharedLeaseList {
    member: SharedLease
}

/// Get a single lease by id. The `leaseId` is echoed on the returned lease. A
/// caller without read access to an existing lease receives 403; a non-existent
/// lease (for an authorized caller) receives 404.
@http(method: "GET", uri: "/leases/{leaseId}", code: 200)
@readonly
@tags(["leases"])
operation GetLease {
    input := {
        @required
        @httpLabel
        leaseId: LeaseId
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: LeaseWithId
    }

    errors: [
        NotFoundError
    ]
}

/// Get the assignments view for a lease. Admin/Manager may view any lease; other
/// callers only their own (403 even when the lease does not exist, so existence
/// is not leaked). 404 when the lease does not exist for an authorized caller.
@http(method: "GET", uri: "/leases/{leaseId}/assignments", code: 200)
@readonly
@tags(["leases"])
operation GetLeaseAssignments {
    input := {
        @required
        @httpLabel
        leaseId: LeaseId
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: LeaseAssignmentsView
    }

    errors: [
        NotFoundError
    ]
}

/// Get a lease's headline cost figures from its newest reading. `current` is absent
/// when no reading is available.
/// Authorization is the same as `GetLease` — Admin/Manager may read any lease, any
/// other caller only one they own or are assigned to, 403 even when the lease does
/// not exist so existence is not leaked. 404 for an authorized caller.
@http(method: "GET", uri: "/leases/{leaseId}/costSummary", code: 200)
@readonly
@tags(["leases"])
operation GetLeaseCostSummary {
    input := {
        @required
        @httpLabel
        leaseId: LeaseId
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: CostSummaryData
    }

    errors: [
        NotFoundError
    ]
}

/// The input every lease history operation takes: the lease, a page, and an
/// optional time range.
@mixin
structure LeaseHistoryPageInputMixin {
    @required
    @httpLabel
    leaseId: LeaseId

    @httpQuery("pageIdentifier")
    pageIdentifier: ContinuationToken

    @httpQuery("maxResults")
    @range(min: 1, max: 100)
    maxResults: Integer

    /// Inclusive lower bound on row timestamps, as an ISO 8601 instant.
    /// Any offset is accepted and normalized to UTC.
    // `String` rather than `@timestamp`, as every timestamp in this model is.
    @httpQuery("afterTimestamp")
    afterTimestamp: String

    /// Exclusive upper bound, same spelling as `afterTimestamp`. Must be later
    /// than it.
    @httpQuery("beforeTimestamp")
    beforeTimestamp: String
}

/// Get a lease's reported cost series, newest-first.
/// Authorization is the same as `GetLease` — Admin/Manager may read any lease, any
/// other caller only one they own or are assigned to, 403 even when the lease does
/// not exist so existence is not leaked. 404 for an authorized caller.
///
/// A page can return fewer than `maxResults` readings, or none, and still include a
/// `nextPageIdentifier`. Keep requesting pages until `nextPageIdentifier` is absent.
@http(method: "GET", uri: "/leases/{leaseId}/costHistory", code: 200)
@readonly
@tags(["leases"])
// pageIdentifier/nextPageIdentifier: the pre-Smithy list operations' wire names, taken for consistency (not renamed to nextToken).
@paginated(
    inputToken: "pageIdentifier"
    pageSize: "maxResults"
    outputToken: "data.nextPageIdentifier"
    items: "data.result"
)
operation GetLeaseCostHistory {
    input := with [LeaseHistoryPageInputMixin] {}

    output := {
        @required
        status: JSendStatus

        @required
        data: CostHistoryData
    }

    errors: [
        NotFoundError
    ]
}

/// Get a lease's Bedrock token series, newest-first: one entry per reading per
/// region and model, with `maxResults` counting readings.
/// Authorization is the same as `GetLease` — Admin/Manager may read any lease, any
/// other caller only one they own or are assigned to, 403 even when the lease does
/// not exist so existence is not leaked. 404 for an authorized caller.
///
/// A range's first change is measured from the reading before it: read it with
/// `beforeTimestamp` set to the range start and `maxResults` 1, as a single request,
/// not through a paginator (with the AWS CLI, `--no-paginate`). An empty page with a
/// `nextPageIdentifier` means that reading could not be read.
///
/// A page can return fewer than `maxResults` readings, or none, and still include a
/// `nextPageIdentifier`; it also ends early at a size limit. Keep requesting pages
/// until `nextPageIdentifier` is absent.
@http(method: "GET", uri: "/leases/{leaseId}/bedrockTokenHistory", code: 200)
@readonly
@tags(["leases"])
// pageIdentifier/nextPageIdentifier: the pre-Smithy list operations' wire names, taken for consistency (not renamed to nextToken).
@paginated(
    inputToken: "pageIdentifier"
    pageSize: "maxResults"
    outputToken: "data.nextPageIdentifier"
    items: "data.result"
)
operation GetLeaseBedrockTokenHistory {
    input := with [LeaseHistoryPageInputMixin] {}

    output := {
        @required
        status: JSendStatus

        @required
        data: BedrockTokenHistoryData
    }

    errors: [
        NotFoundError
    ]
}

/// Get a lease's breach history: the thresholds that fired, newest-first.
/// Authorization is the same as `GetLease` — Admin/Manager may read any lease, any
/// other caller only one they own or are assigned to, 403 even when the lease does
/// not exist so existence is not leaked. 404 for an authorized caller.
///
/// A page can return fewer than `maxResults` breaches, or none, and still include a
/// `nextPageIdentifier`. Keep requesting pages until `nextPageIdentifier` is absent.
@http(method: "GET", uri: "/leases/{leaseId}/breachHistory", code: 200)
@readonly
@tags(["leases"])
// pageIdentifier/nextPageIdentifier: the pre-Smithy list operations' wire names, taken for consistency (not renamed to nextToken).
@paginated(
    inputToken: "pageIdentifier"
    pageSize: "maxResults"
    outputToken: "data.nextPageIdentifier"
    items: "data.result"
)
operation GetLeaseBreachHistory {
    input := with [LeaseHistoryPageInputMixin] {}

    output := {
        @required
        status: JSendStatus

        @required
        data: BreachHistoryData
    }

    errors: [
        NotFoundError
    ]
}

// ---------------------------------------------------------------------------
// Lease request & update (body-bearing writes; keep a strict Zod re-parse)
// ---------------------------------------------------------------------------
// The pre-Smithy handler returns the raw `newLease`. The request body is re-parsed
// by Zod for unknown-key rejection, the per-principal-uniqueness rule, and refined
// formats (see `zod-validation-supplements.md`). Cap constant: `MAX_ASSIGNMENTS`.
/// Request a new lease from a template. Returns the created lease (201) WITHOUT a
/// `leaseId`. A cross-user (on-behalf) request is Admin/Manager only. `assignments`
/// accepts up to 20 principals with one permission set each, but the final
/// desired state is capped at 20 total including the required owner. New
/// group-to-lease associations are rejected when `leases.groupAssignmentMode`
/// is `NONE`; user assignments remain allowed.
///
/// Retry: NOT `@idempotent`. Requesting a lease allocates an account and publishes
/// events; a retried request creates a second lease.
@http(method: "POST", uri: "/leases", code: 201)
@tags(["leases"])
@examples([
    {
        title: "Request a lease from a template"
        input: {
            leaseTemplateUuid: "12345678-90ab-4cde-8f12-34567890abcd"
            comments: "This is a comment"
            assignments: [
                {
                    principalId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
                    principalType: "USER"
                }
            ]
        }
        output: {
            status: "success"
            data: {
                userEmail: "user@example.com"
                uuid: "12345678-90ab-4cde-8f12-34567890abcd"
                status: "PendingApproval"
                originalLeaseTemplateUuid: "12345678-90ab-4cde-8f12-34567890abcd"
                originalLeaseTemplateName: "Example Template"
                comments: "This is a comment"
            }
        }
    }
])
operation RequestLease {
    input := {
        // `z.uuid()`; format enforced by Zod, open `String`.
        /// Template to request from. Public request field name (not
        /// `originalLeaseTemplateUuid`).
        @required
        leaseTemplateUuid: String

        // `@sensitive` (`OwnerEmail`).
        /// On-behalf target user. Omitted for a self-request.
        userEmail: OwnerEmail

        comments: String

        @length(max: 20)
        assignments: DesiredAssignmentList
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: Lease
    }

    errors: [
        ValidationError
        NotFoundError
        ConflictError
    ]
}

// The null-to-clear mapping is a Zod re-parse concern that `restJson1` cannot
// express, so the nullable members are modeled as plain optional members and the
// mapping stays operation logic. Unknown keys and cross-field budget/duration rules
// are enforced by the Zod re-parse.
/// Update a monitored (active) lease. PATCH semantics: every body member is
/// optional. Returns the updated lease (200) WITHOUT a `leaseId`. The nullable
/// members (`maxSpend`, `expirationDate`, `costReportGroup`, and `rateLimits`)
/// accept an explicit `null` to CLEAR the value. Non-monitored leases are
/// rejected 400 (`ValidationError`); a missing lease is 404.
@http(method: "PATCH", uri: "/leases/{leaseId}", code: 200)
@tags(["leases"])
@examples([
    {
        title: "Update a lease's budget and expiration"
        input: {
            leaseId: "BASE64STRING"
            maxSpend: 100
            expirationDate: "2025-01-22T08:30:00Z"
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
        }
        output: {
            status: "success"
            data: {
                userEmail: "user@example.com"
                uuid: "12345678-90ab-4cde-8f12-34567890abcd"
                status: "Active"
                originalLeaseTemplateUuid: "12345678-90ab-4cde-8f12-34567890abcd"
                originalLeaseTemplateName: "Example Template"
                maxSpend: 100
                expirationDate: "2025-01-22T08:30:00Z"
                costReportGroup: "Engineering"
            }
        }
    }
])
operation UpdateLease {
    input := {
        @required
        @httpLabel
        leaseId: LeaseId

        // No `@range` on `maxSpend`: `.gt(0)` is inclusive-`@range`-inexpressible.
        maxSpend: Double

        budgetThresholds: BudgetThresholdList

        expirationDate: String

        durationThresholds: DurationThresholdList

        @length(min: 1, max: 50)
        costReportGroup: String

        allowOwnerToShareLease: Boolean

        /// Replace the lease's default permission set.
        defaultPermissionSetArn: PermissionSetArn

        /// Replace the permission sets available for assignment overrides.
        allowedPermissionSetArns: PermissionSetArnList

        /// Turn Sandbox Spaces on or off for this lease.
        sandboxSpacesEnabled: Boolean

        /// Replace the lease's Sandbox Spaces model subset. Clearable: an explicit
        /// null inherits every enabled catalog model.
        allowedModelIds: AgentModelIdList

        /// Replace the model preselected when a chat opens. Clearable with null.
        defaultModelId: String

        /// Replace the spend-rate limits. Clearable: the edit forms send an
        /// explicit null, which the client re-injects into the body (the
        /// serializer omits nulls). An empty list also clears. A non-empty list
        /// requires predictive budget controls on. Omitting it in a request
        /// that sets `predictiveBudgetEnabled` to false clears the stored limits.
        rateLimits: RateLimitList

        /// Turn predictive budget controls on or off. Turning them on requires
        /// `allowPredictiveBudgetControls`. While they are off, a `PREDICTED`
        /// budget threshold or a non-empty `rateLimits` list is rejected.
        predictiveBudgetEnabled: Boolean

        /// Turn Bedrock token monitoring on or off. Turning it on requires
        /// `allowBedrockTokenMonitoring` or `sandboxSpacesEnabled` true. Must be
        /// true while `sandboxSpacesEnabled` is true. Send false in a request that
        /// turns `sandboxSpacesEnabled` off while `allowBedrockTokenMonitoring` is off.
        bedrockTokenMonitoringEnabled: Boolean
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: Lease
    }

    errors: [
        ValidationError
        NotFoundError
        ConflictError
    ]
}

// ---------------------------------------------------------------------------
// Lifecycle actions
// ---------------------------------------------------------------------------
// The pre-Smithy success body was `{"status":"success","data":null}`; `data` is not
// modeled (Smithy cannot model a null-only member) and the serializer drops the
// explicit `null` (the accepted null-member deviation) — same shape as
// `DeleteLeaseTemplate`.
/// Freeze an active lease. The success body is `{"status":"success"}`. 404 when the
/// lease is missing; 409 when it is not active, an account is not in the expected
/// state, or a competing critical operation holds the lock.
@http(method: "POST", uri: "/leases/{leaseId}/freeze", code: 200)
@tags(["leases"])
operation FreezeLease {
    input := {
        @required
        @httpLabel
        leaseId: LeaseId
    }

    output := {
        @required
        status: JSendStatus
    }

    errors: [
        NotFoundError
        ConflictError
    ]
}

// Body is re-parsed strict — unknown keys rejected by Zod (deviation #6). The
// pre-Smithy success body was `{status, data: null}`; `data` is not modeled and the
// `null` is dropped.
/// Approve or deny a pending lease. Body carries `action` (`Approve`/`Deny`). The
/// success body is `{"status":"success"}`. A pending request that already contains
/// a group can still be approved when `leases.groupAssignmentMode` is `NONE`; the
/// mode blocks creation of new group-to-lease associations, not completion of an
/// existing request. 404 when missing; 409 when the lease is not pending review or
/// (on approve) no account is available.
@http(method: "POST", uri: "/leases/{leaseId}/review", code: 200)
@tags(["leases"])
@examples([
    {
        title: "Approve a pending lease"
        input: { leaseId: "BASE64STRING", action: "Approve" }
        output: { status: "success" }
    }
])
operation ReviewLease {
    input := {
        @required
        @httpLabel
        leaseId: LeaseId

        @required
        action: ReviewAction
    }

    output := {
        @required
        status: JSendStatus
    }

    errors: [
        ValidationError
        NotFoundError
        ConflictError
    ]
}

// The pre-Smithy success body was `{status, data: null}`; `data` is not modeled and
// the `null` is dropped.
/// Terminate a monitored lease. The success body is `{"status":"success"}`. A
/// regular caller may terminate only their own lease and only when config permits
/// (else 403 `AccessDeniedError`, checked before existence so it is not leaked). 404
/// when missing; 409 when not in a terminable state or a termination is already in
/// progress.
@http(method: "POST", uri: "/leases/{leaseId}/terminate", code: 200)
@tags(["leases"])
operation TerminateLease {
    input := {
        @required
        @httpLabel
        leaseId: LeaseId
    }

    output := {
        @required
        status: JSendStatus
    }

    errors: [
        NotFoundError
        ConflictError
    ]
}

/// Unfreeze a frozen lease. Unlike freeze/terminate, this returns the updated lease
/// (200) WITH the `leaseId`. 404 when missing; 409 when not frozen, an account is
/// not in the frozen state, or a live lock rejects it.
@http(method: "POST", uri: "/leases/{leaseId}/unfreeze", code: 200)
@tags(["leases"])
operation UnfreezeLease {
    input := {
        @required
        @httpLabel
        leaseId: LeaseId
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: LeaseWithId
    }

    errors: [
        NotFoundError
        ConflictError
    ]
}

// Cap constant: `MAX_ASSIGNMENTS`. The body is re-parsed by Zod for
// unknown-key rejection and per-principal uniqueness.
/// Replace a lease's desired principal assignments (declarative). Each
/// principal selects exactly one permission set. Accepted
/// asynchronously: success is 202 with `{ desiredCount }` — the assignment worker
/// reconciles out of band. `@idempotent`: PUT sets the desired set, so a retry
/// converges to the same state. `assignments` is capped at 20 principals, including
/// the lease owner. Owner callers require
/// lease sharing enabled globally and on the lease (else 403). When group assignment
/// mode is `NONE`, existing group-to-lease associations may remain or be removed,
/// but new associations are rejected. 404 when missing; 409 when the lease is not
/// active or another operation holds the lock.
@http(method: "PUT", uri: "/leases/{leaseId}/assignments", code: 202)
@idempotent
@tags(["leases"])
@examples([
    {
        title: "Set desired principal assignments"
        input: {
            leaseId: "BASE64STRING"
            assignments: [
                {
                    principalId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
                    principalType: "USER"
                }
            ]
        }
        output: {
            status: "success"
            data: { desiredCount: 1 }
        }
    }
])
operation UpdateLeaseAssignments {
    input := {
        @required
        @httpLabel
        leaseId: LeaseId

        @required
        @length(max: 20)
        assignments: DesiredAssignmentList
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: UpdateLeaseAssignmentsResult
    }

    errors: [
        ValidationError
        NotFoundError
        ConflictError
    ]
}

/// The count of desired assignments accepted for reconciliation.
structure UpdateLeaseAssignmentsResult {
    @required
    desiredCount: Integer
}
