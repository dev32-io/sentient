package io.sentient.mobiledata.di

import io.sentient.mobiledata.data.SdkConnectionStateRepository
import io.sentient.mobiledata.data.SdkConversationRepository
import io.sentient.mobiledata.data.SdkSessionsRepository
import io.sentient.mobiledata.usecase.DeleteSessionUseCase
import io.sentient.mobiledata.usecase.ObserveChatUseCase
import io.sentient.mobiledata.usecase.ObserveSessionsUseCase
import io.sentient.mobiledata.usecase.RenameSessionUseCase
import io.sentient.mobiledata.usecase.SendMessageUseCase
import io.sentient.mobiledata.usecase.SwitchConversationUseCase
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.util.Clock
import kotlin.time.Clock as KtClock

/**
 * User/Connection-scoped component: one per logged-in user. Builds the stateless repos +
 * usecases over a single [SentientSdk]. Platform DI (Hilt / UserSession) owns the instance;
 * the chat VM resolves usecases from here, never the SDK directly.
 */
class ChatComponent(
    sdk: SentientSdk,
    clock: Clock = Clock { KtClock.System.now().toEpochMilliseconds() },
) {
    private val conversation = SdkConversationRepository(sdk)
    private val sessions = SdkSessionsRepository(sdk)
    val connection = SdkConnectionStateRepository(sdk)

    val observeChat = ObserveChatUseCase(conversation, clock)
    val switchConversation = SwitchConversationUseCase(sessions)
    val sendMessage = SendMessageUseCase(conversation)
    val observeSessions = ObserveSessionsUseCase(sessions)
    val renameSession = RenameSessionUseCase(sessions)
    val deleteSession = DeleteSessionUseCase(sessions)
}
