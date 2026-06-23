async function portalFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export type PortalMe = {
  id: string;
  name: string;
  email: string | null;
  role: string;
  firmId: string;
  firmName: string | null;
  enrolled: boolean;
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

export type TeamUsage = {
  year: number;
  month: number;
  totalCalls: number;
  totalErrors: number;
  activeUsers: number;
  users: UserUsage[];
};

export const portalApi = {
  me: () => portalFetch<PortalMe>("/portal/me"),
  teamUsage: (year: number, month: number) =>
    portalFetch<TeamUsage>(`/portal/team-usage?year=${year}&month=${month}`),
};
