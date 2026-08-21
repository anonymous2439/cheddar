import { useCallback, useEffect, useState } from "react";
import * as gamesApi from "../api/games";
import { useWebSocket } from "../context/WebSocketContext";
import { useAuth } from "../context/AuthContext";
import type { GameCatalogEntry, Lobby } from "../types";

export function useGames() {
  const { user } = useAuth();
  const { subscribe } = useWebSocket();

  const [catalog, setCatalog] = useState<GameCatalogEntry[]>([]);
  const [myLobbies, setMyLobbies] = useState<Lobby[]>([]);
  const [currentLobby, setCurrentLobby] = useState<Lobby | null>(null);

  const refreshAll = useCallback(async () => {
    if (!user) return;
    const [gameCatalog, lobbies] = await Promise.all([gamesApi.listGameCatalog(), gamesApi.listMyLobbies()]);
    setCatalog(gameCatalog);
    setMyLobbies(lobbies);
  }, [user]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const applyLobby = useCallback((lobby: Lobby) => {
    setMyLobbies((prev) => {
      const idx = prev.findIndex((l) => l.id === lobby.id);
      if (idx === -1) return [lobby, ...prev];
      return [...prev.slice(0, idx), lobby, ...prev.slice(idx + 1)];
    });
    setCurrentLobby((prev) => (prev && prev.id === lobby.id ? lobby : prev));
  }, []);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === "lobby.updated" || event.type === "lobby.invited") {
        applyLobby(event.data);
      } else if (event.type === "lobby.kicked") {
        setMyLobbies((prev) => prev.filter((l) => l.id !== event.data.lobby_id));
        setCurrentLobby((prev) => (prev && prev.id === event.data.lobby_id ? null : prev));
      } else if (event.type === "game.started") {
        // start_lobby only broadcasts message.new/game.started, not
        // lobby.updated — flip status locally the same way the vscode
        // client has to, so a non-leader's UI updates too.
        setMyLobbies((prev) =>
          prev.map((l) => (l.id === event.data.lobby_id ? { ...l, status: "in_progress" } : l)),
        );
        setCurrentLobby((prev) => (prev && prev.id === event.data.lobby_id ? { ...prev, status: "in_progress" } : prev));
      }
    });
  }, [subscribe, applyLobby]);

  const selectLobby = useCallback((lobby: Lobby | null) => setCurrentLobby(lobby), []);

  const createLobby = useCallback(async (gameKey: string) => {
    const lobby = await gamesApi.createLobby(gameKey);
    applyLobby(lobby);
    setCurrentLobby(lobby);
    return lobby;
  }, [applyLobby]);

  const setReady = useCallback(
    async (lobbyId: number, isReady: boolean) => applyLobby(await gamesApi.setReady(lobbyId, isReady)),
    [applyLobby],
  );

  const startLobby = useCallback(
    async (lobbyId: number) => applyLobby(await gamesApi.startLobby(lobbyId)),
    [applyLobby],
  );

  const restartLobby = useCallback(
    async (lobbyId: number) => applyLobby(await gamesApi.restartLobby(lobbyId)),
    [applyLobby],
  );

  const finishGame = useCallback(
    async (lobbyId: number) => applyLobby(await gamesApi.finishLobbyGame(lobbyId)),
    [applyLobby],
  );

  const kickFromLobby = useCallback(
    async (lobbyId: number, userId: number) => applyLobby(await gamesApi.kickFromLobby(lobbyId, userId)),
    [applyLobby],
  );

  const transferLeader = useCallback(
    async (lobbyId: number, userId: number) => applyLobby(await gamesApi.transferLeader(lobbyId, userId)),
    [applyLobby],
  );

  const inviteToLobby = useCallback(
    async (lobbyId: number, userId: number) => applyLobby(await gamesApi.inviteToLobby(lobbyId, userId)),
    [applyLobby],
  );

  const getInviteCode = useCallback(
    async (lobbyId: number) => {
      const lobby = await gamesApi.getInviteCode(lobbyId);
      applyLobby(lobby);
      return lobby.invite_code!;
    },
    [applyLobby],
  );

  const joinLobbyByCode = useCallback(async (inviteCode: string) => {
    const lobby = await gamesApi.joinLobbyByCode(inviteCode);
    applyLobby(lobby);
    setCurrentLobby(lobby);
    return lobby;
  }, [applyLobby]);

  const leaveLobby = useCallback(async (lobbyId: number) => {
    await gamesApi.leaveLobby(lobbyId);
    setMyLobbies((prev) => prev.filter((l) => l.id !== lobbyId));
    setCurrentLobby((prev) => (prev && prev.id === lobbyId ? null : prev));
  }, []);

  return {
    catalog,
    myLobbies,
    currentLobby,
    refreshAll,
    selectLobby,
    createLobby,
    setReady,
    startLobby,
    restartLobby,
    finishGame,
    kickFromLobby,
    transferLeader,
    inviteToLobby,
    getInviteCode,
    joinLobbyByCode,
    leaveLobby,
  };
}
