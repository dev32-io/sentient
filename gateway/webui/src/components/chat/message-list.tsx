/**
 * Compatibility entry for existing chat callers. New consumers should import
 * the bounded API from ./index.ts and use MessageChronology.
 */
export {
  MessageChronology,
  MessageChronology as MessageList,
  assistantStateFor,
  dividerLabelFor,
} from "./message-chronology.tsx";
export type {
  MessageChronologyProps,
  MessageChronologyProps as MessageListProps,
  MessageChronologyStatus,
  MessageChronologyStatus as MessageListStatus,
} from "./message-chronology.tsx";
