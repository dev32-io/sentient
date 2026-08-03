// `pendingId` namespacing (session-model spec §3.8) — resend idempotency that
// works PER WINDOW instead of colliding across them.
//
// THE PROBLEM. `findByPendingId(sessionId, pendingId)` is the durable
// client-resend record (session-store.ts), and it is SESSION-scoped. That was
// right when a session had one window. With N windows appending to one session,
// two windows that happen to reuse a value make the second message vanish:
// `SessionRuntime.submit` finds the first window's entry, re-echoes it, and
// commits nothing. A lost message that looks exactly like a network fault.
//
// THE KEY HAS TO OUTLIVE A RECONNECT, which rules out the obvious namespaces.
// The whole point of the record is that a resend after a dropped socket still
// matches, so it cannot be keyed on the connection or on the ATTACHMENT — both
// are reminted on every reconnect, and namespacing by either would make every
// resend a fresh message. The SURFACE is the one identifier with the right
// lifetime: one browser tab / one app instance, stable across its own
// reconnects, distinct between windows. Per §3.4 it gates nothing and is used
// here purely as a client identifier, which is exactly what it is retained for.
//
// FIXED-WIDTH PREFIX, NOT A DELIMITER SPLIT. `pendingId` is a free-form client
// string, so any separator could appear inside one. The prefix is `w` + 8 hex +
// `.` — always 10 characters — so unscoping is a slice, never a search, and a
// client value containing dots is unaffected.
//
// THE HASH IS A NAMESPACE, NOT A SECRET. FNV-1a/32 is used because it is
// synchronous, dependency-free and deterministic; nothing here defends against
// an adversary, and a hash collision between two live surfaces (1 in 2^32)
// merely restores the pre-§3.8 behaviour for that pair rather than crossing any
// boundary.
//
// LEGACY ROWS PASS THROUGH UNCHANGED. Stores written before this change hold
// bare client values, and `unscopePendingId` returns anything that does not
// carry the prefix verbatim. A raw UUID can never be mistaken for a scoped id:
// a UUID's 9th character is `-`, and the prefix requires `.` there.

const PREFIX_MARKER = "w";
const PREFIX_SEPARATOR = ".";
const HASH_HEX_LENGTH = 8;
/** `w` + 8 hex + `.` */
const PREFIX_LENGTH = 1 + HASH_HEX_LENGTH + 1;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HEX_RADIX = 16;

/** FNV-1a/32 of [value], as fixed-width lowercase hex. */
function windowKey(value: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(HEX_RADIX).padStart(HASH_HEX_LENGTH, "0");
}

/**
 * The store key for [pendingId] as issued by [surfaceId].
 *
 * Called at the command mediator's accept path, so every stored `pending_id` in
 * a session written after this change is namespaced and no two windows can
 * dedup each other away.
 */
export function scopePendingId(surfaceId: string, pendingId: string): string {
  return `${PREFIX_MARKER}${windowKey(surfaceId)}${PREFIX_SEPARATOR}${pendingId}`;
}

/**
 * The CLIENT's own value back out of a stored key.
 *
 * Called in `client-projection.ts` — the single path from stored state to a
 * feed item — because the client reconciles its optimistic bubble against the
 * value it sent. Echoing the namespaced form would leave that bubble
 * unreconciled and render the message twice.
 */
export function unscopePendingId(stored: string): string {
  if (stored.length <= PREFIX_LENGTH) return stored;
  if (!stored.startsWith(PREFIX_MARKER)) return stored;
  if (stored[PREFIX_LENGTH - 1] !== PREFIX_SEPARATOR) return stored;
  const key = stored.slice(1, 1 + HASH_HEX_LENGTH);
  if (!/^[0-9a-f]{8}$/.test(key)) return stored;
  return stored.slice(PREFIX_LENGTH);
}
