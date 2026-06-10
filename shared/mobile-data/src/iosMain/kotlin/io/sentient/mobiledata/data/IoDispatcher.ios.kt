package io.sentient.mobiledata.data

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.newSingleThreadContext

/**
 * iOS (native): Kotlin/Native has no `Dispatchers.IO`, so we dedicate a single
 * background thread to blocking SQLite writes. Serial is exactly what SQLite wants
 * (one writer), and it keeps disk I/O off the CPU `Dispatchers.Default` pool.
 *
 * The context is process-lived (one DB-writer thread for the whole app run) and is
 * intentionally never closed — hence the DelicateCoroutinesApi opt-in.
 */
@OptIn(DelicateCoroutinesApi::class)
private val dbIoDispatcher: CoroutineDispatcher = newSingleThreadContext("sentient-db-io")

internal actual fun ioDispatcher(): CoroutineDispatcher = dbIoDispatcher
