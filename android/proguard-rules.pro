# R8 keep rules for the prod (release) build.
#
# Obfuscation is safe for the wire protocol: kotlinx.serialization is compile-time
# and the gateway contract is pinned by @SerialName string literals, not class
# names — so R8 may freely rename the classes. We only need to keep the generated
# serializers + Companion accessors so the runtime can resolve them.

-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**

# Keep generated serializers and the Companion.serializer() accessors for every
# @Serializable model in the SDK (protocol frames + nested payloads).
-keep,includedescriptorclasses class io.sentient.mobilesdk.**$$serializer { *; }
-keepclasseswithmembers class io.sentient.mobilesdk.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclassmembers class io.sentient.mobilesdk.** {
    *** Companion;
}

# Transitive deps that reference optional classes absent from the Android runtime.
-dontwarn org.slf4j.**
-dontwarn java.lang.management.**
