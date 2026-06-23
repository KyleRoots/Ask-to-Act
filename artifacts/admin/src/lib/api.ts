const API_BASE = "/api";

export function getToken(): string | null {
  return localStorage.getItem("admin_token");
}

export function setToken(token: string) {
  localStorage.setItem("admin_token", token);
}

export function clearToken() {
  localStorage.removeItem("admin_token");
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers as Record<string, string> | undefined),
    },
  });
  if (res.status === 401) {
    clearToken();
    window.location.href = "/admin/";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export type FirmRow = {
  id: string;
  name: string;
  subscriptionStatus: string;
  enrolledSeats: number;
  seatLimit: number | null;
};

export type FirmDetail = {
  id: string;
  name: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string;
  seatLimit: number | null;
  enrolledSeats: number;
  seatsRemaining: number | "unlimited";
  logoUrl: string | null;
  createdAt: string;
};

export type UserRow = {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
  enrolled: boolean;
  invitedAt: string | null;
  enrollUrl: string;
  createdAt: string;
};

export type UsageMonth = {
  year: number;
  month: number;
  activeSeats: number;
  totalCalls: number;
};

export type InviteResult = {
  sent: number;
  skipped: number;
  errors: { email: string; error: string }[];
  message: string;
};

export const api = {
  listFirms: () =>
    apiFetch<{ data: FirmRow[] }>("/firms").then((r) => r.data),

  createFirm: (body: { name: string; seatLimit?: number }) =>
    apiFetch<{
      id: string;
      name: string;
      checkoutUrl: string | null;
      message: string;
    }>("/firms", { method: "POST", body: JSON.stringify(body) }),

  getFirm: (id: string) => apiFetch<FirmDetail>(`/firms/${id}`),

  activateFirm: (id: string) =>
    apiFetch<{ id: string; name: string; subscriptionStatus: string; message: string }>(
      `/firms/${id}/activate`,
      { method: "POST" },
    ),

  listUsers: (firmId: string) =>
    apiFetch<{ data: UserRow[] }>(`/firms/${firmId}/users`).then((r) => r.data),

  createUser: (body: { name: string; email?: string; firmId: string; role?: string }) =>
    apiFetch<{
      id: string;
      name: string;
      email: string | null;
      apiKey: string;
      firmId: string | null;
      role: string;
      enrollUrl: string;
      message: string;
    }>("/users", { method: "POST", body: JSON.stringify(body) }),

  sendInvites: (firmId: string, resend = false) =>
    apiFetch<InviteResult>(`/firms/${firmId}/invite`, {
      method: "POST",
      body: JSON.stringify({ resend }),
    }),

  uploadLogo: (firmId: string, logoData: string) =>
    apiFetch<{ ok: boolean; message: string }>(`/firms/${firmId}/logo`, {
      method: "POST",
      body: JSON.stringify({ logoData }),
    }),

  getUsage: (firmId: string) =>
    apiFetch<{ data: UsageMonth[] }>(`/firms/${firmId}/usage`).then((r) => r.data),

  billingPortal: (firmId: string) =>
    apiFetch<{ url: string }>(`/firms/${firmId}/billing-portal`, {
      method: "POST",
    }),
};
