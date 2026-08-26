import type { JSX } from "preact";
import { Avatar, type AvatarTint } from "../common/avatar.tsx";
import type { SentientIdentityState } from "../common/sentient-identity.tsx";

export interface CurrentUser {
  displayName: string;
  avatarTint: AvatarTint;
}

export const ASSISTANT_NAME = "Sentient";

export interface UserMessageIdentityProps {
  currentUser: CurrentUser;
}

export function UserMessageIdentity({ currentUser }: UserMessageIdentityProps): JSX.Element {
  const initial = currentUser.displayName.charAt(0).toUpperCase() || "?";
  return <Avatar kind="user" initial={initial} name={currentUser.displayName} tint={currentUser.avatarTint} size="lg" />;
}

export interface AssistantMessageIdentityProps {
  state: SentientIdentityState;
}

export function AssistantMessageIdentity({ state }: AssistantMessageIdentityProps): JSX.Element {
  return <Avatar kind="assistant" mode={state} name={ASSISTANT_NAME} size="lg" />;
}

export function MessageContinuationIdentity(): JSX.Element {
  return <span class="message-bubble__avatar-spacer" aria-hidden="true" />;
}
