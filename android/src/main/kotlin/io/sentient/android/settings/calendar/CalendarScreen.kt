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
import androidx.compose.material3.IconButton
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
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarTime

@Composable
fun CalendarScreen(vm: CalendarViewModel, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val state by vm.ui.collectAsStateWithLifecycle()
    Column(modifier.fillMaxSize().testTag("settings-calendar-screen")) {
        SettingsTopBar(title = "Calendar", onBack = onBack, backTestTag = "settings-calendar-back")
        CalendarBody(state, vm::create, vm::update, vm::delete, vm::refresh)
    }
}

@Composable
private fun CalendarBody(
    state: CalendarUiState,
    onCreate: (String, String) -> Unit,
    onUpdate: (CalendarEvent, String, String) -> Unit,
    onDelete: (CalendarEvent) -> Unit,
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
        Button(onClick = { onCreate(title, date) }, enabled = !state.saving, modifier = Modifier.testTag("settings-calendar-add")) { Text("Add") }
        state.operationError?.let { Text(it, modifier = Modifier.testTag("settings-calendar-operation-error")) }
        when {
            state.loading && state.events.isEmpty() -> CircularProgressIndicator(modifier = Modifier.testTag("settings-calendar-loading"))
            state.error != null && state.events.isEmpty() -> {
                Text(state.error, modifier = Modifier.testTag("settings-calendar-error"))
                Button(onClick = onRefresh, modifier = Modifier.testTag("settings-calendar-retry")) { Text("Retry") }
            }
            state.events.isEmpty() -> Text("No calendar events", modifier = Modifier.testTag("settings-calendar-empty"))
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.events, key = { it.id }) { event ->
                    CalendarEventRow(event, state.saving, onUpdate, onDelete)
                }
            }
        }
    }
}

@Composable
private fun CalendarEventRow(
    event: CalendarEvent,
    disabled: Boolean,
    onUpdate: (CalendarEvent, String, String) -> Unit,
    onDelete: (CalendarEvent) -> Unit,
) {
    var title by remember(event.id, event.updatedAt) { mutableStateOf(event.title) }
    val date = (event.start as? CalendarTime.AllDay)?.date ?: ""
    Row(Modifier.fillMaxWidth().testTag("settings-calendar-event-${event.id}"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(title, { title = it }, Modifier.weight(1f), singleLine = true)
        Button(onClick = { onUpdate(event, title, date) }, enabled = !disabled, modifier = Modifier.testTag("settings-calendar-update-${event.id}")) { Text("Save") }
        IconButton(onClick = { onDelete(event) }, enabled = !disabled, modifier = Modifier.testTag("settings-calendar-delete-${event.id}")) { Text("×") }
    }
}
