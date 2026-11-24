---
title: Lease Cost
---

What this lease has spent, how fast it is spending, and every threshold that has fired.

---

**Billed to date**: The total AWS Cost Explorer has billed for this account. Billing data lags real spend by several hours, so this figure sits behind what the account has actually used.

**Estimated cost**: The billed total carried forward at the lease's measured spending rate, prefixed with ≈. For a running lease it estimates cost as of now; for an ended lease it stops at the actual lease end. It never estimates what a running lease will have cost by its scheduled end.

**Spend rate**: The hourly and daily rates, each stated with the window it was measured over. A rate measured over a short window is a weak basis for the estimate above it.

**Billing data covers**: The billing day the reported figures come from, and how long ago the lease was last checked. Every figure in this section describes that instant, so it can be up to an hour old.

**Amounts under a cent**: An amount above zero that would round to USD 0.00 shows as < USD 0.01, so a small spend never reads as none.

---

**Spend over time**: The stepped line is the billed total at each reading. The line continuing past it is the estimate that was current at the newest reading, and the fainter line beyond that is the trajectory toward the maximum budget.

Estimated-cost thresholds are evaluated where the full-weight estimate ends, not anywhere along the fainter trajectory. The trajectory is a forecast of money not yet spent, drawn so the remaining budget headroom is visible.

**Previous estimates**: The estimates that were current at earlier readings, each one re-based on the billing data available at the time. A break in the line is a monitoring run that recorded nothing, not a period without spend.

---

**Top services**: The services in the newest reading ranked by cost, with each one's share of the billed total and how it changed since the reading before. An empty table means no per-service breakdown could be attributed to the total, not that nothing was spent.

---

**Bedrock token usage**: Shown where Bedrock token monitoring is on for the lease. The figures at the top are the lease's latest whatever range is picked; the range picker beside **Tokens used per hour** or **per day** sets what the charts cover, and its whole lease starts at the lease's first token reading. **Tokens used so far** is every token the lease has counted, as of the last time the counts changed. **Tokens used per hour**, or **per day** where the charts cover more than two days, shows the tokens used in each period, stacked by model or by token type, so the top of the stack is that period's total, and the first and last periods can be partial; past five models, the ones with the fewest tokens over the lease share an **Other models** band. **Estimated Bedrock token cost** is what the tokens used in each period cost, an estimate priced from the monitored token counts rather than a billed figure. Each token is priced at the price in force when it was counted, so a later price change does not reprice tokens counted before it.

**Spend for budget thresholds**: The billed total with its Amazon Bedrock token charges replaced by **Monitored Bedrock token cost**, the cost of the tokens counted so far. The replacement happens once the bill's share of Amazon Bedrock token charges is known, so for a new lease this figure can trail the monitored figure for a while. It is prefixed with ≈ because measuring the Amazon Bedrock part does not make the total a billed figure, and it usually sits above the billed total while billing catches up. With estimated cost tracking on, the estimated cost is carried forward from this figure instead of the billed total.

A gap in the estimated cost line is a stretch whose tokens could not all be priced. ISB leaves those tokens out rather than count them as free, so a gap is not a stretch without spend; their cost is counted in the next period that could be priced, and for a narrower range that can be its first period. If no reading could be priced, the estimated cost chart says so instead of drawing a line at zero. Tokens counted as unattributed could not be matched to a model and are not included in the estimated cost. Where the panel shows no charts, no token usage has been read yet, or, for a narrower range, the counts did not change in it; it never means nothing was spent.

---

**Breach history**: The thresholds that have fired, with the figures as they stood at the time. Nothing in it is recalculated from the current cost, and a projected figure is prefixed with ≈.

---

_Note: where estimated cost tracking is off for a lease, this section shows billed figures, top services, Amazon Bedrock token usage where token monitoring is on, and breach history only. Estimated cost tracking is set in the lease's budget settings, not here._
