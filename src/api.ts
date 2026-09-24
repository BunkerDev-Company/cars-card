import type { GameState, ScoreEvent, TimedAction } from '@sim';

const BASE = '/api/v1';
const TOKEN_KEY = 'cc_token';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: number,
    message: string,
    public details?: string | null,
  ) {
    super(message);
  }
}

let token: string | null = null;
try {
  token = localStorage.getItem(TOKEN_KEY);
} catch {
  /* приватный режим — живём без сохранения */
}

export function setToken(t: string | null) {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
}

export function hasToken() {
  return !!token;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      json?.error?.code ?? res.status,
      json?.error?.message ?? res.statusText,
      json?.error?.details,
    );
  }
  return json.data as T;
}

// -- Типы ответов ------------------------------------------------------------

export interface AuthResult {
  access_token: string;
  id: string;
  nickname: string;
  balance: string;
}

export interface Me {
  id: string;
  nickname: string;
  balance: string;
  bestScore: number;
  racesPlayed: number;
  activeRaceId: string | null;
}

export interface RaceView {
  id: string;
  status: string;
  seq: number;
  startedAt: string;
  serverNow: string;
  state: GameState;
}

export interface BatchResult {
  seq: number;
  status: string;
  state: GameState;
  events: ScoreEvent[];
  balance: string;
}

export interface LeaderRow {
  nickname: string;
  balance: string;
  bestScore: number;
  racesPlayed: number;
}

export interface Leaderboard {
  byBalance: LeaderRow[];
  byBestRace: LeaderRow[];
}

export interface PointsSummary {
  byReason: { reason: string; total: number; count: number }[];
  races: { id: string; status: string; score: number; tick: number; started_at: string }[];
}

// -- Эндпоинты ---------------------------------------------------------------

export const api = {
  register: (nickname: string, password: string) =>
    request<AuthResult>('POST', '/authentication/register', { nickname, password }),
  login: (nickname: string, password: string) =>
    request<AuthResult>('POST', '/authentication/login', { nickname, password }),
  me: () => request<Me>('GET', '/authentication/me'),
  startRace: () => request<RaceView>('POST', '/races'),
  getRace: (id: string) => request<RaceView>('GET', `/races/${id}`),
  sendBatch: (id: string, seq: number, inputs: number[], actions: TimedAction[]) =>
    request<BatchResult>('POST', `/races/${id}/batches`, { seq, inputs, actions }),
  leaderboard: () => request<Leaderboard>('GET', '/leaderboard?limit=10'),
  myPoints: () => request<PointsSummary>('GET', '/me/points?limit=5'),
};
