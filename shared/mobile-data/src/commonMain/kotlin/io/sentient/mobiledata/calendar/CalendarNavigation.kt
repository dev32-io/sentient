package io.sentient.mobiledata.calendar

/** Intents accepted by the shared calendar state machine. */
sealed interface CalendarNavigationAction {
    data object Today : CalendarNavigationAction
    data object Previous : CalendarNavigationAction
    data object Next : CalendarNavigationAction
    data class SelectDate(val date: String) : CalendarNavigationAction
    data class SelectMonth(val year: Int, val month: Int) : CalendarNavigationAction
    data class SelectView(val view: CalendarView) : CalendarNavigationAction
    data class SetFilters(val filters: CalendarFilters) : CalendarNavigationAction
    data class SetLocale(val locale: CalendarLocale) : CalendarNavigationAction
}

typealias CalendarIntent = CalendarNavigationAction

/** Explicit target information lets native navigation observe Year → Month. */
sealed interface CalendarNavigationTarget {
    data class Day(val date: String) : CalendarNavigationTarget
    data class Week(val anchorDate: String, val selectedDate: String) : CalendarNavigationTarget
    data class Month(val year: Int, val month: Int, val anchorDate: String, val selectedDate: String) : CalendarNavigationTarget
    data class Year(val year: Int) : CalendarNavigationTarget
}

data class CalendarNavigationResult(
    val state: CalendarExperienceState,
    val target: CalendarNavigationTarget,
)

/**
 * Pure interaction transitions for the four-view hierarchy.
 *
 * Month date selection enters Day. Week selection changes selectedDate while
 * retaining the current week anchor. Year month selection always returns an
 * intentional Month target rather than an incomplete day-dot interaction.
 */
object CalendarNavigation {
    fun reduce(
        state: CalendarExperienceState,
        action: CalendarNavigationAction,
    ): CalendarNavigationResult {
        require(isCalendarDate(state.anchorDate)) { "Invalid state anchor date: ${state.anchorDate}" }
        require(isCalendarDate(state.selectedDate)) { "Invalid state selected date: ${state.selectedDate}" }
        require(isCalendarDate(state.todayDate)) { "Invalid state today date: ${state.todayDate}" }

        return when (action) {
            CalendarNavigationAction.Today -> {
                val next = state.copy(anchorDate = state.todayDate, selectedDate = state.todayDate)
                next.withTarget()
            }
            CalendarNavigationAction.Previous -> step(state, direction = -1)
            CalendarNavigationAction.Next -> step(state, direction = 1)
            is CalendarNavigationAction.SelectView -> {
                val next = state.copy(view = action.view)
                next.withTarget()
            }
            is CalendarNavigationAction.SetFilters -> {
                val next = state.copy(filters = action.filters)
                next.withTarget()
            }
            is CalendarNavigationAction.SetLocale -> {
                val next = state.copy(locale = action.locale)
                next.withTarget()
            }
            is CalendarNavigationAction.SelectDate -> selectDate(state, action.date)
            is CalendarNavigationAction.SelectMonth -> selectMonth(state, action.year, action.month)
        }
    }

    /** State-only convenience for coordinators that do not need target metadata. */
    fun transition(
        state: CalendarExperienceState,
        action: CalendarNavigationAction,
    ): CalendarExperienceState = reduce(state, action).state

    fun today(state: CalendarExperienceState): CalendarExperienceState = transition(state, CalendarNavigationAction.Today)
    fun previous(state: CalendarExperienceState): CalendarExperienceState = transition(state, CalendarNavigationAction.Previous)
    fun next(state: CalendarExperienceState): CalendarExperienceState = transition(state, CalendarNavigationAction.Next)

    private fun selectDate(state: CalendarExperienceState, date: String): CalendarNavigationResult {
        require(isCalendarDate(date)) { "Invalid selected date: $date" }
        val next = when (state.view) {
            CalendarView.MONTH -> state.copy(view = CalendarView.DAY, anchorDate = date, selectedDate = date)
            CalendarView.WEEK -> state.copy(selectedDate = date) // retain the week anchor
            CalendarView.DAY -> state.copy(anchorDate = date, selectedDate = date)
            CalendarView.YEAR -> state.copy(view = CalendarView.DAY, anchorDate = date, selectedDate = date)
        }
        return next.withTarget()
    }

    private fun selectMonth(state: CalendarExperienceState, year: Int, month: Int): CalendarNavigationResult {
        require(month in 1..12) { "Invalid selected month: $month" }
        val anchor = year.toString().padStart(4, '0') + "-" + month.toString().padStart(2, '0') + "-01"
        val next = state.copy(view = CalendarView.MONTH, anchorDate = anchor, selectedDate = anchor)
        return CalendarNavigationResult(
            state = next,
            target = CalendarNavigationTarget.Month(year, month, anchor, anchor),
        )
    }

    private fun step(state: CalendarExperienceState, direction: Int): CalendarNavigationResult {
        val next = when (state.view) {
            CalendarView.DAY -> state.copy(
                anchorDate = CalendarDates.addDays(state.anchorDate, direction),
                selectedDate = CalendarDates.addDays(state.selectedDate, direction),
            )
            CalendarView.WEEK -> state.copy(
                anchorDate = CalendarDates.addDays(state.anchorDate, direction * 7),
                selectedDate = CalendarDates.addDays(state.selectedDate, direction * 7),
            )
            CalendarView.MONTH -> state.copy(
                anchorDate = CalendarDates.addMonthsClamped(state.anchorDate, direction),
                selectedDate = CalendarDates.addMonthsClamped(state.selectedDate, direction),
            )
            CalendarView.YEAR -> state.copy(
                anchorDate = CalendarDates.addYearsClamped(state.anchorDate, direction),
                selectedDate = CalendarDates.addYearsClamped(state.selectedDate, direction),
            )
        }
        return next.withTarget()
    }

    private fun CalendarExperienceState.withTarget(): CalendarNavigationResult =
        CalendarNavigationResult(
            state = this,
            target = when (view) {
                CalendarView.DAY -> CalendarNavigationTarget.Day(anchorDate)
                CalendarView.WEEK -> CalendarNavigationTarget.Week(anchorDate, selectedDate)
                CalendarView.MONTH -> {
                    val date = parseCalendarDate(anchorDate)
                    CalendarNavigationTarget.Month(date.year, date.month, anchorDate, selectedDate)
                }
                CalendarView.YEAR -> CalendarNavigationTarget.Year(parseCalendarDate(anchorDate).year)
            },
        )
}
