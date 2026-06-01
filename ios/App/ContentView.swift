import SwiftUI
import MobileSdk

struct ContentView: View {
    var body: some View {
        // Kotlin `object MobileSdk` is exposed by SKIE as MobileSdkKit (@ObjCName) to avoid
        // colliding with the framework module name. Swift call = MobileSdkKit.shared.greeting().
        Text(MobileSdkKit.shared.greeting())
            .accessibilityIdentifier("foundation-greeting")
            .padding()
    }
}
