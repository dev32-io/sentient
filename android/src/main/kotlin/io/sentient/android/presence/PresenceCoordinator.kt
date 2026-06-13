// ---------------------------------------------------------------------------
// PresenceCoordinator — app-scoped foreground/background signal forwarder.
//
// Observes ProcessLifecycleOwner (onStart = foreground, onStop = background)
// and forwards both signals to whatever ChatSession is currently bound.
// Holds NO chat or session state — it is purely a presence signal relay.
//
// Lifecycle contract:
//   start()   — register with ProcessLifecycleOwner (call once in Application.onCreate).
//   bind()    — attach the active chat session's foreground/background callbacks.
//   unbind()  — detach on ViewModel.onCleared() (screen exit).
// ---------------------------------------------------------------------------
package io.sentient.android.presence

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import io.sentient.android.sdk.VitalsHolder
import io.sentient.mobilesdk.log.createLogger

/** App-scoped presence signal. Holds NO chat/session state — only forwards foreground/background. */
class PresenceCoordinator {
    private val log = createLogger("android", "presence")
    private var onForeground: (() -> Unit)? = null
    private var onBackground: (() -> Unit)? = null
    private var started = false

    fun bind(onForeground: () -> Unit, onBackground: () -> Unit) {
        this.onForeground = onForeground
        this.onBackground = onBackground
    }

    fun unbind() {
        onForeground = null
        onBackground = null
    }

    fun start() {
        if (started) return
        started = true
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            private var backgrounded = false

            override fun onStart(owner: LifecycleOwner) {
                if (!backgrounded) {
                    log.info("foreground.cold-start-skip") // initial connect is owned by ChatViewModel.init
                    return
                }
                backgrounded = false
                log.info("foreground")
                onForeground?.invoke()
            }

            override fun onStop(owner: LifecycleOwner) {
                backgrounded = true
                log.info("background")
                // App-scoped: flush the vitals ring to disk on every background, even
                // before any chat session is bound. Safe pre-init (facade guards on inited).
                VitalsHolder.onAppBackground()
                onBackground?.invoke()
            }
        })
    }
}
