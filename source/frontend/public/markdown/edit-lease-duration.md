---
title: Edit Lease Duration Settings
---

Update expiration date and duration thresholds for this active lease.

---

**Expiration Date**: Set or modify when the lease will automatically terminate. Your organization may enforce a global maximum duration.

**Duration Thresholds**: Configure automated actions based on time remaining:

- **Alert**: Sends email notification
- **Freeze Lease**: Prevents new resource creation (existing resources continue running)

---

**Lease Termination**: When a lease reaches its expiration date, the account is automatically terminated and all resources are cleaned up.

_Note: Changes take effect immediately. If the lease was frozen due to reaching a duration threshold, consider extending the expiration date before unfreezing._

For more information, see [Duration thresholds](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#duration-thresholds) in the implementation guide.
