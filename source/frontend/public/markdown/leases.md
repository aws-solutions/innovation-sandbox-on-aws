---
title: Leases
---

The **Leases** page displays all the leases currently in your sandbox environment.

**Leases**: A lease is a temporary assignment of an AWS account to a user for a specified budget and duration. Leases can be created through user requests or direct assignment by Admins and Managers.

**Lease Template**: A lease template defines the conditions that govern the use of the account - such as approval for a user to use a given account, budget and threshold actions, lease duration and threshold actions, and visibility controls.

**Status**: State that is maintained by the solution throughout it's sandbox usage lifecycle. Refer to the [Account states](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/use-the-solution.html#understand-states) section.

---

**Admins and Managers**

**Lease Assignment**: You can create leases directly for other users by selecting any available lease template (public or private) and specifying the target user's email address. The lease will be created immediately without approval.

**Note**: The email address must already be registered under the IDC user group before a lease can be assigned.

Refer to the [Managing leases](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#manage-leases) section.
**Manage Existing Leases**: To update current lease settings, under the Leases section, select the name of the lease. You can modify lease settings such as updating the lease status, extending the budget, extending lease duration, updating thresholds or changing cost reporting assignment. You can only update leases that are currently **Active** or **Frozen**. You can also unfreeze **Frozen** leases - note that if a lease was frozen due to reaching thresholds, you should update the budget or duration limits before unfreezing to prevent automatic refreezing.

Refer to the [Assigning leases to users](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#assigning-leases) and [Managing leases](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#manage-leases) sections.
