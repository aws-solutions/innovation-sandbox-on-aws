---
title: Deployment configuration
---

Configure how your blueprint deploys StackSet instances to sandbox accounts.

---

**Deployment strategy**

- **Default**: Deploys one region at a time. Stops on first failure. Safest option.
- **Custom**: Configure deployment speed and failure handling manually.

---

**What happens when a deployment fails?**

If the blueprint deployment fails, the lease is terminated and the account is sent to cleanup. The user does not receive access.

If failure tolerance is above 0%, some regions can fail without failing the overall deployment. The user receives their account, but resources may be missing in failed regions.

---

**Custom parameters**

**Concurrent deployments**
How many regions deploy at the same time. 100% means all at once. Lower values are safer.

**Failure tolerance**
How many regions can fail before the deployment stops. 0% means stop on first failure.

**Concurrency type**
Sequential (one region at a time) or Parallel (multiple at once).

**Concurrency mode**
Strict (slow down on failure) or Soft (keep going at full speed).

---

**Timeout**

Maximum time to wait for deployment to complete. Sequential deployments across multiple regions need longer timeouts.
