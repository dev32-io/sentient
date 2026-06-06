package io.sentient.mobiledata.repository

import io.sentient.mobiledata.result.SentientResult
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class HistoryRepositoryTest {
    private val cached = listOf(SessionRowData("s1", "Old chat", 1L))
    private val fresh = listOf(SessionRowData("s2", "New chat", 2L))

    @Test
    fun emits_cache_loading_then_fresh_success() = runTest {
        val repo = HistoryRepository(fetch = { fresh })
        repo.seedCache(cached)
        val emissions = mutableListOf<SentientResult<List<SessionRowData>>>()
        repo.load().collect { emissions.add(it) }
        assertTrue(emissions.first() is SentientResult.Loading)
        assertEquals(cached, (emissions.first() as SentientResult.Loading).partial)
        assertTrue(emissions.last() is SentientResult.Success)
        assertEquals(fresh, (emissions.last() as SentientResult.Success).data)
    }

    @Test
    fun refresh_failure_emits_failure_but_keeps_cache() = runTest {
        val repo = HistoryRepository(fetch = { throw RuntimeException("timeout") })
        repo.seedCache(cached)
        val emissions = mutableListOf<SentientResult<List<SessionRowData>>>()
        repo.load().collect { emissions.add(it) }
        assertTrue(emissions.last() is SentientResult.Failure)
        assertEquals(cached, repo.cached())
    }
}
