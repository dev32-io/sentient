package io.sentient.mobiledata.calendar

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CalendarDateMathTest {
    @Test
    fun fixed_width_parser_matches_previous_parser_at_date_boundaries() {
        for (year in listOf(0, 1, 4, 100, 400, 1900, 2000, 2024, 9999)) {
            for (month in 0..13) {
                for (day in listOf(0, 1, 28, 29, 30, 31, 32, 99)) {
                    assertEquivalent(formatCalendarDate(DateParts(year, month, day)))
                }
            }
        }
        for (value in listOf("0000-01-01", "0000-02-29", "0400-02-29", "2000-02-29", "9999-12-31")) {
            assertTrue(isCalendarDate(value), value)
            assertEquals(value, formatCalendarDate(parseCalendarDate(value)))
        }
        assertEquals(DateParts(2024, 12, 31), parseCalendarDate("2024-12-31"))
    }

    @Test
    fun malformed_and_unicode_inputs_remain_rejected() {
        val malformed = listOf(
            "", "2024", "2024-01", "024-01-01", "02024-01-01", "10000-01-01",
            "-001-01-01", "+024-01-01", "2024-1-01", "2024-01-1",
            "2024/01/01", "2024\u201001\u201001", "2024-01-01T00:00:00Z",
            "2024-01-01;DROP TABLE events", "2024-01-01/../../", "2024-01-01extra",
        ) + listOf(" ", "\t", "\n", "\r\n", "\u0000", "\u0085", "\u2028", "\u2029", "\u200B").flatMap {
            listOf(it + "2024-01-01", "2024-01-01" + it)
        }
        for (value in malformed) {
            assertEquivalent(value)
            assertFalse(isCalendarDate(value))
        }

        // The previous default Regex \\d uses ASCII digits, including on Kotlin/Native.
        val ascii = "2024-01-01"
        for (index in ascii.indices.filter { ascii[it] != '-' }) {
            for (zero in listOf('\u0660', '\u06F0', '\u0966', '\uFF10')) {
                val unicodeDigit = zero + (ascii[index] - '0')
                val value = ascii.replaceRange(index, index + 1, unicodeDigit.toString())
                assertEquivalent(value)
                assertFalse(isCalendarDate(value))
            }
            for (character in listOf('x', '+', '-', ' ', '\u0000', '\uD800')) {
                assertEquivalent(ascii.replaceRange(index, index + 1, character.toString()))
            }
        }
    }

    @Test
    fun parse_preserves_error_categories_and_month_before_day_validation() {
        for ((value, category) in listOf(
            "2024-0x-00" to "date",
            "2024-00-00" to "month",
            "2024-13-32" to "month",
            "2024-01-00" to "day",
            "1900-02-29" to "day",
            "2024-04-31" to "day",
        )) {
            val error = assertFailsWith<IllegalArgumentException> { parseCalendarDate(value) }
            assertEquals("Invalid calendar $category: $value", error.message)
        }
    }

    private fun assertEquivalent(value: String) {
        val previous = runCatching { previousParse(value) }
        assertEquals(previous.isSuccess, isCalendarDate(value), "Validation differs for $value")
        if (previous.isSuccess) {
            assertEquals(previous.getOrThrow(), parseCalendarDate(value))
        } else {
            val error = assertFailsWith<IllegalArgumentException> { parseCalendarDate(value) }
            assertEquals(previous.exceptionOrNull()?.message, error.message)
        }
    }

    // Keep the replaced parser as the acceptance/error oracle, not in production.
    private fun previousParse(value: String): DateParts {
        val match = previousPattern.matchEntire(value)
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

    private val previousPattern = Regex("^(\\d{4})-(\\d{2})-(\\d{2})$")
}
