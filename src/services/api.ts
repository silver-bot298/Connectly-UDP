import type { AuthResponse, ChatMessage, PeerUser, UserProfile } from "../types/datagram";

let memoryToken: string | null = null;

export function setAuthToken(token: string | null): void {
  memoryToken = token;
}

export function getAuthToken(): string | null {
  return memoryToken;
}

async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  if (memoryToken) {
    headers["Authorization"] = `Bearer ${memoryToken}`;
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export async function registerUser(payload: {
  full_name: string;
  username: string;
  password: string;
  confirm_password: string;
  avatar_url: string;
}): Promise<AuthResponse> {
  const res = await requestJson<AuthResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  setAuthToken(res.token);
  return res;
}

export async function loginUser(payload: {
  username: string;
  password: string;
}): Promise<AuthResponse> {
  const res = await requestJson<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  setAuthToken(res.token);
  return res;
}

export async function fetchCurrentUser(): Promise<{ user: UserProfile }> {
  return requestJson<{ user: UserProfile }>("/api/auth/me");
}

export async function updateProfile(payload: {
  full_name: string;
  avatar_url: string;
}): Promise<{ user: UserProfile }> {
  return requestJson<{ user: UserProfile }>("/api/profile", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function fetchUsers(): Promise<{ users: PeerUser[] }> {
  return requestJson<{ users: PeerUser[] }>("/api/users");
}

export async function fetchConversation(peer: string): Promise<{ messages: ChatMessage[] }> {
  return requestJson<{ messages: ChatMessage[] }>(
    `/api/messages/${encodeURIComponent(peer)}`
  );
}
