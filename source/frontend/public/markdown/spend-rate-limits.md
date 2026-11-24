---
title: Spend rate thresholds
---

Send an alert or freeze a lease when it is spending faster than a set amount, regardless of its total spend.

---

**Rate (USD)**: The threshold amount in US dollars per period. It must be greater than zero.

**Period**: Which estimated rate the threshold is compared against. _Per hour_ uses the lease's measured hourly spending rate: the change between its two most recent billing readings over the hours between them. _Per day_ uses the measured daily rate: the change against the reading closest to 24 hours earlier, expressed per day.

**Action**: _Send alert_ notifies the lease owner. _Freeze lease_ freezes the lease, as a budget threshold set to freeze does. A spend rate threshold never terminates a lease; the maximum budget controls termination.

**Several thresholds**: Add up to 10 thresholds on either period and with either action. Two thresholds cannot share both a period and a rate.

**Which notification is sent**: Every crossed threshold is recorded in the lease's breach history. Within one period, the highest crossed alert threshold is the one alerted on, and a crossed freeze threshold at or above it replaces that alert with the freeze. When both periods cross in the same check, one alert and one freeze are raised at most, each for the threshold exceeded by the larger share of itself. Budget thresholds crossed in the same check take precedence: any crossed budget threshold, alert or freeze, means no spend rate alert is sent, and a budget freeze is requested instead of a spend rate freeze. A spend rate freeze and a budget alert can both be raised in the same check. Reaching the maximum budget still ends the lease and overrides all of these actions.

**Estimates, not charges**: A spending rate is an estimate of how fast cost is accruing, calculated from billing readings rather than a confirmed charge. When Amazon Bedrock token monitoring is on, the rate includes monitored Amazon Bedrock token cost. The separately recorded Sandbox Spaces estimated token cost is attribution only; it is not added again to spend rate thresholds, dollar budget thresholds, or the maximum budget because inference already reaches those controls through the sandbox account's billed cost and token monitoring.

**One action per crossing**: A rate that stays above a threshold does not fire again every hour. If it falls below the threshold and rises through it again, it fires again. Adding a threshold, or lowering one, below the lease's current measured rate does not fire it immediately: it fires only after the rate falls below the threshold and later crosses it. A frozen lease is not checked against its spend rate thresholds until it is unfrozen.

**Needs about a day of history**: Rates require two differing billing readings, roughly a day into a lease. Until then no rate exists and the thresholds are not checked.

---

_Note: Spend rate thresholds are available only when estimated cost tracking is on._
