---
title: Lease Details
---

View settings and status for this lease.

---

## Lease sections

**Basic Information**: User email, account ID, lease template, and current status

**Budget Settings**: Spending limits and threshold-based alerts or freezes

**Duration Settings**: Expiration date and duration-based alerts or freezes

**Cost Report Settings**: Cost allocation group assignment

**Access settings**: Whether the lease owner can manage assignments, the default permission set, and additional permission sets available for assignments

**Sandbox Spaces Settings**: AI chat access and available models

---

## Cost tab

The **Cost** tab shows what this lease has spent, how fast it is spending, its top services, Amazon Bedrock token usage where token monitoring is on, and every threshold that has fired. Admins, Managers, and the lease owner see it while the lease is **Active** or **Frozen**, and after it has ended.

Choose the **Cost** tab for detailed help with the cost figures and charts.

---

## Assignments tab

The **Assignments** tab shows one row for each user or group with access to this lease. Each principal uses one permission set. Admins, Managers, and the lease owner (when lease sharing is enabled globally and **Allow owner to share lease** is on) can add, remove, or change access from this tab.

Assignments can only be changed while the lease is **Active**. On a **Frozen** lease the tab is read-only and shows the access that will be restored when the lease is unfrozen. On a terminated lease it shows the final assignment state for audit and remediation.

Choose the **Assignments** tab for detailed help with staged changes and processing states.

---

## Editing settings

**Admins and Managers** can choose **Edit** on any section to modify settings. Changes take effect immediately for this lease.

**Lease Owners** can view all settings and manage assignments when sharing is enabled.

**Shared Users** can view lease details and choose **Login to account** to access the sandbox.

_Note: You can only edit leases that are currently **Active** or **Frozen**._

For more information, see [Managing leases](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#manage-leases) in the implementation guide.
