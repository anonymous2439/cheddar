import { api } from "./client";
import type { BeatsAttemptAck, BeatsJudgment, BeatsRound, BeatsState } from "../types";

export function createBeatsSession(lobbyId: number, mode: "4key" | "8key", bpm: number, pulseCount: number) {
  return api
    .post<BeatsState>(`/beats/${lobbyId}/session`, { mode, bpm, pulse_count: pulseCount })
    .then((r) => r.data);
}

export function getBeatsState(lobbyId: number) {
  return api.get<BeatsState>(`/beats/${lobbyId}/state`).then((r) => r.data);
}

export function getBeatsRound(lobbyId: number, level: number) {
  return api.get<BeatsRound>(`/beats/${lobbyId}/round`, { params: { level } }).then((r) => r.data);
}

export function submitBeatsAttempt(lobbyId: number, level: number, judgment: BeatsJudgment, revActive: boolean) {
  return api
    .post<BeatsAttemptAck>(`/beats/${lobbyId}/attempt`, { level, judgment, rev_active: revActive })
    .then((r) => r.data);
}
