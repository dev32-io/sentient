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
import java.time.LocalDate
import java.util.UUID

/** Calendar screen state. All operation results are folded here, at the UI boundary. */
data class CalendarUiState(
    val events: List<CalendarEvent> = emptyList(),
    val loading: Boolean = true,
    val error: String? = null,
    val saving: Boolean = false,
    val operationError: String? = null,
)

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
            val result = listCalendar.list(
                CalendarTime.AllDay(today.toString()),
                CalendarTime.AllDay(today.plusYears(1).toString()),
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
            updateCalendar.update(event.id, event.copy(title = title.trim(), start = CalendarTime.AllDay(date.trim())))
        }
    }

    fun delete(event: CalendarEvent) {
        if (_ui.value.saving) return
        mutate { deleteCalendar.delete(event.id) }
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
    )
}

internal fun CalendarUiState.foldList(result: SentientResult<CalendarEventPage>): CalendarUiState = when (result) {
    is SentientResult.Loading -> copy(loading = true)
    is SentientResult.Success -> copy(loading = false, events = result.data.events, error = null)
    is SentientResult.Failure -> copy(loading = false, error = result.error.userMessage)
}
