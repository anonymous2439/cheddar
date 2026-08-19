import { useState } from "react";
import * as friendsApi from "../api/friends";
import type { Conversation, FriendRequest, User } from "../types";

interface Props {
  friends: User[];
  incomingRequests: FriendRequest[];
  outgoingRequests: FriendRequest[];
  onlineUserIds: Set<number>;
  onRefresh: () => Promise<void>;
  onMessageFriend: (userId: number) => Promise<Conversation>;
  onSelectConversation: (conversation: Conversation) => void;
}

export function FriendsPanel({
  friends,
  incomingRequests,
  outgoingRequests,
  onlineUserIds,
  onRefresh,
  onMessageFriend,
  onSelectConversation,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim().length < 2) return;
    setSearching(true);
    setMessage(null);
    try {
      setResults(await friendsApi.searchUsers(query.trim()));
    } finally {
      setSearching(false);
    }
  }

  async function handleAdd(userId: number) {
    try {
      await friendsApi.sendFriendRequest(userId);
      setMessage("Friend request sent");
      setResults((prev) => prev.filter((u) => u.id !== userId));
      await onRefresh();
    } catch {
      setMessage("Could not send request (maybe already sent, or blocked)");
    }
  }

  async function handleAccept(requestId: number) {
    await friendsApi.acceptFriendRequest(requestId);
    await onRefresh();
  }

  async function handleDecline(requestId: number) {
    await friendsApi.declineFriendRequest(requestId);
    await onRefresh();
  }

  async function handleCancel(requestId: number) {
    await friendsApi.cancelFriendRequest(requestId);
    await onRefresh();
  }

  async function handleMessage(userId: number) {
    const conversation = await onMessageFriend(userId);
    onSelectConversation(conversation);
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3 text-sm">
      <form onSubmit={handleSearch} className="mb-4">
        <label className="mb-1 block text-xs font-semibold uppercase text-neutral-500">Add friend</label>
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search username..."
            className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm outline-none focus:border-amber-500"
          />
          <button
            type="submit"
            disabled={searching}
            className="rounded bg-amber-500 px-3 py-1 text-white hover:bg-amber-600 disabled:opacity-50"
          >
            Search
          </button>
        </div>
        {message && <p className="mt-1 text-xs text-neutral-500">{message}</p>}
        {results.length > 0 && (
          <ul className="mt-2 space-y-1">
            {results.map((u) => (
              <li key={u.id} className="flex items-center justify-between rounded bg-neutral-50 px-2 py-1">
                <span>{u.display_name} (@{u.username})</span>
                <button onClick={() => handleAdd(u.id)} className="text-amber-600 hover:underline">
                  Add
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>

      {incomingRequests.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-1 text-xs font-semibold uppercase text-neutral-500">Incoming requests</h3>
          <ul className="space-y-1">
            {incomingRequests.map((r) => (
              <li key={r.id} className="flex items-center justify-between rounded bg-neutral-50 px-2 py-1">
                <span>{r.user.display_name}</span>
                <span className="flex gap-2">
                  <button onClick={() => handleAccept(r.id)} className="text-green-600 hover:underline">
                    Accept
                  </button>
                  <button onClick={() => handleDecline(r.id)} className="text-red-600 hover:underline">
                    Decline
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {outgoingRequests.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-1 text-xs font-semibold uppercase text-neutral-500">Sent requests</h3>
          <ul className="space-y-1">
            {outgoingRequests.map((r) => (
              <li key={r.id} className="flex items-center justify-between rounded bg-neutral-50 px-2 py-1">
                <span>{r.user.display_name}</span>
                <button onClick={() => handleCancel(r.id)} className="text-neutral-500 hover:underline">
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-neutral-500">Friends</h3>
        {friends.length === 0 && <p className="text-neutral-500">No friends yet.</p>}
        <ul className="space-y-1">
          {friends.map((f) => (
            <li key={f.id} className="flex items-center justify-between rounded px-2 py-1 hover:bg-neutral-50">
              <span className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${onlineUserIds.has(f.id) ? "bg-green-500" : "bg-neutral-300"}`} />
                {f.display_name}
              </span>
              <button onClick={() => handleMessage(f.id)} className="text-amber-600 hover:underline">
                Message
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
