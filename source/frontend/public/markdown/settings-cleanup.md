---
title: Account cleanup
---

Configure how sandbox accounts are cleaned and returned to the account pool after a lease ends.

## Cleanup attempts

Accounts are cleaned with AWS Nuke. These settings apply to cleanups that start after you save:

- **Failed attempts before quarantine**: The number of failed runs before an account is quarantined for manual review.
- **Successful attempts to finish**: The number of successful runs required to finish cleanup.
- **Wait before retry (seconds)**: The delay between failed runs.
- **Wait before rerun (seconds)**: The delay between successful runs.

## Account lifecycle

Set **Account cooldown (hours)** to delay returning an account to the available pool after cleanup. Set it to 0 for no cooldown.

## Data retention

Use **Cleanup report retention (days)** to control how long cleanup reports are kept before they are deleted.

## Cleanup validation

Cleanup validation is experimental. It uses AWS Resource Explorer to check for remaining resources after cleanup.

For **On validation failure**, choose:

- **Silent** (default): Return the account to the available pool without a validation warning.
- **Warn**: Include remaining resources in the cleanup report, but return the account to the available pool.
- **Quarantine**: Quarantine the account for manual review.

When you choose **Warn** or **Quarantine**, set **Account cooldown (hours)** to at least 168 hours (7 days). AWS Resource Explorer can take time to reflect deletions, so a shorter cooldown can report resources that have already been removed.

For more information, see [Account Cleaner components](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/architecture-details.html#account-cleaner-component) and [Resolving cleanup failures](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/troubleshooting.html#resolving-cleanup-failures) in the implementation guide.
