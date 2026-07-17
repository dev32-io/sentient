// ---------------------------------------------------------------------------
// SettingsStubScaffold — the shared placeholder body for the settings category
// pages that are scaffolded (routes wired, navigation live) but not yet built.
// It renders a SettingsTopBar + a scrollable body; the default body is a "Coming
// in this branch" placeholder. A later page agent replaces the page file's body
// with the real controls — it never re-touches Routes.kt / AppNavHost.kt because
// the route + host wiring already exist.
//
// [content] lets a stub add navigable affordances (e.g. Voice's Add / Clone rows)
// while staying on this scaffold; omit it for a plain placeholder page.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private const val PLACEHOLDER_TEXT = "Coming in this branch."

/**
 * A scaffolded category page. [title] names the page; [onBack] pops the stack;
 * [screenTestTag] / [backTestTag] identify the page + chevron for E2E. [content]
 * is the page body (defaults to the placeholder line).
 */
@Composable
fun SettingsStubScaffold(
    title: String,
    onBack: () -> Unit,
    screenTestTag: String,
    backTestTag: String,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit = { StubPlaceholder() },
) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .testTag(screenTestTag),
    ) {
        SettingsTopBar(title = title, onBack = onBack, backTestTag = backTestTag)
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            verticalArrangement = Arrangement.spacedBy(tokens.space.md),
            content = content,
        )
    }
}

@Composable
private fun StubPlaceholder() {
    val tokens = LocalTokens.current
    Text(
        text = PLACEHOLDER_TEXT,
        modifier = Modifier.testTag("settings-stub-placeholder"),
        color = Color(Colors.ink3),
        fontSize = tokens.type.base,
    )
}

@Preview
@Composable
private fun SettingsStubScaffoldPreview() {
    SentientTheme {
        SettingsStubScaffold(
            title = "Memory",
            onBack = {},
            screenTestTag = "settings-memory-screen",
            backTestTag = "settings-memory-back",
        )
    }
}
