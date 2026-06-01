package io.sentient.mobilesdk

/** Platform identity shim — the first expect/actual, proves the KMP wiring. */
expect class Platform() {
    val name: String
}
