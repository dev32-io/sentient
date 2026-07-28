// The pair a session's composition root hands back (Plan 3 Task 6). Both
// objects are connection-scoped and torn down together: `runtime.dispose()`
// aborts the in-flight turn and closes the store handle;
// `permissions.denyAll()` settles any open permission prompt so a dropped
// socket cannot leave a ReAct turn awaiting an answer that will never come.

import type { PermissionBroker } from "./permission-broker.js";
import type { SessionRuntime } from "./session-runtime.js";

export interface SessionHandles {
  runtime: SessionRuntime;
  permissions: PermissionBroker;
}
