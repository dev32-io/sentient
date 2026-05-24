import type { UserErrorCategory } from "./error-classifier";

// Friendly messages — zero jargon, i18n-swappable
const messages: Record<UserErrorCategory, string> = {
  connection_lost:     "Sorry, I lost the connection. Reconnecting...",
  didnt_catch:         "I didn't catch that. Could you repeat?",
  thinking_timeout:    "Hmm, I'm taking longer than usual...",
  service_unavailable: "I'm having trouble right now. Try again in a moment.",
  auth_required:       "Please sign in again to continue.",
  try_again:           "Something went wrong. Could you try again?",
};

export function friendlyMessage(category: UserErrorCategory): string {
  return messages[category];
}
