const TOKEN_KEY = 'lookout_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    clearToken();
    window.location.href = '/login';
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface Project {
  id: number;
  slug: string;
  name: string;
  public_key: string;
  webhook_url: string | null;
  created_at: string;
  unresolved_count: string | number;
  events_24h: string | number;
  dsn: string;
}

export interface Issue {
  id: number;
  project_id?: number;
  project_name?: string;
  title: string;
  culprit: string | null;
  level: string;
  status: string;
  event_count: string | number;
  first_seen: string;
  last_seen: string;
  latest_event?: EventDetail | null;
}

export interface EventSummary {
  id: string;
  timestamp: string;
  level: string | null;
  message: string | null;
  environment: string | null;
  release: string | null;
}

export interface EventDetail extends EventSummary {
  payload: Record<string, unknown>;
}

export interface StatsBucket {
  bucket: string;
  count: number;
}
