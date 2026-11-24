---
title: Lease policies
---

Set deployment-wide limits for lease templates and control how users request and access leases.

## Budget and duration

Set **Max budget** and **Max lease duration** to limit the values managers can use in lease templates. Lowering a limit does not change existing templates or leases until they are edited.

Turn on **Require max budget** or **Require max duration** to require that limit when a template is created or edited.

## Cost tracking

Turn on **Allow estimated cost tracking** so lease templates can use estimated current spending for budget controls. Estimates account for delays in AWS billing data.

Turn on [**Allow Bedrock token monitoring**](/settings#setting-leases-allowBedrockTokenMonitoring) so lease templates and leases can track Amazon Bedrock token costs before they appear in billing data. Leases with a Sandbox Space always use this monitoring, even when the setting is off. Existing leases keep their saved monitoring preference.

## Lease limits

- **Lease request rate limit**: Set how many requests a user can make in a rolling period and the period's length in hours. Both values must be at least 1. The period cannot exceed **Lease record retention (days)**.
- **Max leases per user**: Limit the active leases and pending requests a user can have at once. Users above a new limit keep their leases, but cannot request more.

## Lease access

- **Allow lease sharing**: Permit lease owners to share access. Templates can restrict sharing further. Administrators and managers retain access.
- **Principal search**: Show user suggestions when assigning or sharing a lease. When off, user identifiers must be entered exactly.
- **Allow group assignments**: Permit assignments to IAM Identity Center groups. When off, group search is unavailable, but existing assignments keep working and can still be removed.
- **Allow users to terminate their own leases**: Permit users to end their leases. When off, only administrators and managers can terminate leases.

## Data retention

Use **Lease record retention (days)** to control how long ended leases remain in the **Leases** list. Deletion can take up to 48 hours after the retention period ends.

For service cost breakdown and cost report groups, open [**Cost**](/settings#cost).
