# Android Testing -- Details & Examples

This file expands `platforms/android/rules/android-testing.md`.
Code skeletons for each test layer plus the fake-vs-mock decision
example.

## Unit test -- ViewModel + reducer

Setup uses `runTest`, a `TestDispatcher`, and a `Dispatchers.Main`
replacement so `viewModelScope.launch { ... }` runs on the test
dispatcher.

```kotlin
@OptIn(ExperimentalCoroutinesApi::class)
class LoginViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(testDispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `EmailChanged updates state and clears email error`() = runTest {
        val vm = LoginViewModel(FakeAuthRepository())
        // Seed state with an error so we can verify it clears.
        vm.dispatch(LoginIntent.EmailChanged("invalid"))
        vm.dispatch(LoginIntent.SubmitTapped)
        advanceUntilIdle()
        check(vm.state.value.emailError != null)

        vm.dispatch(LoginIntent.EmailChanged("a@b.c"))

        assertEquals("a@b.c", vm.state.value.email)
        assertNull(vm.state.value.emailError)
    }

    @Test
    fun `SubmitTapped on network failure emits ShowError effect`() = runTest {
        val fake = FakeAuthRepository().apply {
            nextOutcome = LoginOutcome.NetworkFailure
        }
        val vm = LoginViewModel(fake)
        val effects = mutableListOf<LoginEffect>()
        val job = launch(testDispatcher) { vm.effects.toList(effects) }

        vm.dispatch(LoginIntent.EmailChanged("a@b.c"))
        vm.dispatch(LoginIntent.PasswordChanged("hunter2"))
        vm.dispatch(LoginIntent.SubmitTapped)
        advanceUntilIdle()

        assertEquals(LoginEffect.ShowError("Network unavailable"), effects.single())
        job.cancel()
    }
}
```

Pattern points:
- `Dispatchers.setMain(testDispatcher)` so `viewModelScope` uses
  the test dispatcher.
- `advanceUntilIdle()` drains pending coroutines.
- `runTest`'s built-in `TestScope` lets you `launch` collectors
  alongside the unit under test.

## Compose UI test -- isolated component

```kotlin
class NameFieldTest {

    @get:Rule val composeRule = createComposeRule()

    @Test
    fun typingFiresOnChangeCallback() {
        var captured = ""
        composeRule.setContent {
            AppTheme {
                NameField(name = "", onNameChange = { captured = it })
            }
        }

        composeRule.onNodeWithText("Name").performTextInput("Ada")

        assertEquals("Ada", captured)
    }
}
```

No Activity, no Hilt -- just the composable.

## Compose UI test -- Hilt-injected screen

```kotlin
@HiltAndroidTest
@UninstallModules(RepositoryModule::class)
class LoginScreenTest {

    @get:Rule(order = 0) val hiltRule = HiltAndroidRule(this)
    @get:Rule(order = 1)
    val composeRule = createAndroidComposeRule<HiltTestActivity>()

    @Inject lateinit var auth: AuthRepository

    @Before fun setUp() { hiltRule.inject() }

    @Test
    fun submitFailureShowsSnackbar() {
        (auth as FakeAuthRepository).nextOutcome = LoginOutcome.NetworkFailure

        composeRule.setContent { AppTheme { LoginScreen({}, {}) } }
        composeRule.onNodeWithText("Email").performTextInput("a@b.c")
        composeRule.onNodeWithText("Password").performTextInput("hunter2")
        composeRule.onNodeWithText("Submit").performClick()

        composeRule.onNodeWithText("Network unavailable").assertIsDisplayed()
    }
}

@AndroidEntryPoint
class HiltTestActivity : ComponentActivity()
```

The Hilt-injected fake (registered via `@TestInstallIn`) lets
the test set up "what happens next" before driving the UI.

## Instrumented test -- Room migration

```kotlin
@RunWith(AndroidJUnit4::class)
class UserDatabaseMigrationTest {

    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        UserDatabase::class.java,
    )

    @Test
    fun migrate1To2() {
        helper.createDatabase(TEST_DB, 1).use { db ->
            db.execSQL("INSERT INTO user(id, name) VALUES('u-1', 'Ada')")
        }

        helper.runMigrationsAndValidate(TEST_DB, 2, true, MIGRATION_1_2).use { db ->
            val cursor = db.query("SELECT id, name, created_at FROM user")
            check(cursor.moveToFirst())
            assertEquals("u-1", cursor.getString(0))
            assertEquals("Ada", cursor.getString(1))
            // Migration added created_at with a default.
            assertNotNull(cursor.getString(2))
        }
    }

    private companion object { const val TEST_DB = "migration-test" }
}
```

Migrations are exactly the kind of thing fakes can't simulate --
you need real SQLite behavior. That justifies the slower
instrumented layer.

## Maestro E2E flow -- `login.yaml`

```yaml
# qa/android/charters/login/login-happy-path.yaml
appId: com.example.app
---
- launchApp:
    clearState: true
- tapOn: "Get Started"
- tapOn:
    id: "email"
- inputText: "a@b.c"
- tapOn:
    id: "password"
- inputText: "hunter2"
- tapOn: "Submit"
- assertVisible: "Home"
```

This is the smallest viable happy-path E2E. Run from the QA
session; promote to a row in the feature's e2e matrix when the
charter finds a regression worth gating on.

## Fake vs mock -- the decision

A mock asserts on calls; a fake provides behavior. The
difference matters when you refactor.

```kotlin
// MOCK -- breaks on benign refactors.
@Test
fun loginCallsApiOnce() {
    val api: AuthApi = mockk(relaxed = true)
    coEvery { api.login(any(), any()) } returns LoginResp.Ok("u-1")

    val vm = LoginViewModel(DefaultAuthRepository(api, FakeTokenStore()))
    vm.dispatch(LoginIntent.SubmitTapped)

    coVerify(exactly = 1) { api.login(any(), any()) }  // brittle
}
```

If the repository starts caching, this test fails even though
the user-visible behavior is unchanged.

```kotlin
// FAKE -- asserts behavior, not implementation.
@Test
fun loginNavigatesToHome() = runTest {
    val fake = FakeAuthRepository().apply {
        nextOutcome = LoginOutcome.Success(UserId("u-1"))
    }
    val vm = LoginViewModel(fake)
    val effects = mutableListOf<LoginEffect>()
    val job = launch { vm.effects.toList(effects) }

    vm.dispatch(LoginIntent.EmailChanged("a@b.c"))
    vm.dispatch(LoginIntent.PasswordChanged("hunter2"))
    vm.dispatch(LoginIntent.SubmitTapped)
    advanceUntilIdle()

    assertEquals(LoginEffect.NavigateToHome(UserId("u-1")), effects.single())
    job.cancel()
}
```

Caching, retries, batching, request deduplication -- the
repository can change all of these and the test passes as long
as the success path produces a `NavigateToHome` effect.

The rule: mock at the SDK / network / static-Java boundary
where you don't own the type; fake your own interfaces.

## Robolectric + Compose on JVM (audit A13)

Robolectric 4.13+ supports compileSdk 36. Configure:

```kotlin
// build.gradle.kts (Compose-aware library)
android {
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }
}

dependencies {
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.compose.ui.test.junit4)
    testImplementation(libs.androidx.compose.ui.test.manifest)
}
```

```kotlin
@RunWith(AndroidJUnit4::class)
@Config(sdk = [36])
class CounterScreenRobolectricTest {
    @get:Rule val composeTestRule = createComposeRule()

    @Test fun increments_on_click() {
        composeTestRule.setContent {
            AppTheme { CounterScreen(state = CounterUiState(0), onIncrement = {}) }
        }
        composeTestRule.onNodeWithText("0").assertIsDisplayed()
    }
}
```

## Roborazzi screenshot regression

```kotlin
dependencies {
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.roborazzi.junit.rule)
}
```

```kotlin
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CounterScreenSnapshotTest {
    @get:Rule val composeTestRule = createComposeRule()

    @Test fun snapshot_default() {
        composeTestRule.setContent { AppTheme { CounterScreen(state = CounterUiState(0)) {} } }
        composeTestRule.onRoot().captureRoboImage("src/test/snapshots/counter_default.png")
    }
}
```

Run `./gradlew recordRoborazziDebug` to create baselines; `./gradlew verifyRoborazziDebug` on PR to diff.

## Macrobenchmark + JankStats (audit G2b)

Cold start:

```kotlin
@RunWith(AndroidJUnit4::class)
class StartupBenchmark {
    @get:Rule val rule = MacrobenchmarkRule()

    @Test
    fun cold() = rule.measureRepeated(
        packageName = "io.dev32.sample",
        metrics = listOf(StartupTimingMetric()),
        iterations = 5,
        startupMode = StartupMode.COLD,
    ) {
        pressHome()
        startActivityAndWait()
    }
}
```

JankStats in production Activity:

```kotlin
class MainActivity : ComponentActivity() {
    private lateinit var jankStats: JankStats
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        jankStats = JankStats.createAndTrack(window) { frameData ->
            if (frameData.isJank) Log.d("jank", "$frameData")
        }
        setContent { AppTheme { App() } }
    }
}
```

`JankStats.OnFrameListener` callback fires per frame; gate logging to debug builds or report to analytics on release with sampling.
