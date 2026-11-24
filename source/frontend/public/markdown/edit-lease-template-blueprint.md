---
title: Blueprint
---

Choose whether leases created from this template start with a blueprint's resources already deployed in their sandbox accounts.

---

**Deploy a blueprint**: When enabled, select one blueprint to give users a ready-to-use environment. When disabled, users receive an empty account.

When a blueprint is selected:

1. A user requests a lease.
2. A manager approves the request, if approval is required.
3. The blueprint deploys automatically.
4. The user receives access to the account and its deployed resources.

Blueprint deployment typically adds 5-30 minutes to provisioning. If deployment fails, the lease is automatically terminated.

---

_Note: Changes affect new leases only. Existing leases keep their deployed resources._

For more information, see [Creating and managing lease templates](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#creating-lease-templates) in the implementation guide.
