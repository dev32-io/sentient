package io.sentient.mobiledata.data

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers

/** JVM/Android: the real elastic IO pool for blocking SQLite writes. */
internal actual fun ioDispatcher(): CoroutineDispatcher = Dispatchers.IO
