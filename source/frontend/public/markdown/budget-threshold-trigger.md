---
title: Budget threshold cost basis
---

Choose which cost basis each budget threshold uses. Estimated cost is available only when estimated cost tracking is on for the lease template or lease. A lease copies the setting from its template when it is created, and a manager or administrator can change it in the lease's budget settings.

---

**Reported cost**: The billed total from AWS Cost Explorer. This is the default and matches how thresholds have always worked. Billing data lags real spend by several hours, so a reported-cost threshold fires once the bill catches up. With Amazon Bedrock token monitoring on, reported-cost thresholds compare against the billed total with its Amazon Bedrock token charges replaced by the monitored Amazon Bedrock token cost, so they see model spend before the bill does.

**Estimated cost**: The reported total carried forward to now at the lease's measured spending rate. Estimated cost is never below reported cost at any given check, so an estimated-cost threshold fires no later than a reported-cost threshold at the same amount and usually fires hours earlier.

**Amounts**: Every threshold, whichever cost basis it uses, must be less than the Terminate lease amount, which is the maximum budget.

**A threshold added below the current estimate never fires**: An estimated-cost threshold fires when the estimate crosses it between one hourly check and the next. On an active lease already estimated above a new threshold, there is no crossing left to detect, so it never fires. Add it above the lease's current estimated cost, or use reported cost instead.

**An estimated-cost threshold can fire more than once**: If the estimate drops back below a threshold, after resources are torn down or when a billing refresh re-bases the figure, and later climbs over it again, the threshold fires again. It describes a current condition, not a recorded one.

**Frozen leases**: Estimated-cost thresholds pause while a lease is frozen and resume when it is unfrozen. Thresholds crossed during the freeze do not fire afterwards. Reported-cost thresholds and the maximum budget are unaffected.

---

_Note: The maximum budget uses current cost, which is the higher of reported cost and, when Amazon Bedrock token monitoring is on, reported cost with billed Amazon Bedrock charges replaced by the monitored token cost. Estimated cost never terminates a lease. Only one Freeze lease threshold is allowed, whichever cost basis it uses._
