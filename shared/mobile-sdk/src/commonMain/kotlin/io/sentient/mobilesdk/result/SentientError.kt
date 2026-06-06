package io.sentient.mobilesdk.result

enum class ErrorKind { CONNECTION, AUTH, PROTOCOL, TIMEOUT, CYCLE, OUTBOX, UNKNOWN }

sealed class RetryPolicy {
    data object None : RetryPolicy()
    data object Internal : RetryPolicy()
    data object UserPrompt : RetryPolicy()
}

sealed class SentientError(
    val kind: ErrorKind,
    val recoverable: Boolean,
    val retry: RetryPolicy,
    val userMessage: String,
    val cause: Throwable? = null,
) {
    class Connection(userMessage: String, cause: Throwable? = null) :
        SentientError(ErrorKind.CONNECTION, recoverable = true, retry = RetryPolicy.Internal, userMessage = userMessage, cause = cause)

    class Auth(userMessage: String, terminal: Boolean, cause: Throwable? = null) :
        SentientError(ErrorKind.AUTH, recoverable = !terminal, retry = if (terminal) RetryPolicy.None else RetryPolicy.UserPrompt, userMessage = userMessage, cause = cause)

    class Protocol(userMessage: String, cause: Throwable? = null) :
        SentientError(ErrorKind.PROTOCOL, recoverable = true, retry = RetryPolicy.Internal, userMessage = userMessage, cause = cause)

    class Timeout(userMessage: String, cause: Throwable? = null) :
        SentientError(ErrorKind.TIMEOUT, recoverable = true, retry = RetryPolicy.UserPrompt, userMessage = userMessage, cause = cause)

    class Cycle(userMessage: String, cause: Throwable? = null) :
        SentientError(ErrorKind.CYCLE, recoverable = true, retry = RetryPolicy.UserPrompt, userMessage = userMessage, cause = cause)

    class Outbox(userMessage: String, cause: Throwable? = null) :
        SentientError(ErrorKind.OUTBOX, recoverable = true, retry = RetryPolicy.UserPrompt, userMessage = userMessage, cause = cause)

    class Unknown(userMessage: String, cause: Throwable? = null) :
        SentientError(ErrorKind.UNKNOWN, recoverable = false, retry = RetryPolicy.None, userMessage = userMessage, cause = cause)
}
