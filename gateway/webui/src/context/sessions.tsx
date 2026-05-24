import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { UseSessions } from "../hooks/use-sessions.ts";

const SessionsContext = createContext<UseSessions | null>(null);

export const SessionsProvider = SessionsContext.Provider;

export function useSessionsContext(): UseSessions {
  const v = useContext(SessionsContext);
  if (!v) throw new Error("SessionsProvider missing");
  return v;
}
