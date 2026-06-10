package io.sentient.mobiledata.data

import kotlinx.coroutines.CoroutineDispatcher

/**
 * Platform IO dispatcher for blocking disk I/O (SQLite writes in the chat mirror).
 *
 * `Dispatchers.IO` is NOT a commonMain API in kotlinx-coroutines 1.11.0 — it only
 * exists on the JVM. Kotlin/Native has no shared IO thread pool, so the seam is an
 * expect/actual:
 *   - Android (JVM) → the real `Dispatchers.IO` elastic pool.
 *   - iOS (native)  → a dedicated single background thread off the CPU pool.
 *
 * The platform owner derives the value once and injects it into the caching
 * decorator so DB writes never run on the CPU (`Dispatchers.Default`) scope.
 */
internal expect fun ioDispatcher(): CoroutineDispatcher
