---
title: Edit Blueprint Selection
---

Attach or remove a blueprint to control whether users receive pre-configured infrastructure.

---

**With Blueprint**: Users receive accounts with automatically deployed resources (adds 5-30 minutes to provisioning).

**Without Blueprint**: Users receive empty AWS accounts.

---

When a blueprint is attached:

1. User requests lease
2. Manager approves (if required)
3. Blueprint deploys automatically
4. User receives account with infrastructure

If deployment fails, the lease is automatically terminated.

---

_Note: Changes only affect new leases. Existing leases keep their deployed resources._

For more information, see [Creating and managing lease templates](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#creating-managing-lease-templates) in the implementation guide.
