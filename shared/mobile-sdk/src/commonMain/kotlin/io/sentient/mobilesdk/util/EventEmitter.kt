package io.sentient.mobilesdk.util

/**
 * Typed single-event emitter — port of web-sdk event-emitter.ts.
 *
 * On(), emit(), removeAll() mirror the web-sdk TypedEmitter surface.
 * emit() snapshots handlers via toList() before iterating so a handler that
 * unsubscribes itself or another handler mid-emit neither throws nor silently
 * drops already-registered invocations.
 *
 * No error isolation — mirrors web-sdk: a throwing handler propagates and
 * stops remaining handlers. Callers that need isolation wrap their handler body.
 *
 * Usage:
 *   val emitter = EventEmitter<MyEvent>()
 *   val off = emitter.on { event -> ... }
 *   emitter.emit(MyEvent(...))
 *   off() // unsubscribe
 */
class EventEmitter<T> {
    private val handlers = mutableSetOf<(T) -> Unit>()

    /** Subscribe [handler] and return an unsubscribe lambda. */
    fun on(handler: (T) -> Unit): () -> Unit {
        handlers.add(handler)
        return { handlers.remove(handler) }
    }

    /**
     * Emit [value] to all currently subscribed handlers.
     * Iterates a snapshot so mid-emit unsubscription is safe.
     */
    fun emit(value: T) {
        handlers.toList().forEach { it(value) }
    }

    /** Remove all subscribed handlers. */
    fun removeAll() {
        handlers.clear()
    }
}
