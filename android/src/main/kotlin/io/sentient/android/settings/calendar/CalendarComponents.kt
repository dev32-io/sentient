package io.sentient.android.settings.calendar

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.sentient.android.theme.Fraunces
import io.sentient.android.theme.JetBrainsMono
import io.sentient.android.theme.LocalTokens
import io.sentient.mobiledata.calendar.CalendarAgendaSection
import io.sentient.mobiledata.calendar.CalendarDateCell
import io.sentient.mobiledata.calendar.CalendarFacetOptions
import io.sentient.mobiledata.calendar.CalendarFilters
import io.sentient.mobiledata.calendar.CalendarFreshness
import io.sentient.mobiledata.calendar.CalendarMonthProjection
import io.sentient.mobiledata.calendar.CalendarOfflineState
import io.sentient.mobiledata.calendar.CalendarProjectedEvent
import io.sentient.mobiledata.calendar.CalendarProjectedTime
import io.sentient.mobiledata.calendar.CalendarView
import io.sentient.mobiledata.calendar.CalendarWeekProjection
import io.sentient.mobiledata.calendar.CalendarYearProjection
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.Importance

/** Tests/previews and the host may force reduced motion; inspection mode is always motionless. */
val LocalCalendarReducedMotion = staticCompositionLocalOf { false }

@Immutable
data class CalendarSurfaceCallbacks(
    val onBack: () -> Unit,
    val onAdd: () -> Unit,
    val onToday: () -> Unit,
    val onPrevious: () -> Unit,
    val onNext: () -> Unit,
    val onDateSelected: (String) -> Unit,
    val onMonthSelected: (Int, Int) -> Unit,
    val onViewSelected: (CalendarView) -> Unit,
    val onScopeSelected: (CalendarScope) -> Unit,
    val onGroupToggled: (String) -> Unit,
    val onTagToggled: (String) -> Unit,
    val onImportanceSelected: (Importance?) -> Unit,
    val onSearchChanged: (String) -> Unit,
    val onEventSelected: (CalendarProjectedEvent, FocusRequester) -> Unit,
    val onRetry: () -> Unit,
)

/**
 * Controlled calendar shell. The top bar and floating selector are fixed; every heading,
 * filter, compact view and agenda row participates in the one lazy scroll region beneath it.
 */
@Composable
fun CalendarScaffold(
    state: CalendarUiState,
    title: String,
    subtitle: String,
    callbacks: CalendarSurfaceCallbacks,
    modifier: Modifier = Modifier,
    agendaSections: List<CalendarAgendaSection> = state.agendaRows,
    addFocusRequester: FocusRequester? = null,
) {
    val reduceMotion = LocalInspectionMode.current || LocalCalendarReducedMotion.current
    CompositionLocalProvider(LocalCalendarReducedMotion provides reduceMotion) {
        Box(
            modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background)
                .statusBarsPadding(),
        ) {
            Column(Modifier.fillMaxSize()) {
                CalendarTopBar(
                    canAdd = state.mutationAvailability.canCreate && !state.isSubmitting,
                    onBack = callbacks.onBack,
                    onAdd = callbacks.onAdd,
                    addFocusRequester = addFocusRequester,
                )
                LazyColumn(
                    modifier = Modifier.fillMaxSize()
                        .testTag(calendarFreshnessTag(state))
                        .semantics {
                            liveRegion = LiveRegionMode.Polite
                            stateDescription = calendarFreshnessDescription(state)
                        },
                    contentPadding = PaddingValues(
                        bottom = CalendarSurfaceLayout.SCROLL_BOTTOM_CLEARANCE_DP.dp,
                    ),
                ) {
                    item {
                        CalendarHeading(
                            title = title,
                            subtitle = subtitle,
                            onToday = callbacks.onToday,
                            onPrevious = callbacks.onPrevious,
                            onNext = callbacks.onNext,
                        )
                    }
                    item {
                        CalendarFilterRails(
                            filters = state.filters,
                            facets = state.facets,
                            onScopeSelected = callbacks.onScopeSelected,
                            onGroupToggled = callbacks.onGroupToggled,
                            onTagToggled = callbacks.onTagToggled,
                            onImportanceSelected = callbacks.onImportanceSelected,
                            onSearchChanged = callbacks.onSearchChanged,
                        )
                    }
                    if (calendarShowsCompactCanvas(state.view)) {
                        item {
                            CalendarCompactCanvas(
                                view = state.view,
                                week = state.week,
                                month = state.month,
                                year = state.year,
                                languageTag = state.locale.languageTag,
                                onDateSelected = callbacks.onDateSelected,
                                onMonthSelected = callbacks.onMonthSelected,
                            )
                        }
                    }
                    item {
                        CalendarStateNotice(state = state, onRetry = callbacks.onRetry)
                    }
                    if (state.contentState == CalendarContentState.CONTENT || agendaSections.isNotEmpty()) {
                        items(agendaSections, key = { it.date }) { section ->
                            CalendarAgendaSection(section, callbacks.onEventSelected)
                        }
                    }
                    item { Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars)) }
                }
            }
            FloatingViewBar(
                selected = state.view,
                onViewSelected = callbacks.onViewSelected,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .padding(
                        start = CalendarSurfaceLayout.FLOATING_BAR_SIDE_INSET_DP.dp,
                        end = CalendarSurfaceLayout.FLOATING_BAR_SIDE_INSET_DP.dp,
                        bottom = CalendarSurfaceLayout.FLOATING_BAR_BOTTOM_GAP_DP.dp,
                    ),
            )
        }
    }
}

@Composable
fun CalendarTopBar(
    canAdd: Boolean,
    onBack: () -> Unit,
    onAdd: () -> Unit,
    modifier: Modifier = Modifier,
    addFocusRequester: FocusRequester? = null,
) {
    Row(
        modifier
            .fillMaxWidth()
            .testTag(CalendarTestTags.TOP_BAR)
            .height(CalendarSurfaceLayout.TOP_BAR_DP.dp)
            .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CalendarTextButton("‹", "Back", onBack, Modifier.testTag(CalendarTestTags.BACK))
        Text(
            "Calendar",
            modifier = Modifier.padding(start = 5.dp).weight(1f),
            fontFamily = Fraunces,
            fontWeight = FontWeight.Medium,
            fontSize = 20.sp,
        )
        CalendarActionButton(
            "Add", "Add event", canAdd, onAdd,
            Modifier.testTag(CalendarTestTags.ADD).then(
                if (addFocusRequester != null) Modifier.focusRequester(addFocusRequester) else Modifier,
            ),
        )
    }
}

@Composable
fun CalendarHeading(
    title: String,
    subtitle: String,
    onToday: () -> Unit,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .fillMaxWidth()
            .testTag(CalendarTestTags.HEADING)
            .padding(start = 16.dp, end = 16.dp, top = 18.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontFamily = Fraunces, fontSize = 34.sp, lineHeight = 36.sp, maxLines = 2)
            Text(
                subtitle.uppercase(),
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .72f),
                fontFamily = JetBrainsMono,
                fontSize = 10.sp,
                modifier = Modifier.padding(top = 5.dp),
            )
        }
        CalendarTextButton("Today", "Go to today", onToday, Modifier.testTag(CalendarTestTags.TODAY))
        CalendarTextButton("‹", "Previous period", onPrevious, Modifier.testTag(CalendarTestTags.PREVIOUS))
        CalendarTextButton("›", "Next period", onNext, Modifier.testTag(CalendarTestTags.NEXT))
    }
}

@Composable
private fun CalendarTextButton(text: String, label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(LocalTokens.current.radii.md)
    Box(
        modifier
            .defaultMinSize(minWidth = 44.dp, minHeight = 44.dp)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .clickable(onClick = onClick, role = Role.Button)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Text(text, fontWeight = FontWeight.Medium, maxLines = 1)
    }
}

@Composable
private fun CalendarActionButton(text: String, label: String, enabled: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(LocalTokens.current.radii.md)
    Box(
        modifier
            .defaultMinSize(minWidth = 44.dp, minHeight = 44.dp)
            .clip(shape)
            .background(if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainer)
            .clickable(enabled = enabled, onClick = onClick, role = Role.Button)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            color = if (enabled) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface.copy(alpha = .5f),
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 12.dp),
        )
    }
}

@Composable
fun CalendarFilterRails(
    filters: CalendarFilters,
    facets: CalendarFacetOptions,
    onScopeSelected: (CalendarScope) -> Unit,
    onGroupToggled: (String) -> Unit,
    onTagToggled: (String) -> Unit,
    onImportanceSelected: (Importance?) -> Unit,
    onSearchChanged: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val retained = retainedCalendarFacets(filters, facets)
    Column(modifier.fillMaxWidth().testTag(CalendarTestTags.FILTERS).padding(top = 18.dp), verticalArrangement = Arrangement.spacedBy(0.dp)) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf(CalendarScope.ALL, CalendarScope.PRIVATE, CalendarScope.HOUSEHOLD).forEach { scope ->
                CalendarFilterChip(
                    label = when (scope) {
                        CalendarScope.ALL -> "All"
                        CalendarScope.PRIVATE -> "Private"
                        CalendarScope.HOUSEHOLD -> "Household"
                    },
                    selected = filters.scope == scope,
                    onClick = { onScopeSelected(scope) },
                )
            }
            retained.groups.forEach { group ->
                CalendarFilterChip("Group: $group", group in filters.groups, { onGroupToggled(group) })
            }
        }
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            retained.tags.forEach { tag ->
                CalendarFilterChip("#$tag", tag in filters.tags, { onTagToggled(tag) }, compact = true)
            }
            facets.importances.distinct().forEach { importance ->
                CalendarFilterChip(
                    importance.name.lowercase().replaceFirstChar { it.titlecase() },
                    filters.importance == importance,
                    { onImportanceSelected(if (filters.importance == importance) null else importance) },
                    compact = true,
                )
            }
            CalendarSearchField(filters.text, onSearchChanged)
        }
    }
}

@Composable
private fun CalendarFilterChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    compact: Boolean = false,
) {
    val interaction = androidx.compose.runtime.remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val shape = RoundedCornerShape(999.dp)
    val selectedColor = if (selected) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent
    val duration = if (LocalCalendarReducedMotion.current) 0 else LocalTokens.current.motion.fastMs
    val color by animateColorAsState(selectedColor, tween(duration), label = "calendarChip")
    Box(
        Modifier
            .defaultMinSize(minWidth = 44.dp, minHeight = 44.dp)
            .testTag(calendarFilterTag("option", label))
            .semantics {
                this.selected = selected
                stateDescription = if (selected) "Selected" else "Not selected"
                role = Role.Button
            }
            .clip(shape)
            .background(color)
            .border(1.dp, if (focused) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, shape)
            .clickable(interactionSource = interaction, indication = LocalIndication.current, onClick = onClick)
            .focusable(interactionSource = interaction),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .height(if (compact) CalendarSurfaceLayout.TAG_VISUAL_DP.dp else CalendarSurfaceLayout.MIN_TARGET_DP.dp)
                .padding(horizontal = if (compact) 10.dp else 13.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                label,
                color = if (selected) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .72f),
                fontFamily = JetBrainsMono,
                fontSize = 10.sp,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun CalendarSearchField(value: String, onValueChange: (String) -> Unit) {
    val shape = RoundedCornerShape(999.dp)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodySmall.copy(color = MaterialTheme.colorScheme.onSurface, fontFamily = JetBrainsMono),
        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
        modifier = Modifier
            .width(132.dp)
            .height(44.dp)
            .testTag(CalendarTestTags.SEARCH)
            .clip(shape)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .semantics { contentDescription = "Search calendar events" }
            .padding(horizontal = 12.dp),
        decorationBox = { inner ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("⌕", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(6.dp))
                Box {
                    if (value.isEmpty()) Text("Search", color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .72f), fontSize = 11.sp)
                    inner()
                }
            }
        },
    )
}

@Composable
fun CalendarCompactCanvas(
    view: CalendarView,
    week: CalendarWeekProjection?,
    month: CalendarMonthProjection?,
    year: CalendarYearProjection?,
    languageTag: String,
    onDateSelected: (String) -> Unit,
    onMonthSelected: (Int, Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (!calendarShowsCompactCanvas(view)) return
    val shape = RoundedCornerShape(LocalTokens.current.radii.lg)
    Surface(
        modifier = modifier.padding(horizontal = 16.dp, vertical = 18.dp).fillMaxWidth()
            .testTag(CalendarTestTags.CANVAS),
        shape = shape,
        color = MaterialTheme.colorScheme.surfaceContainer,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        when (view) {
            CalendarView.DAY -> Unit
            CalendarView.WEEK -> WeekCalendarView(week, onDateSelected)
            CalendarView.MONTH -> MonthCalendarView(month, onDateSelected)
            CalendarView.YEAR -> YearCalendarView(year, languageTag, onMonthSelected)
        }
    }
}

@Composable
fun WeekCalendarView(week: CalendarWeekProjection?, onDateSelected: (String) -> Unit, modifier: Modifier = Modifier) {
    if (week == null) {
        CalendarCanvasUnavailable(modifier)
        return
    }
    Row(modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        week.days.forEachIndexed { index, day ->
            CalendarWeekDay(day, week.weekdayLabels[index].shortLabel, onDateSelected, Modifier.weight(1f))
        }
    }
}

@Composable
private fun CalendarWeekDay(day: CalendarDateCell, weekday: String, onDateSelected: (String) -> Unit, modifier: Modifier) {
    val shape = RoundedCornerShape(LocalTokens.current.radii.md)
    Column(
        modifier
            .defaultMinSize(minHeight = 62.dp)
            .clip(shape)
            .background(if (day.isSelected) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
            .clickable(role = Role.Button) { onDateSelected(day.date) }
            .testTag(calendarDateTag(day.date))
            .semantics {
                contentDescription = day.accessibilityLabel
                selected = day.isSelected
                stateDescription = buildString {
                    if (day.isToday) append("Today")
                    if (day.isSelected) append(if (isEmpty()) "Selected" else ", selected")
                }
            }
            .padding(vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(weekday, fontFamily = JetBrainsMono, fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(day.dayOfMonth.toString(), fontFamily = Fraunces, fontWeight = FontWeight.Medium, fontSize = 20.sp)
    }
}

@Composable
fun MonthCalendarView(month: CalendarMonthProjection?, onDateSelected: (String) -> Unit, modifier: Modifier = Modifier) {
    if (month == null) {
        CalendarCanvasUnavailable(modifier)
        return
    }
    Column(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().height(34.dp)) {
            month.weekdayLabels.forEach { label ->
                Box(Modifier.weight(1f).fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(label.shortLabel, fontFamily = JetBrainsMono, fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        month.cells.chunked(7).forEach { week ->
            Row(Modifier.fillMaxWidth()) {
                week.forEach { day -> MonthCalendarDay(day, onDateSelected, Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun MonthCalendarDay(day: CalendarDateCell, onDateSelected: (String) -> Unit, modifier: Modifier) {
    Column(
        modifier
            .height(53.dp)
            .border(.5.dp, MaterialTheme.colorScheme.outlineVariant)
            .background(if (day.isOutsideMonth) MaterialTheme.colorScheme.background.copy(alpha = .34f) else Color.Transparent)
            .clickable(role = Role.Button) { onDateSelected(day.date) }
            .testTag(calendarDateTag(day.date))
            .semantics {
                contentDescription = day.accessibilityLabel
                selected = day.isSelected
                stateDescription = listOfNotNull(
                    "Selected".takeIf { day.isSelected },
                    "Today".takeIf { day.isToday },
                    "Outside month".takeIf { day.isOutsideMonth },
                ).joinToString()
            },
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.padding(top = 4.dp).size(25.dp).then(
                if (day.isToday) Modifier.border(1.dp, MaterialTheme.colorScheme.onSurface, CircleShape) else Modifier,
            ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                day.dayOfMonth.toString(),
                fontFamily = JetBrainsMono,
                fontSize = 10.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (day.isOutsideMonth) .42f else .72f),
            )
        }
        Row(Modifier.height(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            day.indicators.take(3).forEachIndexed { index, _ ->
                Box(Modifier.size(5.dp).clip(CircleShape).background(calendarIndicatorColor(day, index)))
            }
            day.overflow?.let { overflow ->
                Text(
                    "+${overflow.count}",
                    fontFamily = JetBrainsMono,
                    fontSize = 8.sp,
                    modifier = Modifier.semantics {
                        contentDescription = calendarOverflowAccessibilityLabel(day.accessibilityLabel, overflow.count)
                    },
                )
            }
        }
    }
}

@Composable
private fun calendarIndicatorColor(day: CalendarDateCell, index: Int): Color =
    when (day.events.getOrNull(index)?.scope) {
        CalendarScope.PRIVATE -> MaterialTheme.colorScheme.primary
        CalendarScope.HOUSEHOLD -> MaterialTheme.colorScheme.secondary
        CalendarScope.ALL, null -> MaterialTheme.colorScheme.tertiary
    }

@Composable
fun YearCalendarView(
    year: CalendarYearProjection?,
    languageTag: String,
    onMonthSelected: (Int, Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (year == null) {
        CalendarCanvasUnavailable(modifier)
        return
    }
    Column(modifier.fillMaxWidth()) {
        year.months.chunked(3).forEach { row ->
            Row(Modifier.fillMaxWidth()) {
                row.forEach { month ->
                    Column(
                        Modifier
                            .weight(1f)
                            .defaultMinSize(minHeight = 110.dp)
                            .border(.5.dp, MaterialTheme.colorScheme.outlineVariant)
                            .clickable(role = Role.Button) { onMonthSelected(month.year, month.month) }
                            .testTag("calendar-month-${month.year}-${month.month.toString().padStart(2, '0')}")
                            .semantics { contentDescription = month.accessibilityLabel }
                            .padding(8.dp),
                    ) {
                        Text(calendarMonthShortName(month.year, month.month, languageTag), fontFamily = Fraunces, fontSize = 13.sp)
                        Column(Modifier.padding(top = 6.dp)) {
                            val leadingDays = java.time.LocalDate.of(month.year, month.month, 1).dayOfWeek.value % 7
                            val alignedDays: List<CalendarDateCell?> = List(leadingDays) { null } + month.days
                            alignedDays.chunked(7).forEach { week ->
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                                    week.forEach { day ->
                                        if (day == null) {
                                            Spacer(Modifier.weight(1f).height(8.dp))
                                        } else {
                                            Box(
                                                Modifier
                                                    .weight(1f)
                                                    .height(8.dp)
                                                    .clip(CircleShape)
                                                    .background(if (day.hasEvents) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.onSurface.copy(alpha = .08f))
                                                    .testTag(calendarDateTag(day.date))
                                                    .semantics { contentDescription = day.accessibilityLabel },
                                            )
                                        }
                                    }
                                    repeat(7 - week.size) { Spacer(Modifier.weight(1f).height(8.dp)) }
                                }
                                Spacer(Modifier.height(2.dp))
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CalendarCanvasUnavailable(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(64.dp), contentAlignment = Alignment.Center) {
        Text("Calendar view unavailable", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun CalendarAgendaSection(
    section: CalendarAgendaSection,
    onEventSelected: (CalendarProjectedEvent, FocusRequester) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth().testTag(CalendarTestTags.AGENDA).padding(horizontal = 16.dp)) {
        val parsed = java.time.LocalDate.parse(section.date)
        Row(
            Modifier.padding(start = 2.dp, top = 12.dp, bottom = 8.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                parsed.format(java.time.format.DateTimeFormatter.ofPattern("MMM d")),
                fontFamily = Fraunces,
                fontWeight = FontWeight.Medium,
                fontSize = 22.sp,
            )
            Text(
                parsed.dayOfWeek.name.lowercase().replaceFirstChar { it.titlecase() },
                fontFamily = JetBrainsMono,
                fontSize = 10.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (section.events.isEmpty()) {
            Text(
                "No events planned.",
                Modifier.fillMaxWidth().padding(20.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            section.events.forEach { event ->
                val focusRequester = androidx.compose.runtime.remember(event.actionIdentity.stableKey) { FocusRequester() }
                CalendarAgendaRow(
                    event,
                    { onEventSelected(event, focusRequester) },
                    Modifier.padding(bottom = 8.dp).focusRequester(focusRequester),
                )
            }
        }
    }
}

@Composable
fun CalendarAgendaRow(event: CalendarProjectedEvent, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val interaction = androidx.compose.runtime.remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val duration = if (LocalCalendarReducedMotion.current) 0 else LocalTokens.current.motion.fastMs
    val scale by animateFloatAsState(if (pressed) .985f else 1f, tween(duration), label = "agendaPress")
    val shape = RoundedCornerShape(LocalTokens.current.radii.md)
    Row(
        modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = CalendarSurfaceLayout.AGENDA_ROW_DP.dp)
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
            .testTag(calendarEventTag(event))
            .semantics { contentDescription = event.accessibilityLabel }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            when (val start = event.start) {
                is CalendarProjectedTime.AllDay -> "ALL DAY"
                is CalendarProjectedTime.Timed -> start.displayTime
            },
            Modifier.width(54.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontFamily = JetBrainsMono,
            fontSize = 10.sp,
        )
        Column(Modifier.weight(1f)) {
            Text(event.title, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                listOfNotNull(
                    event.scope.name.lowercase().replaceFirstChar { it.titlecase() },
                    event.group,
                    event.tags.firstOrNull(),
                ).joinToString(" · "),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Box(
            Modifier.size(28.dp).clip(CircleShape).border(1.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(event.scope.name.first().toString(), fontFamily = Fraunces, fontSize = 12.sp)
        }
    }
}

@Composable
fun CalendarStateNotice(state: CalendarUiState, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    val message = when {
        state.contentState == CalendarContentState.LOADING -> "Loading calendar"
        state.contentState == CalendarContentState.EMPTY -> "No events match these filters."
        state.contentState == CalendarContentState.UNAVAILABLE_OFFLINE -> "Calendar unavailable offline."
        state.contentState == CalendarContentState.ERROR -> state.error?.userMessage ?: "Calendar could not be loaded."
        state.offline == CalendarOfflineState.OFFLINE -> "Offline · showing saved calendar"
        state.freshness == CalendarFreshness.STALE -> "Calendar may be out of date"
        state.isRefreshing -> "Refreshing calendar"
        else -> null
    }
    if (message == null) return
    Row(
        modifier
            .fillMaxWidth()
            .testTag(
                when {
                    state.contentState == CalendarContentState.UNAVAILABLE_OFFLINE -> CalendarTestTags.UNAVAILABLE_OFFLINE
                    state.isOffline -> CalendarTestTags.OFFLINE
                    else -> CalendarTestTags.STATUS
                },
            )
            .semantics { liveRegion = LiveRegionMode.Polite }
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (state.contentState == CalendarContentState.LOADING || state.isRefreshing) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        }
        Text(message, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (state.contentState == CalendarContentState.ERROR || state.contentState == CalendarContentState.UNAVAILABLE_OFFLINE) {
            CalendarTextButton("Retry", "Retry loading calendar", onRetry, Modifier.testTag(CalendarTestTags.RETRY))
        }
    }
}

@Composable
fun FloatingViewBar(
    selected: CalendarView,
    onViewSelected: (CalendarView) -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(999.dp)
    Surface(
        modifier = modifier.fillMaxWidth().testTag(CalendarTestTags.VIEW_BAR),
        shape = shape,
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .96f),
        shadowElevation = 16.dp,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(5.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            CalendarView.entries.forEach { view ->
            val active = view == selected
            val duration = if (LocalCalendarReducedMotion.current) 0 else LocalTokens.current.motion.normalMs
            val background by animateColorAsState(
                if (active) MaterialTheme.colorScheme.surfaceContainer else Color.Transparent,
                tween(duration),
                label = "calendarView",
            )
            Box(
                Modifier
                    .weight(1f)
                    .height(CalendarSurfaceLayout.VIEW_CONTROL_DP.dp)
                    .clip(shape)
                    .background(background)
                    .then(if (active) Modifier.border(1.dp, MaterialTheme.colorScheme.outline, shape) else Modifier)
                    .clickable(role = Role.Tab) { onViewSelected(view) }
                    .testTag(calendarViewTag(view))
                    .semantics {
                        this.selected = active
                        stateDescription = if (active) "Selected" else "Not selected"
                        contentDescription = calendarViewAccessibilityLabel(view, active)
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    view.name.lowercase().replaceFirstChar { it.titlecase() },
                    fontFamily = JetBrainsMono,
                    fontSize = 10.sp,
                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (active) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
}
