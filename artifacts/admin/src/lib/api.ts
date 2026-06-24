const API_BASE = "/api";

// Admin sessions are bound to an absolute expiry so a token left in a shared or
// unattended browser stops working on its own. On expiry getToken() returns
// null, which the AuthGuard treats as signed-out and redirects to /login.
const TOKEN_KEY = "admin_token";
const TOKEN_EXP_KEY = "admin_token_exp";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export function getToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  const expRaw = localStorage.getItem(TOKEN_EXP_KEY);
  const exp = expRaw ? Number(expRaw) : 0;
  if (!exp || Number.isNaN(exp) || Date.now() > exp) {
    clearToken();
    return null;
  }
  return token;
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(TOKEN_EXP_KEY, String(Date.now() + TOKEN_TTL_MS));
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXP_KEY);
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

export type FirmStatus = "active" | "suspended" | "archived";

export type FirmRow = {
  id: string;
  name: string;
  subscriptionStatus: string;
  status: FirmStatus;
  enrolledSeats: number;
  seatLimit: number | null;
  logoUrl: string | null;
};

export type FirmDetail = {
  id: string;
  name: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string;
  status: FirmStatus;
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

export type ToolBreakdown = {
  toolName: string;
  callCount: number;
  errorCount: number;
  lastCallAt: string | null;
};

export type UserUsage = {
  userId: string;
  name: string;
  email: string | null;
  role: string;
  totalCalls: number;
  totalErrors: number;
  lastCallAt: string | null;
  tools: ToolBreakdown[];
};

export type UsageDetail = {
  year: number;
  month: number;
  totalCalls: number;
  totalErrors: number;
  activeUsers: number;
  users: UserUsage[];
};

export type InviteResult = {
  sent: number;
  skipped: number;
  errors: { email: string; error: string }[];
  message: string;
};

export const api = {
  listFirms: (includeArchived = false) =>
    apiFetch<{ data: FirmRow[] }>(
      `/firms${includeArchived ? "?includeArchived=1" : ""}`,
    ).then((r) => r.data),

  updateFirmStatus: (firmId: string, status: FirmStatus) =>
    apiFetch<{ id: string; status: FirmStatus }>(`/firms/${firmId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

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

  updateUserRole: (userId: string, role: "admin" | "recruiter") =>
    apiFetch<{ id: string; role: string }>(`/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),

  deleteUser: (userId: string) =>
    apiFetch<{ deleted: boolean; id: string }>(`/users/${userId}`, { method: "DELETE" }),

  sendInvites: (firmId: string, resend = false, userIds?: string[]) =>
    apiFetch<InviteResult>(`/firms/${firmId}/invite`, {
      method: "POST",
      body: JSON.stringify(userIds && userIds.length > 0 ? { resend, userIds } : { resend }),
    }),

  sendInviteToUser: (firmId: string, userId: string) =>
    apiFetch<InviteResult>(`/firms/${firmId}/invite/${userId}`, {
      method: "POST",
    }),

  resendAccessLink: (userId: string) =>
    apiFetch<{ id: string; enrollUrl: string }>(`/users/${userId}/invite`, {
      method: "POST",
    }),

  resetUser: (userId: string) =>
    apiFetch<{
      id: string;
      name: string | null;
      email: string | null;
      apiKey: string;
      enrollUrl: string;
      message: string;
    }>(`/users/${userId}/reset`, { method: "POST" }),

  uploadLogo: (firmId: string, logoData: string) =>
    apiFetch<{ ok: boolean; message: string }>(`/firms/${firmId}/logo`, {
      method: "POST",
      body: JSON.stringify({ logoData }),
    }),

  getUsage: (firmId: string) =>
    apiFetch<{ data: UsageMonth[] }>(`/firms/${firmId}/usage`).then((r) => r.data),

  getUsageDetail: (firmId: string, year: number, month: number) =>
    apiFetch<UsageDetail>(`/firms/${firmId}/usage/detail?year=${year}&month=${month}`),

  billingPortal: (firmId: string) =>
    apiFetch<{ url: string }>(`/firms/${firmId}/billing-portal`, {
      method: "POST",
    }),

  generateCheckout: (firmId: string) =>
    apiFetch<{ checkoutUrl: string; message: string }>(`/firms/${firmId}/checkout`, {
      method: "POST",
    }),
};
