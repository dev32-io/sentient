package io.sentient.android.settings.calendar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.mobiledata.calendar.CalendarEventKind
import io.sentient.mobiledata.calendar.CalendarMutationDraft
import io.sentient.mobiledata.calendar.CalendarProjectedEvent
import io.sentient.mobiledata.calendar.CalendarProjectedTime

@Composable
fun CalendarScreen(vm: CalendarViewModel, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val state by vm.ui.collectAsStateWithLifecycle()
    Column(modifier.fillMaxSize().testTag("settings-calendar-screen")) {
        SettingsTopBar(title = "Calendar", onBack = onBack, backTestTag = "settings-calendar-back")
        CalendarBody(
            state = state,
            onAdd = { title, date ->
                vm.add(CalendarMutationDraft.create(start = date, title = title))
            },
            onRefresh = vm::refresh,
        )
    }
}

/** Temporary controlled consumer; the full four-view Compose composition is delivered separately. */
@Composable
private fun CalendarBody(
    state: CalendarUiState,
    onAdd: (String, String) -> Unit,
    onRefresh: () -> Unit,
) {
    var title by remember { mutableStateOf("") }
    var date by remember { mutableStateOf("") }
    Column(
        Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(title, { title = it }, Modifier.weight(1f).testTag("settings-calendar-title"), label = { Text("Event") }, singleLine = true)
            OutlinedTextField(date, { date = it }, Modifier.weight(1f).testTag("settings-calendar-date"), label = { Text("Date (YYYY-MM-DD)") }, singleLine = true)
        }
        Button(
            onClick = { onAdd(title, date) },
            enabled = state.mutationAvailability.canCreate && !state.isSubmitting,
            modifier = Modifier.testTag("settings-calendar-add"),
        ) { Text("Add") }
        state.mutationError?.let { Text(it.userMessage, modifier = Modifier.testTag("settings-calendar-operation-error")) }
        when (state.contentState) {
            CalendarContentState.LOADING -> CircularProgressIndicator(modifier = Modifier.testTag("settings-calendar-loading"))
            CalendarContentState.ERROR,
            CalendarContentState.UNAVAILABLE_OFFLINE,
            -> {
                Text(state.error?.userMessage ?: "Calendar unavailable offline", modifier = Modifier.testTag("settings-calendar-error"))
                Button(onClick = onRefresh, modifier = Modifier.testTag("settings-calendar-retry")) { Text("Retry") }
            }
            CalendarContentState.EMPTY -> Text("No calendar events", modifier = Modifier.testTag("settings-calendar-empty"))
            CalendarContentState.CONTENT -> LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.visibleEvents, key = { it.actionIdentity.stableKey }) { event -> CalendarEventRow(event) }
            }
        }
    }
}

@Composable
private fun CalendarEventRow(event: CalendarProjectedEvent) {
    Column(
        Modifier.fillMaxWidth().testTag("settings-calendar-event-${event.actionIdentity.stableKey}"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(event.title)
        Text(
            when (val start = event.start) {
                is CalendarProjectedTime.AllDay -> start.date
                is CalendarProjectedTime.Timed -> start.displayTime
            },
            modifier = Modifier.testTag("settings-calendar-start-${event.actionIdentity.stableKey}"),
        )
        if (event.kind == CalendarEventKind.ALL_DAY) Text("All day")
    }
}
