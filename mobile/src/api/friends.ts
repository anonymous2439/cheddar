import { api } from "./client";
import type { FriendRequest, User } from "../types";

export function sendFriendRequest(user_id: number) {
  return api.post<FriendRequest>("/friends/requests", { user_id }).then((r) => r.data);
}

export function listFriendRequests(direction: "incoming" | "outgoing") {
  return api
    .get<FriendRequest[]>("/friends/requests", { params: { direction } })
    .then((r) => r.data);
}

export function acceptFriendRequest(requestId: number) {
  return api.post<FriendRequest>(`/friends/requests/${requestId}/accept`).then((r) => r.data);
}

export function declineFriendRequest(requestId: number) {
  return api.post<FriendRequest>(`/friends/requests/${requestId}/decline`).then((r) => r.data);
}

export function cancelFriendRequest(requestId: number) {
  return api.delete(`/friends/requests/${requestId}`);
}

export function listFriends() {
  return api.get<User[]>("/friends").then((r) => r.data);
}

export function removeFriend(userId: number) {
  return api.delete(`/friends/${userId}`);
}

export function searchUsers(query: string) {
  return api.get<User[]>("/users/search", { params: { q: query } }).then((r) => r.data);
}
