$version: "2"

namespace com.amazon.isb

use aws.protocols#restJson1

// ---------------------------------------------------------------------------
// Permission set models
// Constraint source:
// https://docs.aws.amazon.com/singlesignon/latest/APIReference/API_PermissionSet.html
// ---------------------------------------------------------------------------
/// IAM Identity Center permission set ARN.
@length(min: 10, max: 1224)
@pattern("^arn:aws(?:-[a-z]{1,5}){0,3}:sso:::permissionSet/(?:sso)?ins-[a-zA-Z0-9.-]{16}/ps-[a-zA-Z0-9./-]{16}$")
string PermissionSetArn

/// Stable permission set identifier parsed from the ARN.
@pattern("^ps-[a-zA-Z0-9./-]{16}$")
string PermissionSetId

@length(min: 1, max: 32)
@pattern("^[a-zA-Z0-9_+=,.@-]+$")
string PermissionSetName

@length(min: 1, max: 700)
@pattern("^[\\u0009\\u000a\\u000d\\u0020-\\u007e\\u00a1-\\u00ff]*$")
string PermissionSetDescription

@length(min: 1, max: 100)
@pattern("^-?P(?=\\d|T\\d)(?:(\\d+)Y)?(?:(\\d+)M)?(?:(\\d+)([DW]))?(?:T(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+(?:\\.\\d+)?)S)?)?$")
string PermissionSetSessionDuration

// Backend-hydrated projection for persisted permission set ARN references.
// Metadata is optional when the cache no longer contains the referenced set;
// callers still receive the ARN/ID and an explicit availability state.
enum PermissionSetAvailability {
    AVAILABLE
    UNAVAILABLE
}

structure PermissionSetReference {
    @required
    permissionSetArn: PermissionSetArn

    @required
    permissionSetId: PermissionSetId

    name: PermissionSetName

    description: PermissionSetDescription

    sessionDuration: PermissionSetSessionDuration

    @required
    availability: PermissionSetAvailability
}

list PermissionSetReferenceList {
    member: PermissionSetReference
}

// Per-domain service for the permission-sets Lambda. The aggregate `IsbApi`
// owns the generated client and OpenAPI operation; this service owns the
// generated server handler for the domain.
@restJson1
@title("Innovation Sandbox on AWS — Permission Sets")
service PermissionSetsApi {
    version: "2026-09-17"
    operations: [
        ListPermissionSets
    ]
    errors: [
        ValidationError
        UnauthenticatedError
        AccessDeniedError
        InternalServerError
    ]
}

/// Lists permission sets available for sandbox lease permission profiles.
///
/// Accessible only to Admin and Manager roles.
///
/// Results are ordered by normalized name and permission set identifier. The
/// optional search query performs a case-insensitive substring match against
/// name and description. Callers must treat pagination tokens as opaque.
@examples([
    {
        title: "List permission sets"
        input: { q: "hackathon", maxResults: 50 }
        output: {
            status: "success"
            data: {
                result: [
                    {
                        permissionSetArn: "arn:aws:sso:::permissionSet/ins-1234567890abcdef/ps-7a8b9c0d1e2f0003"
                        permissionSetId: "ps-7a8b9c0d1e2f0003"
                        name: "HackathonDev"
                        description: "Denies GPU and high-core-count instances"
                        sessionDuration: "PT4H"
                    }
                ]
            }
        }
    }
])
@http(method: "GET", uri: "/permissionSets", code: 200)
@readonly
@tags(["permissionSets"])
@paginated(
    inputToken: "pageIdentifier"
    pageSize: "maxResults"
    outputToken: "data.nextPageIdentifier"
    items: "data.result"
)
operation ListPermissionSets {
    input := {
        /// Opaque continuation token returned by a previous response.
        @httpQuery("pageIdentifier")
        pageIdentifier: ContinuationToken

        /// Maximum number of permission sets to return. Defaults to 50 when
        /// omitted and must be between 1 and 100 when supplied.
        @httpQuery("maxResults")
        @range(min: 1, max: 100)
        maxResults: Integer

        /// Case-insensitive substring matched against name and description.
        /// An omitted or empty value returns all available permission sets.
        @httpQuery("q")
        @length(max: 200)
        q: String
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: PermissionSetPage
    }
}

/// Public catalog summary for one available permission set.
structure PermissionSetSummary {
    @required
    permissionSetArn: PermissionSetArn

    @required
    permissionSetId: PermissionSetId

    @required
    name: PermissionSetName

    description: PermissionSetDescription

    sessionDuration: PermissionSetSessionDuration
}

list PermissionSetSummaryList {
    member: PermissionSetSummary
}

/// Paginated permission-set catalog payload.
structure PermissionSetPage {
    @required
    result: PermissionSetSummaryList

    /// Opaque continuation token. Omitted on the final page.
    nextPageIdentifier: ContinuationToken
}
