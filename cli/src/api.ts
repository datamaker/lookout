import { getLinkedProject, getToken, getUrl } from './config.js';

/** Thin typed client over the lookout dashboard API (JWT Bearer auth). */

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
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

export type IssueStatus = 'unresolved' | 'resolved' | 'ignored';

export interface IssueSummary {
  id: number;
  title: string;
  culprit: string | null;
  level: string;
  status: IssueStatus;
  event_count: number;
  first_seen: string;
  last_seen: string;
}

export interface IssueDetail extends IssueSummary {
  project_id: number;
  project_name: string;
  project_slug: string;
  latest_event: {
    id: string;
    timestamp: string;
    level: string;
    environment: string | null;
    release: string | null;
    payload: Record<string, unknown>;
  } | null;
}

export interface EventSummary {
  id: string;
  timestamp: string;
  level: string;
  message: string | null;
  environment: string | null;
  release: string | null;
}

function baseUrl(): string {
  const url = getUrl();
  if (!url) {
    throw new ApiError('No lookout server configured. Run `lookout login` first (or set LOOKOUT_URL).');
  }
  return url.replace(/\/+$/, '');
}

async function request<T>(path: string, init?: RequestInit & { auth?: boolean }): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init?.auth !== false) {
    const token = getToken();
    if (!token) {
      throw new ApiError('Not logged in. Run `lookout login` first (or set LOOKOUT_TOKEN).');
    }
    headers.authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
  } catch (err) {
    throw new ApiError(`Cannot reach ${baseUrl()} — ${(err as Error).message}`);
  }

  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 401) {
      throw new ApiError('Session expired or invalid. Run `lookout login` again.', 401);
    }
    throw new ApiError(String(body.error ?? `HTTP ${res.status}`), res.status);
  }
  return body as T;
}

export const api = {
  login(url: string, email: string, password: string) {
    return fetch(`${url.replace(/\/+$/, '')}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then(async (res) => {
      const body = (await res.json().catch(() => ({}))) as {
        token?: string;
        user?: { email: string; name: string; role: string };
        error?: string;
      };
      if (!res.ok || !body.token) throw new ApiError(body.error ?? `login failed (HTTP ${res.status})`);
      return body as { token: string; user: { email: string; name: string; role: string } };
    });
  },

  /** Public SSO info; older servers return only {enabled}. */
  oidcStatus(url: string) {
    return fetch(`${url.replace(/\/+$/, '')}/api/auth/oidc/status`).then(
      (res) => res.json() as Promise<{ enabled: boolean; issuer?: string; cliClientId?: string }>,
    );
  },

  /** Trade a device-flow id_token for a lookout JWT. */
  exchangeIdToken(url: string, idToken: string) {
    return fetch(`${url.replace(/\/+$/, '')}/api/auth/oidc/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }).then(async (res) => {
      const body = (await res.json().catch(() => ({}))) as {
        token?: string;
        user?: { email: string; name: string; role: string };
        error?: string;
      };
      if (!res.ok || !body.token) throw new ApiError(body.error ?? `sso exchange failed (HTTP ${res.status})`);
      return body as { token: string; user: { email: string; name: string; role: string } };
    });
  },

  me() {
    return request<{ user: { id: number; email: string; name: string; role: string } }>('/api/auth/me');
  },

  projects() {
    return request<Project[]>('/api/projects');
  },

  issues(
    projectId: number,
    opts: { status?: IssueStatus; q?: string; limit?: number; offset?: number } = {},
  ) {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.q) params.set('q', opts.q);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return request<{ issues: IssueSummary[]; counts: Record<string, number> }>(
      `/api/projects/${projectId}/issues${qs ? `?${qs}` : ''}`,
    );
  },

  issue(id: number) {
    return request<IssueDetail>(`/api/issues/${id}`);
  },

  issueEvents(id: number, limit = 20) {
    return request<{ events: EventSummary[] }>(`/api/issues/${id}/events?limit=${limit}`);
  },

  event(id: string) {
    return request<EventSummary & { payload: Record<string, unknown> }>(`/api/events/${id}`);
  },

  updateIssue(id: number, status: IssueStatus) {
    return request<IssueSummary>(`/api/issues/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  },
};

/**
 * Resolve a project reference (id, slug, or name — case-insensitive) to the
 * project row. With no reference: the linked .lookout.json project, else the
 * only project on the server.
 */
export async function resolveProject(ref?: string): Promise<Project> {
  const projects = await api.projects();
  const wanted = ref ?? getLinkedProject();

  if (wanted) {
    const found = projects.find(
      (p) =>
        String(p.id) === wanted ||
        p.slug === wanted.toLowerCase() ||
        p.name.toLowerCase() === wanted.toLowerCase(),
    );
    if (!found) {
      throw new ApiError(
        `Project "${wanted}" not found. Available: ${projects.map((p) => p.slug).join(', ') || '(none)'}`,
      );
    }
    return found;
  }

  if (projects.length === 1) return projects[0];
  throw new ApiError(
    projects.length === 0
      ? 'No projects on this server yet.'
      : `Multiple projects — pass -p <project> or run \`lookout link\`. Available: ${projects
          .map((p) => p.slug)
          .join(', ')}`,
  );
}
