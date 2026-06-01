# Mobile Navigation -- Details & Examples

This file expands `platforms/mobile/rules/mobile-navigation.md`.
Examples are written in pseudocode that translates directly to
Swift (NavigationStack + path values) and Kotlin (Navigation
Compose + typed destinations).

## Typed destinations -- the canonical shape

```pseudocode
# A closed set of destinations, each carrying its required args.
enum AppRoute:
    case home
    case product(id: ProductId)
    case orderConfirmation(orderId: OrderId, source: EntrySource)
    case settingsRoot
    case settingsAccount
    case settingsAccountEmailEdit(currentEmail: String)
```

The navigator API:

```pseudocode
navigator.push(.product(id: pid))                # OK -- compiler checks args
navigator.replace([.home, .product(id: pid)])    # OK -- typed stack rewrite
navigator.push("/product/" + pid.value)          # FORBIDDEN -- stringly-typed
```

URL parsing is the ONLY place strings cross into routes:

```pseudocode
parseDeepLink(url: String) -> AppRoute?:
    # Pattern-match the path; pull typed args. Return nil if the
    # URL does not name a known destination -- the caller decides
    # whether to show an error or fall back to home.
    switch url.path:
        case "/p/{id}":           return .product(id: ProductId(id))
        case "/order/{id}":       return .orderConfirmation(orderId: OrderId(id), source: .deepLink)
        default:                  return nil
```

## State-aware deep links

A product deep link does NOT just show the product screen. It
also:

- Selects the right bottom-tab (e.g. Shop).
- Pre-loads enough product data to avoid a flash of empty UI.
- If the user has the product in their cart, highlights the
  "in cart" affordance.

```pseudocode
handleProductDeepLink(productId):
    selectTab(.shop)
    shopTab.stack = [.product(id: productId)]
    productCache.warm(productId)               # async; UI shows skeleton
    analytics.log("deeplink.product", { id: productId })
```

The URL round-trip property:

```pseudocode
state = currentNavigatorState()
url   = formatDeepLink(state)
state2 = applyDeepLink(parseDeepLink(url))
assert state == state2
```

If round-trip fails, either the URL is lossy (some state is not
representable -- name that explicitly, document it) or the parser
and formatter are out of sync (a bug).

## Defined back behavior -- the spec table

For every screen, the spec must answer these questions:

| Question                                | Example answer for "Order Confirmation" |
| --------------------------------------- | --------------------------------------- |
| Back from system gesture                | Home tab root, flow stack cleared       |
| Back from in-screen "Done" button       | Home tab root, flow stack cleared       |
| Back from nav-bar chevron               | (hidden -- no chevron on this screen)   |
| Back when reached via deep link         | Same as above; deep link does not change destination of back |
| Back when reached mid-flow              | Same as above; flow is complete         |

The three back affordances (system gesture, in-screen, nav-bar)
MUST agree. A back chevron that pops into a half-finished
checkout is a real ship-blocker bug.

## Replacing a flow on completion

```pseudocode
# WRONG -- leaves checkout screens in the back stack.
onPlaceOrderSuccess(orderId):
    navigator.push(.orderConfirmation(orderId: orderId, source: .checkout))

# RIGHT -- the flow is done; replace, do not push.
onPlaceOrderSuccess(orderId):
    navigator.replace([.home, .orderConfirmation(orderId: orderId, source: .checkout)])
```

The user pressing back from confirmation should reach Home, not
the payment screen.

## Tabs are roots

```pseudocode
# A tab is its own navigation root.
tabs = [
    .home:     Stack([.home]),
    .search:   Stack([.searchRoot]),
    .profile:  Stack([.profileRoot]),
]

# Switching tabs is NOT a push.
switchTab(.search)                          # no global push
tabs[.search].stack.append(.product(id: x)) # pushes within Search

# Each tab's stack survives switching to another tab.
```

A deep link entering a tabbed app:

```pseudocode
applyDeepLink(.product(id: x)):
    selectTab(.search)                                   # tab choice
    tabs[.search].stack = [.searchRoot, .product(id: x)] # stack within tab
```

The other tabs retain their state. The user can still tap Profile
and find themselves where they left off.

## Anti-patterns spelled out

```pseudocode
# 1. Stringly-typed routes -- the compiler can't help you.
navigator.push("/product/" + id + "?from=home")

# 2. Pass-by-value of large objects through routes.
navigator.push(.product(fullProduct: hugeProductObject))   # restore breaks

# 3. Conditional back that depends on the path taken.
onBack(): if cameFromSearch { popToSearchRoot() }
         else { popToHomeRoot() }
# Better: the screen has ONE defined back target, and entry from
# different sources is normalized at entry time.

# 4. Navigate-by-side-effect.
globalState.shouldGoToCheckout = true
# The next render then notices and navigates. Untrackable.
```

## Why typed routes pay off

The agent reads `navigator.push(.product(id: pid))` and knows:
- The destination exists in the closed enum.
- The required arg is `id: ProductId` -- the compiler enforced it.
- The destination is searchable: grep the enum case to find every
  call site.

None of these properties hold for `navigator.push("/p/" + x)`.
The string form is a small convenience for the writer and a
large tax on every reader after.

## Platform mapping examples

### Android — Navigation Compose 2.8+ with @Serializable routes

```kotlin
@Serializable object Home
@Serializable data class Profile(val userId: String)

NavHost(navController, startDestination = Home) {
    composable<Home> { HomeScreen(...) }
    composable<Profile> { backStackEntry ->
        val route = backStackEntry.toRoute<Profile>()
        ProfileScreen(userId = route.userId)
    }
}
```

Requires `androidx.navigation:navigation-compose:2.8+` + `org.jetbrains.kotlin.plugin.serialization`.

### iOS — NavigationStack with Route enum

```swift
enum Route: Hashable {
    case home
    case profile(userId: String)
}

NavigationStack(path: $viewModel.path) {
    HomeView()
        .navigationDestination(for: Route.self) { route in
            switch route {
            case .home: HomeView()
            case .profile(let id): ProfileView(userId: id)
            }
        }
}
```

ViewModel mutates `path` (`[Route]`) to navigate; view binds.
