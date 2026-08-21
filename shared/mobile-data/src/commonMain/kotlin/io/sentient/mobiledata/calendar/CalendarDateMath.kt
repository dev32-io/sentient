package io.sentient.mobiledata.calendar

import io.sentient.mobilesdk.calendar.Weekday

internal data class DateParts(
    val year: Int,
    val month: Int,
    val day: Int,
)

internal fun isCalendarDate(value: String): Boolean {
    if (!DATE_PATTERN.matches(value)) return false
    return runCatching { parseCalendarDate(value) }.isSuccess
}

internal fun parseCalendarDate(value: String): DateParts {
    val match = DATE_PATTERN.matchEntire(value)
        ?: throw IllegalArgumentException("Invalid calendar date: $value")
    val date = DateParts(
        year = match.groupValues[1].toInt(),
        month = match.groupValues[2].toInt(),
        day = match.groupValues[3].toInt(),
    )
    require(date.month in 1..12) { "Invalid calendar month: $value" }
    require(date.day in 1..daysInCalendarMonth(date.year, date.month)) { "Invalid calendar day: $value" }
    return date
}

internal fun formatCalendarDate(date: DateParts): String =
    date.year.toString().padStart(4, '0') + "-" +
        date.month.toString().padStart(2, '0') + "-" +
        date.day.toString().padStart(2, '0')

internal fun compareCalendarDates(left: String, right: String): Int {
    // ISO yyyy-MM-dd strings sort chronologically after validation.
    return left.compareTo(right)
}

internal fun addCalendarDays(value: String, days: Int): String {
    val date = parseCalendarDate(value)
    return formatCalendarDate(civilFromDays(daysFromCivil(date) + days.toLong()))
}

internal fun addCalendarMonthsClamped(value: String, months: Int): String {
    val date = parseCalendarDate(value)
    val monthIndex = date.year.toLong() * 12L + (date.month - 1) + months.toLong()
    val year = floorDiv(monthIndex, 12L).toInt()
    val month = (floorMod(monthIndex, 12L) + 1L).toInt()
    return formatCalendarDate(DateParts(year, month, minOf(date.day, daysInCalendarMonth(year, month))))
}

internal fun addCalendarYearsClamped(value: String, years: Int): String {
    val date = parseCalendarDate(value)
    val year = date.year + years
    return formatCalendarDate(DateParts(year, date.month, minOf(date.day, daysInCalendarMonth(year, date.month))))
}

internal fun daysInCalendarMonth(year: Int, month: Int): Int {
    require(month in 1..12) { "Invalid calendar month: $month" }
    return when (month) {
        2 -> if (isLeapYear(year)) 29 else 28
        4, 6, 9, 11 -> 30
        else -> 31
    }
}

internal fun isLeapYear(year: Int): Boolean = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)

internal fun calendarWeekday(date: String): Weekday = weekdayFromNumber(
    floorMod(daysFromCivil(parseCalendarDate(date)) - daysFromCivil(DateParts(1970, 1, 1)) + 3L, 7L).toInt() + 1,
)

internal fun weekdayNumber(day: Weekday): Int = when (day) {
    Weekday.MONDAY -> 1
    Weekday.TUESDAY -> 2
    Weekday.WEDNESDAY -> 3
    Weekday.THURSDAY -> 4
    Weekday.FRIDAY -> 5
    Weekday.SATURDAY -> 6
    Weekday.SUNDAY -> 7
}

internal fun weekdayFromNumber(value: Int): Weekday = when (value) {
    1 -> Weekday.MONDAY
    2 -> Weekday.TUESDAY
    3 -> Weekday.WEDNESDAY
    4 -> Weekday.THURSDAY
    5 -> Weekday.FRIDAY
    6 -> Weekday.SATURDAY
    7 -> Weekday.SUNDAY
    else -> error("Invalid weekday number: $value")
}

private fun daysFromCivil(date: DateParts): Long {
    var year = date.year.toLong()
    year -= if (date.month <= 2) 1 else 0
    val era = year / 400L
    val yearOfEra = year - era * 400L
    val monthPrime = date.month + if (date.month > 2) -3 else 9
    val dayOfYear = (153L * monthPrime + 2L) / 5L + date.day - 1L
    val dayOfEra = yearOfEra * 365L + yearOfEra / 4L - yearOfEra / 100L + dayOfYear
    // Keep the Hinnant value relative to 1970-01-01; the inverse below uses
    // the matching +719468 offset. Relative values also make weekday math
    // straightforward and avoid relying on platform date APIs.
    return era * 146097L + dayOfEra - 719468L
}

/** Inverse of [daysFromCivil], using the proleptic Gregorian calendar. */
private fun civilFromDays(value: Long): DateParts {
    var z = value + 719468L
    val era = if (z >= 0) z / 146097L else (z - 146096L) / 146097L
    val dayOfEra = z - era * 146097L
    val yearOfEra = (dayOfEra - dayOfEra / 1460L + dayOfEra / 36524L - dayOfEra / 146096L) / 365L
    var year = yearOfEra + era * 400L
    val dayOfYear = dayOfEra - (365L * yearOfEra + yearOfEra / 4L - yearOfEra / 100L)
    val monthPrime = (5L * dayOfYear + 2L) / 153L
    val day = dayOfYear - (153L * monthPrime + 2L) / 5L + 1L
    val month = monthPrime + if (monthPrime < 10) 3 else -9
    year += if (month <= 2) 1 else 0
    return DateParts(year.toInt(), month.toInt(), day.toInt())
}

private fun floorDiv(value: Long, divisor: Long): Long {
    val quotient = value / divisor
    val remainder = value % divisor
    return if (remainder < 0) quotient - 1 else quotient
}

private fun floorMod(value: Long, divisor: Long): Long {
    val remainder = value % divisor
    return if (remainder < 0) remainder + divisor else remainder
}

private val DATE_PATTERN = Regex("^(\\d{4})-(\\d{2})-(\\d{2})$")
