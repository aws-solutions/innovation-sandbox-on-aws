$version: "2"

namespace com.amazon.isb

use aws.protocols#restJson1

// Models `ListAgentHistory` and `GetSandboxSpacesUsage`. Feeds the `server-sandbox-agent`
// SSDK projection, so the generated service handler routes and validates both
// operations. Auth is enforced by middleware ahead of the handler, so no
// `@sigv4`/`@service` traits here.
@restJson1
@title("Innovation Sandbox on AWS — Sandbox Agent")
service SandboxAgentApi {
    version: "2026-09-10"
    operations: [
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

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
// `leaseId` is required by the handler for every caller, but Smithy cannot
// express that query-parameter requirement.
/// Lists the caller's persisted turn-by-turn agent history for a lease,
/// paginated by nextToken.
@http(method: "GET", uri: "/sandboxAgent/history", code: 200)
@readonly
@tags(["sandboxAgent"])
@paginated(inputToken: "nextToken", pageSize: "maxResults", outputToken: "data.nextToken", items: "data.messages")
operation ListAgentHistory {
    input := {
        @httpQuery("leaseId")
        leaseId: LeaseId

        @httpQuery("nextToken")
        nextToken: String

        @httpQuery("maxResults")
        @range(min: 1, max: 100)
        maxResults: Integer
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: AgentHistoryResponse
    }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------
@length(min: 1)
string AgentHistoryMessageId

/// One message in the conversation history.
structure AgentHistoryMessage {
    @required
    role: ConversationRole

    @required
    content: String

    @required
    @timestampFormat("date-time")
    createdAt: Timestamp

    /// Stable opaque identity that remains unchanged across pagination and refreshes.
    @required
    messageId: AgentHistoryMessageId
}

enum ConversationRole {
    USER = "user"
    ASSISTANT = "assistant"
}

list AgentHistoryMessageList {
    member: AgentHistoryMessage
}

/// `leaseUuid` presence is handler-determined, not client-requested.
structure AgentHistoryResponse {
    /// The lease uuid.
    leaseUuid: String

    @required
    messages: AgentHistoryMessageList

    nextToken: String
}

// ---------------------------------------------------------------------------
// GET /sandboxAgent/usage
// ---------------------------------------------------------------------------
/// Retrieve estimated Sandbox Spaces token cost attributed to users on a
/// lease. Users see only their own entry in `spendByUsers`; Admins and
/// Managers see every user with recorded usage on the lease.
@http(method: "GET", uri: "/sandboxAgent/usage", code: 200)
@readonly
@tags(["sandboxAgent"])
operation GetSandboxSpacesUsage {
    input := {
        @required
        @httpQuery("leaseId")
        leaseId: LeaseId
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: SandboxSpacesUsageData
    }
}

/// The `data` payload of `GET /sandboxAgent/usage`.
structure SandboxSpacesUsageData {
    /// Admins and Managers: every user with recorded usage. Users: only the
    /// caller, with a zero entry when they have no recorded usage.
    @required
    spendByUsers: SandboxSpacesUserSpendList
}

/// One user's Sandbox Spaces estimated token cost on the lease.
structure SandboxSpacesUserSpend {
    /// The Identity Center user id.
    @required
    userId: String

    /// This user's accumulated Sandbox Spaces estimated token cost in US dollars.
    @required
    sandboxSpacesEstimatedTokenCostAccrued: Double
}

list SandboxSpacesUserSpendList {
    member: SandboxSpacesUserSpend
}

// ---------------------------------------------------------------------------
// GET /sandboxAgent/models
// ---------------------------------------------------------------------------
/// Returns eligible Bedrock models, listed from `ListFoundationModels` and
/// `ListInferenceProfiles`, with their pricing data. Admin only.
/// The response includes all four token-type rates. A model whose rates are not
/// published by any pricing API is listed without any pricing members.
@http(method: "GET", uri: "/sandboxAgent/models", code: 200)
@readonly
@tags(["sandboxAgent"])
operation ListAgentModels {
    input := {}

    output := {
        @required
        status: JSendStatus

        @required
        data: AgentModelsData
    }
}

/// The `data` payload of `GET /sandboxAgent/models`.
structure AgentModelsData {
    @required
    models: AgentModelInfoList
}

/// One eligible Bedrock model with live pricing data.
structure AgentModelInfo {
    @required
    modelId: String

    @required
    displayName: String

    @required
    provider: String

    /// Geographic availability prefix: `"global"`, `"us"`, `"eu"`, etc.
    @required
    availability: String

    description: String

    /// Whether this entry is a foundation model or a system-defined inference profile.
    @required
    modelType: AgentModelType

    /// ID of the foundation model this entry invokes; a foundation model's own ID.
    @required
    foundationModelId: String

    /// Name of the foundation model this entry invokes.
    @required
    foundationModelName: String

    /// Where the rates came from: the Price List or Bedrock agreement offers.
    /// Absent, with the other pricing members, for a model that has no price.
    pricingSource: AgentModelPricingSource

    /// ISO 8601 instant of this pricing fetch.
    @timestampFormat("date-time")
    pricingRefreshedAt: Timestamp

    inputPricePer1KTokens: Double

    outputPricePer1KTokens: Double

    cacheReadPricePer1KTokens: Double

    cacheWritePricePer1KTokens: Double
}

list AgentModelInfoList {
    member: AgentModelInfo
}

/// How a model's rates were sourced.
enum AgentModelPricingSource {
    AGREEMENT_OFFERS = "agreement-offers"
    PRICE_LIST = "price-list"
}

/// Whether a catalog entry originated from `ListFoundationModels` or
/// `ListInferenceProfiles`. This is the authoritative discriminator
/// for displaying model type in the UI.
enum AgentModelType {
    FOUNDATION_MODEL = "foundation-model"
    INFERENCE_PROFILE = "inference-profile"
}
