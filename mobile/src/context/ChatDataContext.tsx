import { createContext, useContext, type ReactNode } from "react";
import { useChatData } from "../hooks/useChatData";

type ChatData = ReturnType<typeof useChatData>;

const ChatDataContext = createContext<ChatData | null>(null);

export function ChatDataProvider({ children }: { children: ReactNode }) {
  const value = useChatData();
  return <ChatDataContext.Provider value={value}>{children}</ChatDataContext.Provider>;
}

export function useChatDataContext() {
  const ctx = useContext(ChatDataContext);
  if (!ctx) throw new Error("useChatDataContext must be used within ChatDataProvider");
  return ctx;
}
