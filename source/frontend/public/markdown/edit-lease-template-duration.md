---
title: Edit Duration Settings
---

Configure time limits and duration thresholds for leases.

---

**Maximum Duration**: Set how long leases remain active (in hours). Your organization may enforce a global maximum.

**Duration Thresholds**: Configure automated actions based on time remaining:

- **Alert**: Sends email notification
- **Freeze Account**: Prevents new resource creation (existing resources continue running)

---

**Lease Termination**: When a lease reaches maximum duration, the account is automatically terminated and all resources are cleaned up.

_Note: Changes apply to new leases only. Existing leases keep their original duration settings._

For more information, see [Duration thresholds](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#duration-thresholds) in the implementation guide.
