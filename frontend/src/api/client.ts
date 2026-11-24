import type {
  Task,
  TaskState,
  ExecutionSummary,
  HealthResponse,
  PaginatedList,
} from './types';

const API_BASE = (import.meta as any).env?.VITE_API_URL || '/api';

interface RequestConfig extends RequestInit {
  params?: Record<string, unknown>;
}

async function buildUrl(url: string, params?: Record<string, unknown>): Promise<string> {
  if (!params) return url;
  
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      searchParams.append(key, String(value));
    }
  });
  
  return `${url}${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
}

async function request<T>(
  endpoint: string,
  config: RequestConfig = {},
): Promise<T> {
  const url = await buildUrl(API_BASE + endpoint, config.params as Record<string, unknown>);
  
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...config.headers,
    },
    ...config,
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new ApiError(errorData);
  }
  
  return response.json();
}

export class ApiError extends Error {
  statusCode?: number;
  
  constructor(data: { message: string; statusCode?: number }) {
    super(data.message);
    this.name = 'ApiError';
    this.statusCode = data.statusCode;
  }
}

export const api = {
  health: {
    get: () => request<HealthResponse>('/health'),
  },
  
  tasks: {
    list: (params?: any) => 
      request<PaginatedList<Task>>('/tasks', { params }),
    
    get: (id: string) => request<Task>(`/tasks/${encodeURIComponent(id)}`),
    
    create: (data: { title: string; description?: string; priority?: number; state?: TaskState }) =>
      request<Task>('/tasks', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    
    update: (id: string, data: Partial<Task>) =>
      request<Task>(`/tasks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    
    delete: (id: string) =>
      request<void>(`/tasks/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
  },
  
  executions: {
    list: () => request<ExecutionSummary[]>('/executions'),
    get: (id: string) => request<ExecutionSummary>(`/executions/${encodeURIComponent(id)}`),
  },
};
