import { api } from "./client";
import type { MtgDeckImportResult, MtgDeckStatusOut, MtgState, MtgZone } from "../types";

export function importMtgDeck(lobbyId: number, decklist: string) {
  return api.post<MtgDeckImportResult>(`/mtg/${lobbyId}/deck`, { decklist }).then((r) => r.data);
}

export function getMtgDeckStatus(lobbyId: number) {
  return api.get<MtgDeckStatusOut>(`/mtg/${lobbyId}/deck-status`).then((r) => r.data);
}

export function createMtgSession(lobbyId: number) {
  return api.post<MtgState>(`/mtg/${lobbyId}/session`).then((r) => r.data);
}

export function getMtgState(lobbyId: number) {
  return api.get<MtgState>(`/mtg/${lobbyId}/state`).then((r) => r.data);
}

export function drawMtgCard(lobbyId: number) {
  return api.post<MtgState>(`/mtg/${lobbyId}/draw`).then((r) => r.data);
}

export function shuffleMtgLibrary(lobbyId: number) {
  return api.post<MtgState>(`/mtg/${lobbyId}/shuffle`).then((r) => r.data);
}

export function moveMtgCard(
  lobbyId: number,
  params: {
    instanceId: string;
    ownerUserId: number;
    fromZone: MtgZone;
    toZone: MtgZone;
    x?: number;
    y?: number;
    // Only meaningful for hand -> battlefield (summoning).
    faceDown?: boolean;
  },
) {
  return api
    .post<MtgState>(`/mtg/${lobbyId}/move`, {
      instance_id: params.instanceId,
      owner_user_id: params.ownerUserId,
      from_zone: params.fromZone,
      to_zone: params.toZone,
      x: params.x,
      y: params.y,
      face_down: params.faceDown ?? false,
    })
    .then((r) => r.data);
}

export function tapMtgCard(lobbyId: number, instanceId: string, ownerUserId: number, tapped: boolean) {
  return api
    .post<MtgState>(`/mtg/${lobbyId}/tap`, { instance_id: instanceId, owner_user_id: ownerUserId, tapped })
    .then((r) => r.data);
}

export function updateMtgCounter(
  lobbyId: number,
  instanceId: string,
  ownerUserId: number,
  counterType: string,
  delta: number,
) {
  return api
    .post<MtgState>(`/mtg/${lobbyId}/counter`, {
      instance_id: instanceId,
      owner_user_id: ownerUserId,
      counter_type: counterType,
      delta,
    })
    .then((r) => r.data);
}

export function adjustMtgLife(lobbyId: number, targetUserId: number, delta: number) {
  return api.post<MtgState>(`/mtg/${lobbyId}/life`, { target_user_id: targetUserId, delta }).then((r) => r.data);
}

export function advanceMtgPhase(lobbyId: number) {
  return api.post<MtgState>(`/mtg/${lobbyId}/phase`).then((r) => r.data);
}

export function concedeMtg(lobbyId: number) {
  return api.post<MtgState>(`/mtg/${lobbyId}/concede`).then((r) => r.data);
}
