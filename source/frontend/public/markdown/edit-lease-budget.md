---
title: Edit Lease Budget Settings
---

Configure cost tracking, a maximum budget, budget thresholds, and spend rate thresholds for this active lease.

---

**Estimated cost tracking**: Estimates this lease's current cost from the trend in its reported spend. Budget thresholds can use estimated cost, and spend rate thresholds become available. Turning it off deletes the spend rate thresholds and makes estimated-cost thresholds use reported cost.

**Amazon Bedrock token monitoring**: Monitors and attributes this lease's Amazon Bedrock token usage to its budget between Cost Explorer reports. It is required while Sandbox Spaces is enabled on the lease, so it cannot be changed then.

While an administrator has turned either feature off under **Lease Policies** on the Settings page, a lease already using it may only switch it off. It cannot turn the feature on again until the global setting returns. Enabling Sandbox Spaces still turns Amazon Bedrock token monitoring on.

**Maximum budget**: Sets the terminate threshold. When current cost reaches it, the lease is terminated and irreversible account cleanup starts. Current cost is the higher of reported cost and, when Amazon Bedrock token monitoring is on, reported cost with billed Amazon Bedrock charges replaced by the monitored token cost. Estimated cost never terminates a lease. Your organization may require a maximum or set a global limit.

**Budget thresholds**: Send an alert or freeze the lease when reported or estimated cost reaches an amount. Each amount must be less than the Terminate lease amount. You can add one Freeze lease threshold.

**Spend rate thresholds**: Send an alert or freeze the lease when its estimated spending rate crosses an hourly or daily threshold.

---

_Note: Changes take effect immediately. If the lease was frozen after reaching a budget threshold, consider increasing the budget before unfreezing._

For more information, see [Budget thresholds](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#budget-thresholds) in the implementation guide.
