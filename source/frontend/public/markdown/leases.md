---
title: Leases
---

View and manage all leases in your sandbox environment. A lease is a temporary assignment of an AWS account to a user with defined budget and duration limits.

---

## Assign Leases

Create leases directly for other users without requiring approval. Choose any template (public or private) and specify the user's email address.

Choose **Assign lease** to start the wizard.

_Note: User email must exist in IAM Identity Center before assignment._

For more information, see [Assigning leases](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#assigning-leases).

---

## Update Leases

Modify settings for **Active** or **Frozen** leases. Select a lease name to edit:

- Budget settings (maximum spend, thresholds)
- Duration settings (expiration date, thresholds)
- Cost report group assignment

Changes apply immediately to the selected lease.

For more information, see [Updating leases](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#updating-leases).

---

## Freeze Leases

Temporarily suspend user access while preserving account resources. Select a lease and choose **Freeze** from the Actions menu.

_Note: Frozen accounts may still incur costs from running resources._

---

## Terminate Leases

End a lease and initiate account cleanup. Select a lease and choose **Terminate** from the Actions menu.

_Note: Terminated leases cannot be reactivated. Users must request a new lease._

---

## Unfreeze Leases

Restore user access to frozen leases. Select a frozen lease and choose **Unfreeze** from the Actions menu.

_Note: If frozen by thresholds, update budget or duration limits first to prevent automatic refreezing._

---

## Lease States

View current lease status to understand account lifecycle stage.

For status details, see [Lease states](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#understand-lease-states).
