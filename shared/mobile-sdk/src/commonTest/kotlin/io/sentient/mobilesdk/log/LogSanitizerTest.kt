package io.sentient.mobilesdk.log

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LogSanitizerTest {

    @Test
    fun redacts_paseto_v4_local() {
        val msg = "auth token v4.local.AAAAAAAAAAAAAAAAAAAAAAAAAA done"
        val out = sanitizeLog(msg)
        assertFalse(out.contains("v4.local.AAAA"))
        assertTrue(out.contains("[redacted]"))
    }

    @Test
    fun redacts_paseto_v4_public() {
        val msg = "signed token v4.public.BBBBBBBBBBBBBBBBBBBBBBBBBB ok"
        val out = sanitizeLog(msg)
        assertFalse(out.contains("v4.public.BBBB"))
        assertTrue(out.contains("[redacted]"))
    }

    @Test
    fun redacts_bearer_token() {
        val msg = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"
        val out = sanitizeLog(msg)
        assertFalse(out.contains("eyJhbGciOiJIUzI1NiJ9"))
        assertTrue(out.contains("[redacted]"))
    }

    @Test
    fun redacts_bearer_token_case_insensitive() {
        val msg = "header bearer SOME_TOKEN_VALUE"
        val out = sanitizeLog(msg)
        assertFalse(out.contains("SOME_TOKEN_VALUE"))
        assertTrue(out.contains("[redacted]"))
    }

    @Test
    fun redacts_sentient_auth_key() {
        val msg = "using key sak_AbcDef1234567890 for service"
        val out = sanitizeLog(msg)
        assertFalse(out.contains("sak_AbcDef"))
        assertTrue(out.contains("[redacted]"))
    }

    @Test
    fun redacts_paseto_with_base64url_chars() {
        // PASETO payloads use base64url which contains '-' and '_'
        val msg = "token v4.local.aB3-xY_zQ2w done"
        val out = sanitizeLog(msg)
        assertFalse(out.contains("aB3-xY_zQ2w"))
        assertTrue(out.contains("[redacted]"))
    }

    @Test
    fun redacts_paseto_with_footer_section() {
        // A PASETO token with a footer: v4.local.PAYLOAD.FOOTER — footer must not leak
        val msg = "auth v4.local.AAABBBCCC.FOOTERDATA end"
        val out = sanitizeLog(msg)
        assertFalse(out.contains("AAABBBCCC"))
        assertFalse(out.contains("FOOTERDATA"), "footer section must be redacted, not leaked")
        assertTrue(out.contains("[redacted]"))
    }

    @Test
    fun redacts_bearer_token_uppercase() {
        // BEARER uppercase must be caught by case-insensitive bearer regex
        val msg = "header BEARER MY_SECRET_TOKEN"
        val out = sanitizeLog(msg)
        assertFalse(out.contains("MY_SECRET_TOKEN"))
        assertTrue(out.contains("[redacted]"))
    }

    @Test
    fun passes_through_safe_messages() {
        val msg = "session started sessionId=abc123 cycleId=xyz"
        val out = sanitizeLog(msg)
        assertTrue(out == msg)
    }

    @Test
    fun truncates_long_previews() {
        assertTrue(truncatePreview("x".repeat(500)).length <= 123)
    }

    @Test
    fun does_not_truncate_short_previews() {
        val short = "hello world"
        assertTrue(truncatePreview(short) == short)
    }

    @Test
    fun truncated_preview_ends_with_ellipsis() {
        val out = truncatePreview("x".repeat(500))
        assertTrue(out.endsWith("…"))
    }
}
