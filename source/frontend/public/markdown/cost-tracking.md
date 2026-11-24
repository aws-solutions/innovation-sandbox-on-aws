---
title: Cost tracking
---

Measure each lease's current spend between billing reports and account for Amazon Bedrock token usage before it reaches the bill.

---

## Estimated cost tracking

**What it does**: AWS billing data lags real spend by several hours. Estimated cost tracking measures each lease's spending rate from its billing history and carries the reported total forward to now, covering money already spent but not yet billed.

**What it unlocks**: Budget thresholds can use **estimated cost** instead of reported cost, so alerts and freezes can happen earlier. **Spend rate thresholds** also become available, alerting or freezing the lease when its spending rate crosses a configured amount.

**Estimated to now, not to the end of the lease**: The estimate describes what a lease has spent as of the latest monitoring run. It is never extrapolated to the end of the lease, and ISB does not evaluate a threshold against a future forecast.

**Needs up to two days of history**: A spending rate exists only after two differing billing readings, which can take up to two days. Leases shorter than 48 hours may not produce an estimate, so estimated-cost thresholds may never fire for them.

**Turning it off**: Turning estimated cost tracking off removes the lease or template's spend rate thresholds. Budget thresholds configured to use estimated cost are saved as reported-cost thresholds instead.

**Template and global settings**: Leases copy the template's setting when they are created. Changing the template later does not affect existing leases. A manager or administrator can change estimated cost tracking for one lease from that lease's budget settings. An administrator controls whether templates and leases may enable the feature under **Lease Policies** on the Settings page. A template or lease already using the feature may turn it off while the global setting is disabled, but it cannot turn the feature back on until an administrator enables it globally.

## Amazon Bedrock token monitoring

**What it does**: Amazon Bedrock token monitoring reads each lease's token usage about every ten minutes and prices it before that usage reaches AWS Cost Explorer. ISB replaces billed Amazon Bedrock charges with the monitored token cost, so the same usage is not counted twice. When the replacement includes model usage that AWS Cost Explorer has not billed yet, the token-adjusted current cost is higher than the bill.

**What it changes**: Reported-cost thresholds see Amazon Bedrock spend before it appears on the bill. When estimated cost tracking is also on, estimated cost and spend rate thresholds include that spend.

**Unpriced models**: Tokens from a model without pricing data are not treated as free. Until ISB can price them, the lease continues using its billed total.

**Template, Sandbox Spaces, and global settings**: Leases copy the template's effective token-monitoring setting when they are created. A manager or administrator can change the setting for one lease from that lease's budget settings. An administrator controls whether templates and leases may enable token monitoring under **Lease Policies** on the Settings page. Amazon Bedrock token monitoring is required while Sandbox Spaces is enabled. Disabling Sandbox Spaces leaves monitoring on unless the global setting is off. While the global setting is off, a template or lease already using token monitoring may turn it off but cannot turn it back on. Turning monitoring on for an existing lease may not take effect until the next hourly cost check. Until then, the lease is checked against its billed total.

## Maximum-budget evaluation

The maximum budget uses **current cost**. Current cost is the higher of reported cost and, when Amazon Bedrock token monitoring is on, reported cost with billed Amazon Bedrock charges replaced by the monitored token cost. Reaching the maximum budget through either path terminates the lease. Estimated cost never terminates a lease.
