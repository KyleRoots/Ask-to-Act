import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { api, clearToken, type UserRow, type UsageMonth } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

const MONTH_NAMES = [
  "", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    trialing: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    past_due: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    canceled: "bg-red-500/15 text-red-400 border-red-500/30",
    none: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${map[status] ?? map.none}`}
    >
      {status}
    </span>
  );
}

function UsageChart({ data }: { data: UsageMonth[] }) {
  if (!data.length) {
    return (
      <p className="text-slate-500 text-sm text-center py-8">
        No usage data yet — seats are tracked on first AI call per month.
      </p>
    );
  }
  const max = Math.max(...data.map((d) => d.activeSeats), 1);
  return (
    <div className="space-y-3">
      {data.map((d) => (
        <div key={`${d.year}-${d.month}`} className="flex items-center gap-3">
          <span className="text-slate-400 text-xs w-12 text-right shrink-0">
            {MONTH_NAMES[d.month]} {d.year}
          </span>
          <div className="flex-1 bg-slate-800 rounded-full h-2">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all"
              style={{ width: `${(d.activeSeats / max) * 100}%` }}
            />
          </div>
          <span className="text-slate-300 text-xs w-28 shrink-0">
            {d.activeSeats} seat{d.activeSeats !== 1 ? "s" : ""} · {d.totalCalls.toLocaleString()} calls
          </span>
        </div>
      ))}
    </div>
  );
}

export default function FirmDetail({ firmId }: { firmId: string }) {
  const [tab, setTab] = useState<"overview" | "users" | "usage">("overview");
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: firm, isLoading: firmLoading } = useQuery({
    queryKey: ["firm", firmId],
    queryFn: () => api.getFirm(firmId),
  });

  const { data: users, isLoading: usersLoading } = useQuery({
    queryKey: ["firm-users", firmId],
    queryFn: () => api.listUsers(firmId),
    enabled: tab === "users",
  });

  const { data: usage, isLoading: usageLoading } = useQuery({
    queryKey: ["firm-usage", firmId],
    queryFn: () => api.getUsage(firmId),
    enabled: tab === "usage",
  });

  async function openBillingPortal() {
    try {
      const { url } = await api.billingPortal(firmId);
      window.open(url, "_blank");
    } catch (err) {
      toast({
        title: "Billing portal unavailable",
        description: (err as Error).message,
        variant: "destructive",
      });
    }
  }

  function handleSignOut() {
    clearToken();
    navigate("/login");
  }

  return (
    <div className="min-h-screen bg-slate-950">
      {/* Header */}
      <header className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/firms")}
            className="text-slate-400 hover:text-white text-sm transition-colors"
          >
            ← Firms
          </button>
          <div className="w-px h-4 bg-slate-700" />
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-blue-500 flex items-center justify-center">
              <span className="text-white font-bold text-xs">A</span>
            </div>
            <span className="text-white font-semibold">
              {firm?.name ?? "Loading…"}
            </span>
          </div>
        </div>
        <button
          onClick={handleSignOut}
          className="text-slate-400 hover:text-white text-sm transition-colors"
        >
          Sign out
        </button>
      </header>

      {firmLoading && (
        <div className="flex items-center justify-center h-64 text-slate-400">Loading…</div>
      )}

      {firm && (
        <main className="max-w-4xl mx-auto px-6 py-8">
          {/* Stats row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
            {[
              { label: "Status", value: <StatusBadge status={firm.subscriptionStatus} /> },
              { label: "Enrolled seats", value: firm.enrolledSeats },
              { label: "Seat limit", value: firm.seatLimit ?? "∞" },
              {
                label: "Remaining",
                value:
                  firm.seatsRemaining === "unlimited"
                    ? "∞"
                    : String(firm.seatsRemaining),
              },
            ].map(({ label, value }) => (
              <div
                key={label}
                className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-4"
              >
                <p className="text-slate-400 text-xs mb-1">{label}</p>
                <div className="text-white font-semibold text-lg">{value}</div>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mb-6 border-b border-slate-800 pb-0">
            {(["overview", "users", "usage"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2.5 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                  tab === t
                    ? "border-blue-500 text-white"
                    : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Overview tab */}
          {tab === "overview" && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[
                  { label: "Firm ID", value: firm.id },
                  {
                    label: "Created",
                    value: new Date(firm.createdAt).toLocaleDateString(),
                  },
                  { label: "Stripe Customer", value: firm.stripeCustomerId ?? "—" },
                  {
                    label: "Stripe Subscription",
                    value: firm.stripeSubscriptionId ?? "—",
                  },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <dt className="text-xs text-slate-400 mb-0.5">{label}</dt>
                    <dd className="text-sm text-slate-200 font-mono break-all">{value}</dd>
                  </div>
                ))}
              </dl>

              {firm.stripeCustomerId && (
                <div className="pt-4 border-t border-slate-800">
                  <button
                    onClick={openBillingPortal}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                  >
                    Open Stripe Billing Portal →
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Users tab */}
          {tab === "users" && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              {usersLoading && (
                <p className="text-slate-400 text-sm p-6">Loading…</p>
              )}
              {users && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800">
                      <th className="text-left text-slate-400 font-medium px-4 py-3">Name</th>
                      <th className="text-left text-slate-400 font-medium px-4 py-3">Email</th>
                      <th className="text-left text-slate-400 font-medium px-4 py-3">Role</th>
                      <th className="text-left text-slate-400 font-medium px-4 py-3">Enrolled</th>
                      <th className="text-left text-slate-400 font-medium px-4 py-3">Joined</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u: UserRow, i: number) => (
                      <tr
                        key={u.id}
                        className={`${i < users.length - 1 ? "border-b border-slate-800" : ""}`}
                      >
                        <td className="px-4 py-3 text-white">{u.name ?? "—"}</td>
                        <td className="px-4 py-3 text-slate-300">{u.email ?? "—"}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-medium ${
                              u.role === "admin"
                                ? "bg-purple-500/15 text-purple-400"
                                : "bg-slate-700 text-slate-300"
                            }`}
                          >
                            {u.role}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`px-2 py-0.5 rounded text-xs ${
                              u.enrolled
                                ? "bg-emerald-500/15 text-emerald-400"
                                : "bg-slate-700 text-slate-400"
                            }`}
                          >
                            {u.enrolled ? "Yes" : "No"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-400 text-xs">
                          {new Date(u.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                    {users.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                          No users enrolled yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Usage tab */}
          {tab === "usage" && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
              <h3 className="text-white font-medium mb-1">Active seats by month</h3>
              <p className="text-slate-400 text-xs mb-6">
                A seat is counted once per month when a recruiter makes their first AI call.
              </p>
              {usageLoading && <p className="text-slate-400 text-sm">Loading…</p>}
              {usage && <UsageChart data={usage} />}
            </div>
          )}
        </main>
      )}
    </div>
  );
}
