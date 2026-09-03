import type {
  CreateProductInput,
  DayProfile,
  DayTimeline,
  Product,
  ScheduledIntake,
  SearchResult,
  StartTreatmentInput,
  Treatment,
  TreatmentHistory,
  UpdateDayProfileInput,
  UpdateProductInput,
} from '@pillstack/contracts';

/**
 * Talks to the local PillStack server on the same origin. There is no other
 * origin: nothing here reaches the network beyond this machine.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      details?: unknown;
    };
    throw new ApiError(response.status, body.error ?? response.statusText, body.details);
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  products: {
    list: (query: { category?: string; active?: boolean; query?: string } = {}) => {
      const params = new URLSearchParams();
      if (query.category) params.set('category', query.category);
      if (query.active !== undefined) params.set('active', String(query.active));
      if (query.query) params.set('query', query.query);
      const suffix = params.toString();
      return request<Product[]>(`/api/products${suffix ? `?${suffix}` : ''}`);
    },
    get: (id: string) => request<Product>(`/api/products/${id}`),
    create: (input: CreateProductInput) => post<Product>('/api/products', input),
    update: (id: string, input: UpdateProductInput) =>
      request<Product>(`/api/products/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    archive: (id: string) => post<Product>(`/api/products/${id}/archive`),
    treatments: (id: string) => request<Treatment[]>(`/api/products/${id}/treatments`),
  },

  treatments: {
    start: (input: StartTreatmentInput) => post<Treatment>('/api/treatments', input),
    history: (id: string) => request<TreatmentHistory>(`/api/treatments/${id}/history`),
    changePlan: (id: string, input: unknown) => post<Treatment>(`/api/treatments/${id}/plan`, input),
    pause: (id: string, input: unknown) => post<Treatment>(`/api/treatments/${id}/pause`, input),
    resume: (id: string, input: unknown) => post<Treatment>(`/api/treatments/${id}/resume`, input),
    stop: (id: string, input: unknown) => post<Treatment>(`/api/treatments/${id}/stop`, input),
  },

  schedule: {
    day: (date?: string) =>
      request<DayTimeline>(`/api/schedule/day${date ? `?date=${date}` : ''}`),
    next: () => request<{ intake: ScheduledIntake | null }>('/api/schedule/next'),
    today: () => request<{ date: string }>('/api/schedule/today'),
    move: (input: { planDoseId: string; occurrenceDate: string; time: string; reason?: string }) =>
      post<DayTimeline>('/api/schedule/move', input),
    clearOverride: (input: { planDoseId: string; occurrenceDate: string }) =>
      post<DayTimeline>('/api/schedule/clear-override', input),
  },

  settings: {
    dayProfile: () => request<DayProfile>('/api/settings/day-profile'),
    updateDayProfile: (input: UpdateDayProfileInput) =>
      request<DayProfile>('/api/settings/day-profile', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    timeZone: () => request<{ timeZone: string }>('/api/settings/timezone'),
    setTimeZone: (timeZone: string) =>
      request<{ timeZone: string }>('/api/settings/timezone', {
        method: 'PUT',
        body: JSON.stringify({ timeZone }),
      }),
  },

  search: (q: string) => request<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`),
};
