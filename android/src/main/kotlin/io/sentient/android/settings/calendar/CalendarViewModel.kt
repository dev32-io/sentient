package io.sentient.android.settings.calendar

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.calendar.CreateCalendarUseCase
import io.sentient.mobiledata.usecase.calendar.DeleteCalendarUseCase
import io.sentient.mobiledata.usecase.calendar.ListCalendarUseCase
import io.sentient.mobiledata.usecase.calendar.UpdateCalendarUseCase
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.CalendarTime
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.Visibility
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.UUID

/** Calendar screen state. All operation results are folded here, at the UI boundary. */
data class CalendarUiState(
    val events: List<CalendarEvent> = emptyList(),
    val loading: Boolean = true,
    val error: String? = null,
    val saving: Boolean = false,
    val operationError: String? = null,
)

private val EDITOR_DATE_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
private val DISPLAY_DATE_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

class CalendarViewModel(
    private val listCalendar: ListCalendarUseCase,
    private val createCalendar: CreateCalendarUseCase,
    private val updateCalendar: UpdateCalendarUseCase,
    private val deleteCalendar: DeleteCalendarUseCase,
) : ViewModel() {
    private val _ui = MutableStateFlow(CalendarUiState())
    val ui: StateFlow<CalendarUiState> = _ui.asStateFlow()

    init { refresh() }

    fun refresh() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, error = null) }
            val today = LocalDate.now()
            val end = today.plusYears(1)
            val zone = ZoneId.systemDefault()
            val result = listCalendar.listBoth(
                timedFrom = CalendarTime.Timed(today.atStartOfDay(zone).toInstant().toString(), zone.id),
                timedTo = CalendarTime.Timed(end.plusDays(1).atStartOfDay(zone).toInstant().toString(), zone.id),
                allDayFrom = CalendarTime.AllDay(today.toString()),
                allDayTo = CalendarTime.AllDay(end.toString()),
            )
            _ui.update { it.foldList(result) }
        }
    }

    fun create(title: String, date: String) {
        if (title.isBlank() || date.isBlank() || _ui.value.saving) return
        mutate { createCalendar.create(newEvent(title.trim(), date.trim())) }
    }

    fun update(event: CalendarEvent, title: String, date: String) {
        if (title.isBlank() || date.isBlank() || _ui.value.saving) return
        mutate {
            val start = event.start.updatedFromEditor(date.trim())
            updateCalendar.update(
                event.mutationId,
                event.copy(title = title.trim(), start = start),
            )
        }
    }

    fun delete(event: CalendarEvent) {
        if (_ui.value.saving) return
        mutate { deleteCalendar.delete(event.mutationId) }
    }

    private fun mutate(operation: suspend () -> SentientResult<Any>) {
        viewModelScope.launch {
            _ui.update { it.copy(saving = true, operationError = null) }
            when (val result = operation()) {
                is SentientResult.Success -> { _ui.update { it.copy(saving = false) }; refresh() }
                is SentientResult.Failure -> _ui.update {
                    it.copy(saving = false, operationError = result.error.userMessage)
                }
                is SentientResult.Loading -> Unit
            }
        }
    }

    private fun newEvent(title: String, date: String) = CalendarEvent(
        id = UUID.randomUUID().toString(), scope = CalendarScope.HOUSEHOLD, title = title,
        start = CalendarTime.AllDay(date), visibility = Visibility.EVERYONE,
        importance = Importance.NORMAL, createdAt = "", updatedAt = "",
        occurrenceId = null, baseEventId = null,
    )
}

internal fun CalendarUiState.foldList(result: SentientResult<CalendarEventPage>): CalendarUiState = when (result) {
    is SentientResult.Loading -> copy(loading = true)
    is SentientResult.Success -> copy(loading = false, events = result.data.events, error = null)
    is SentientResult.Failure -> copy(loading = false, error = result.error.userMessage)
}

/** Stable row identity; occurrence rows must not collide with their base event. */
internal val CalendarEvent.rowId: String get() = occurrenceId ?: id

/**
 * The resource id used by the legacy platform mutation adapter.
 *
 * V2 occurrence rows already carry the recurring event id in [eventId]. When a
 * compatibility caller still supplies [baseEventId], prefer it only for an
 * occurrence row; [occurrenceId] and [originalStart] remain on the copied
 * payload as independent occurrence metadata.
 */
@Suppress("DEPRECATION")
internal val CalendarEvent.mutationId: String
    get() = if (occurrenceId != null) baseEventId ?: persistedId else persistedId

/** Formats a start in the device timezone, never by printing the UTC wire instant. */
internal fun formatCalendarStart(start: CalendarTime, zone: ZoneId = ZoneId.systemDefault()): String = when (start) {
    is CalendarTime.AllDay -> start.date
    is CalendarTime.Timed -> runCatching {
        parseInstant(start.instant).atZone(zone).format(DISPLAY_DATE_TIME)
    }.getOrDefault("Invalid date")
}

/** Text used by the editable start field; timed values are converted to device time. */
internal fun calendarEditorStart(start: CalendarTime, zone: ZoneId = ZoneId.systemDefault()): String = when (start) {
    is CalendarTime.AllDay -> start.date
    is CalendarTime.Timed -> runCatching {
        parseInstant(start.instant).atZone(zone).format(EDITOR_DATE_TIME)
    }.getOrDefault("")
}

private fun CalendarTime.updatedFromEditor(value: String, zone: ZoneId = ZoneId.systemDefault()): CalendarTime = when (this) {
    is CalendarTime.AllDay -> CalendarTime.AllDay(value)
    is CalendarTime.Timed -> {
        val originalInstant = instant
        val updatedInstant = runCatching {
            val local = when {
                value.length == 10 -> LocalDate.parse(value).atTime(parseInstant(originalInstant).atZone(zone).toLocalTime())
                else -> LocalDateTime.parse(value, EDITOR_DATE_TIME)
            }
            local.atZone(zone).toInstant().toString()
        }.getOrNull() ?: originalInstant
        CalendarTime.Timed(updatedInstant, timeZoneId)
    }
}

private fun parseInstant(value: String): Instant = try {
    Instant.parse(value)
} catch (_: DateTimeParseException) {
    OffsetDateTime.parse(value).toInstant()
}
