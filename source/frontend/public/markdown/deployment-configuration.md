---
title: Deployment configuration
---

Configure how your blueprint deploys StackSet instances to sandbox accounts.

---

**Deployment strategy**

- **Default**: Deploys to one Region at a time. Stops on the first failure. Safest option.
- **Custom**: Configure deployment speed and failure handling manually.

---

**What happens when a deployment fails?**

If the blueprint deployment fails, the lease is terminated and the account is sent to cleanup. The user does not receive access.

Each blueprint deployment targets one sandbox account in every selected Region. Failure tolerance applies to target accounts within each Region, not to the percentage of selected Regions. Values below 100% tolerate zero failures because each Region has one target account. At 100%, CloudFormation can mark the operation successful even if resources are missing in any or all target Regions, and the user receives the account.

---

**Custom parameters**

**Concurrent deployments**
Percentage of target accounts to deploy concurrently in each Region. Because each blueprint deployment targets one account, every value results in one concurrent account per Region. Use **Concurrency type** to control whether Regions run sequentially or in parallel.

**Failure tolerance**
Percentage of target accounts that can fail in each Region before the deployment stops. With one target account, values below 100% tolerate zero failures; 100% tolerates one failure.

**Concurrency type**
Sequential (one Region at a time) or Parallel (multiple Regions at once).

**Concurrency mode**
Strict (slow down on failure) or Soft (keep going at full speed).

---

**Timeout**

Maximum time to wait for deployment to complete. Sequential deployments across multiple Regions need longer timeouts.

---

For more information, see [Registering a new blueprint](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/administrator-guide.html#registering-blueprint) in the implementation guide.
