import { Session, BrainActivity, SessionSummary, ContextResponse, SessionFilters } from '../types';
import type { DashboardMetrics } from '../types/dashboard';
import type { CostParams, CostAnalytics, CacheHeatmapData, CostByStageData, CostFlowData } from '../types/costs';
import type { PromptDetail } from '../types/prompt';
import type { TurnTrace } from '../types/trace';
import { fetchWithRetry } from '../utils/fetchWithRetry';

const API_BASE = import.meta.env.VITE_API_URL || '';

type AuthTokenProvider = () => Promise<string | null>;

let authTokenProvider: AuthTokenProvider | null = null;

export function setAuthTokenProvider(provider: AuthTokenProvider | null): void {
  authTokenProvider = provider;
}

/**
 * Resolves auth headers for API requests.
 * Sends a Clerk Bearer token when Clerk is configured.
 * Allows X-Dashboard-Secret only for local development.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  if (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY && authTokenProvider) {
    const token = await authTokenProvider();
    if (token) return { Authorization: `Bearer ${token}` };
  }

  const secret = import.meta.env.VITE_DASHBOARD_SECRET;
  if (secret && !import.meta.env.PROD) return { 'X-Dashboard-Secret': secret };

  return {};
}

/**
 * Wrapper around fetchWithRetry that adds auth headers automatically.
 */
async function authedFetch(url: string, options?: RequestInit): Promise<Response> {
  const authHeaders = await getAuthHeaders();
  return fetchWithRetry(url, {
    ...options,
    headers: { ...options?.headers, ...authHeaders },
  });
}

/**
 * API response wrapper type.
 */
interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

/**
 * Sessions list response.
 */
interface SessionsResponse {
  sessions: Session[];
}

/**
 * Session activity response.
 */
interface ActivityResponse {
  activities: BrainActivity[];
  messages: any[];
  summary: SessionSummary;
}

/**
 * API service for the status dashboard.
 * Centralizes all API calls with proper typing.
 */
export const api = {
  /**
   * Fetches all sessions.
   */
  async getSessions(cursor?: string, filters?: SessionFilters, limit?: number): Promise<{ sessions: Session[]; nextCursor?: string | null }> {
    const params = new URLSearchParams();
    if (cursor) params.append('cursor', cursor);
    if (limit) params.append('limit', String(limit));

    if (filters) {
      if (filters.search) params.append('search', filters.search);
      if (filters.status && filters.status.length > 0) params.append('status', filters.status.join(','));
      if (filters.type) params.append('type', filters.type);
      if (filters.stage && filters.stage.length > 0) params.append('stage', filters.stage.join(','));
      if (filters.sort) params.append('sort', filters.sort);
      if (filters.order) params.append('order', filters.order);
      if (filters.dateRange && filters.dateRange !== 'all') {
        const now = new Date();
        let from: Date;
        switch (filters.dateRange) {
          case 'today': from = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break;
          case '7d': from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
          case '30d': from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break;
        }
        params.append('from', from!.toISOString());
      }
    }

    const res = await authedFetch(`${API_BASE}/api/brain/sessions?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch sessions: ${res.statusText}`);
    }
    const json: ApiResponse<SessionsResponse & { nextCursor?: string | null }> = await res.json();
    if (!json.success) {
      throw new Error(json.error || 'Failed to load sessions');
    }
    return json.data;
  },

  /**
   * Fetches a single session by ID via dedicated endpoint.
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const res = await authedFetch(`${API_BASE}/api/brain/sessions/${sessionId}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Failed to fetch session: ${res.statusText}`);
    }
    const json: ApiResponse<Session> = await res.json();
    if (!json.success) {
      throw new Error(json.error || 'Failed to load session');
    }
    return json.data;
  },

  /**
   * Fetches activity for a specific session.
   */
  async getSessionActivity(sessionId: string): Promise<ActivityResponse> {
    const res = await authedFetch(`${API_BASE}/api/brain/activity/${sessionId}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch activity: ${res.statusText}`);
    }
    const json: ApiResponse<ActivityResponse> = await res.json();
    if (!json.success) {
      throw new Error(json.error || 'API Error');
    }
    return {
      activities: json.data.activities || [],
      // The backend no longer sends the transcript (owner decision OD-1, work-k5fk.9: mwf_ops cannot read message
      // content); turns show their telemetry only.
      messages: json.data.messages || [],
      summary: json.data.summary || { totalCost: 0, totalTokens: 0 },
    };
  },

  /**
   * Fetches assembled context bundle for a session.
   * Returns context for all users in the session.
   */
  async getSessionContext(sessionId: string): Promise<ContextResponse> {
    const res = await authedFetch(`${API_BASE}/api/brain/sessions/${sessionId}/context`);
    if (!res.ok) {
      throw new Error(`Failed to fetch context: ${res.statusText}`);
    }
    const json: ApiResponse<ContextResponse> = await res.json();
    if (!json.success) {
      throw new Error(json.error || 'Failed to load context');
    }
    return json.data;
  },

  /**
   * Fetches dashboard overview metrics.
   */
  async getDashboard(period: '24h' | '7d' | '30d' = '24h'): Promise<DashboardMetrics> {
    const res = await authedFetch(`${API_BASE}/api/brain/dashboard?period=${period}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch dashboard: ${res.statusText}`);
    }
    const json: ApiResponse<DashboardMetrics> = await res.json();
    if (!json.success) {
      throw new Error(json.error || 'Failed to load dashboard');
    }
    return json.data;
  },

  /**
   * Fetches cost analytics data.
   */
  async getCosts(params: CostParams): Promise<CostAnalytics> {
    const searchParams = new URLSearchParams();
    searchParams.append('period', params.period);
    if (params.groupBy) searchParams.append('groupBy', params.groupBy);
    if (params.modelFilter) searchParams.append('modelFilter', params.modelFilter);

    const res = await authedFetch(`${API_BASE}/api/brain/costs?${searchParams.toString()}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch costs: ${res.statusText}`);
    }
    const json: ApiResponse<CostAnalytics> = await res.json();
    if (!json.success) {
      throw new Error(json.error || 'Failed to load costs');
    }
    return json.data;
  },

  /**
   * Fetches cache heatmap data (stage x day).
   */
  async getCacheHeatmap(period: '24h' | '7d' | '30d'): Promise<CacheHeatmapData> {
    const res = await authedFetch(`${API_BASE}/api/brain/costs/cache-heatmap?period=${period}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch cache heatmap: ${res.statusText}`);
    }
    const json: ApiResponse<CacheHeatmapData> = await res.json();
    if (!json.success) {
      throw new Error(json.error || 'Failed to load cache heatmap');
    }
    return json.data;
  },

  /**
   * Fetches cost breakdown by stage.
   */
  async getCostByStage(period: '24h' | '7d' | '30d'): Promise<CostByStageData> {
    const res = await authedFetch(`${API_BASE}/api/brain/costs/by-stage?period=${period}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch cost by stage: ${res.statusText}`);
    }
    const json: ApiResponse<CostByStageData> = await res.json();
    if (!json.success) {
      throw new Error(json.error || 'Failed to load cost by stage');
    }
    return json.data;
  },

  /**
   * Fetches cost flow data for Sankey diagram.
   */
  async getCostFlow(period: '24h' | '7d' | '30d'): Promise<CostFlowData> {
    const res = await authedFetch(`${API_BASE}/api/brain/costs/flow?period=${period}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch cost flow: ${res.statusText}`);
    }
    const json: ApiResponse<CostFlowData> = await res.json();
    if (!json.success) {
      throw new Error(json.error || 'Failed to load cost flow');
    }
    return json.data;
  },

  /**
   * Fetches pipeline trace for a specific turn.
   */
  async getTurnTrace(turnId: string): Promise<TurnTrace> {
    const res = await authedFetch(`${API_BASE}/api/brain/turn/${turnId}/trace`);
    if (!res.ok) {
      throw new Error(`Failed to fetch turn trace: ${res.statusText}`);
    }
    const json: ApiResponse<TurnTrace> = await res.json();
    if (!json.success) {
      throw new Error(json.error || 'Failed to load turn trace');
    }
    return json.data;
  },

  /**
   * Fetches prompt detail for a specific activity.
   */
  async getPromptDetail(activityId: string): Promise<PromptDetail> {
    const res = await authedFetch(`${API_BASE}/api/brain/activity/${activityId}/prompt`);
    if (!res.ok) {
      throw new Error(`Failed to fetch prompt detail: ${res.statusText}`);
    }
    const json: ApiResponse<PromptDetail> = await res.json();
    if (!json.success) {
      throw new Error(json.error || 'Failed to load prompt detail');
    }
    return json.data;
  },
};

export type { ApiResponse, SessionsResponse, ActivityResponse };
