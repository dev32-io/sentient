package io.sentient.mobiledata.data.calendar

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.calendar.CalendarErrorCode
import io.sentient.mobilesdk.result.SentientError

private const val MSG_CONFLICT = "This calendar event changed. Refresh and try again."
private const val MSG_RECURRENCE_CONFLICT = "This recurring event could not be changed. Refresh and try again."
private const val MSG_FORBIDDEN = "You do not have permission to change this calendar event."
private const val MSG_NOT_FOUND = "Calendar event not found."
private const val MSG_CALENDAR_SERVER = "The calendar rejected the request. Please try again."

/**
 * Maps SDK results at the repository boundary. Server bodies are inspected only
 * for their stable error code; neither the body nor its diagnostic message is
 * retained in the UI-facing error.
 */
internal fun <T : Any> AuthResult<T>.toCalendarEnvelope(): SentientResult<T> = when (this) {
    is AuthResult.Success -> SentientResult.Success(value)
    is AuthResult.Failure -> SentientResult.Failure(error.toCalendarSentientError())
}

private fun AuthError.toCalendarSentientError(): SentientError = when (this) {
    AuthError.InvalidCredentials -> SentientError.Auth(
        userMessage = "Your session expired. Please sign in again.",
        terminal = true,
    )
    is AuthError.Network -> SentientError.Connection(
        userMessage = "Network unavailable. Check your connection and try again.",
    )
    is AuthError.Unknown -> SentientError.Unknown(
        userMessage = "Something went wrong. Please try again.",
    )
    is AuthError.Server -> if (status == 401) {
        // CalendarHttpClient's shared HTTP mapper represents 401 as Server;
        // recognize the status here without retaining or surfacing its body.
        SentientError.Auth(
            userMessage = "Your session expired. Please sign in again.",
            terminal = true,
        )
    } else when (calendarErrorCode(body)) {
        CalendarErrorCode.CONFLICT -> SentientError.Protocol(MSG_CONFLICT)
        CalendarErrorCode.RECURRENCE_CONFLICT -> SentientError.Protocol(MSG_RECURRENCE_CONFLICT)
        CalendarErrorCode.FORBIDDEN -> SentientError.Protocol(MSG_FORBIDDEN)
        CalendarErrorCode.NOT_FOUND,
        CalendarErrorCode.OCCURRENCE_NOT_FOUND,
        -> SentientError.Protocol(MSG_NOT_FOUND)
        else -> SentientError.Protocol(MSG_CALENDAR_SERVER)
    }
}

/** The wire error body is never returned; this only recognizes stable code tokens. */
private fun calendarErrorCode(body: String): CalendarErrorCode? {
    val compact = body.filterNot(Char::isWhitespace)
    return when {
        compact.contains("\"code\":\"recurrence_conflict\"") -> CalendarErrorCode.RECURRENCE_CONFLICT
        compact.contains("\"code\":\"conflict\"") -> CalendarErrorCode.CONFLICT
        compact.contains("\"code\":\"forbidden\"") -> CalendarErrorCode.FORBIDDEN
        compact.contains("\"code\":\"occurrence_not_found\"") -> CalendarErrorCode.OCCURRENCE_NOT_FOUND
        compact.contains("\"code\":\"not_found\"") -> CalendarErrorCode.NOT_FOUND
        else -> null
    }
}
