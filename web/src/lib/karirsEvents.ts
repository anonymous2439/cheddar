// The Karirs wallet balance is shown in KarirsGame, but the daily-bonus
// claim button lives in two entirely separate components (ChatWindow and
// LobbyChatDock) that don't share any state with it — one can even be
// mounted while KarirsGame isn't (claiming from the Chats tab while the
// Games tab is closed). Rather than lifting wallet state up through
// ChatPage for this one cross-cutting case, this is a minimal pub/sub any
// component can use to say "the wallet just changed elsewhere" and any
// component showing a balance can react to by refetching.
type Listener = () => void;

const listeners = new Set<Listener>();

export function onKarirsWalletChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyKarirsWalletChanged(): void {
  listeners.forEach((listener) => listener());
}
