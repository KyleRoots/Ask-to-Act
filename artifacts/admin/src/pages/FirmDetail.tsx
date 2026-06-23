import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { api, clearToken, type UserRow, type UsageMonth } from "@/lib/api";
import { LogoWordmark } from "@/components/Logo";
import { useToast } from "@/hooks/use-toast";

const BG = "hsl(220 50% 4%)";
const SURFACE = "hsl(222 45% 8%)";
const BORDER = "hsl(217 35% 18%)";

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, React.CSSProperties> = {
    active: { background: "rgba(16,185,129,.12)", color: "#34D399", border: "1px solid rgba(52,211,153,.25)" },
    trialing: { background: "rgba(79,70,229,.12)", color: "#818CF8", border: "1px solid rgba(129,140,248,.25)" },
    past_due: { background: "rgba(245,158,11,.12)", color: "#FCD34D", border: "1px solid rgba(252,211,77,.25)" },
    canceled: { background: "rgba(239,68,68,.12)", color: "#FCA5A5", border: "1px solid rgba(252,165,165,.25)" },
    none: { background: "rgba(148,163,184,.08)", color: "#94A3B8", border: "1px solid rgba(148,163,184,.2)" },
  };
  const s = styles[status] ?? styles.none;
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium" style={s}>
      {status === "active" && <span className="mr-1.5 w-1.5 h-1.5 rounded-full inline-block" style={{ background: "#34D399" }} />}
      {status}
    </span>
  );
}

function UsageChart({ data }: { data: UsageMonth[] }) {
  if (!data.length) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: "rgba(79,70,229,.1)" }}>
          <span className="text-2xl">📊</span>
        </div>
        <p className="text-sm text-center" style={{ color: "#4A5568" }}>
          No usage yet — data appears on first AI call per month.
        </p>
      </div>
    );
  }
  const max = Math.max(...data.map((d) => d.activeSeats), 1);

  return (
    <div className="space-y-4">
      {data.map((d) => (
        <div key={`${d.year}-${d.month}`} className="flex items-center gap-4">
          <span className="text-xs font-mono w-14 text-right shrink-0" style={{ color: "#8C9AB3" }}>
            {MONTH_NAMES[d.month]}
          </span>
          <div className="flex-1 rounded-full h-2" style={{ background: "hsl(217 35% 15%)" }}>
            <div
              className="h-2 rounded-full transition-all"
              style={{
                width: `${(d.activeSeats / max) * 100}%`,
                background: "linear-gradient(90deg, #4F46E5 0%, #06B6D4 100%)",
              }}
            />
          </div>
          <div className="flex items-center gap-3 shrink-0 w-44 text-right">
            <span className="text-xs font-semibold text-white w-20 text-right">
              {d.activeSeats} seat{d.activeSeats !== 1 ? "s" : ""}
            </span>
            <span className="text-xs" style={{ color: "#4A5568" }}>
              {d.totalCalls.toLocaleString()} calls
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function FirmDetail({ firmId }: { firmId: string }) {
  const [tab, setTab] = useState<"overview" | "users" | "usage">("overview");
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: firm, isLoading } = useQuery({
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
      toast({ title: "Billing portal unavailable", description: (err as Error).message, variant: "destructive" });
    }
  }

  return (
    <div className="min-h-screen" style={{ background: BG }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10 flex items-center justify-between px-6 py-4"
        style={{ background: "rgba(5,13,26,.85)", backdropFilter: "blur(12px)", borderBottom: `1px solid ${BORDER}` }}
      >
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate("/firms")}
            className="flex items-center gap-1.5 text-sm transition-colors"
            style={{ color: "#8C9AB3" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#F8FAFC"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "#8C9AB3"; }}
          >
            ← Firms
          </button>
          <div className="w-px h-4" style={{ background: BORDER }} />
          <LogoWordmark size={26} />
        </div>
        <button
          onClick={() => { clearToken(); navigate("/login"); }}
          className="text-sm transition-colors"
          style={{ color: "#8C9AB3" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "#F8FAFC"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "#8C9AB3"; }}
        >
          Sign out
        </button>
      </header>

      {isLoading && (
        <div className="flex items-center justify-center h-64 text-sm" style={{ color: "#4A5568" }}>Loading…</div>
      )}

      {firm && (
        <main className="max-w-4xl mx-auto px-6 py-10">
          {/* Firm heading */}
          <div className="flex items-center gap-4 mb-8">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center text-xl font-bold text-white shrink-0"
              style={{ background: "linear-gradient(135deg, #4F46E5, #06B6D4)" }}
            >
              {firm.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">{firm.name}</h1>
              <div className="flex items-center gap-2 mt-1">
                <StatusBadge status={firm.subscriptionStatus} />
                <span className="text-xs" style={{ color: "#4A5568" }}>
                  Since {new Date(firm.createdAt).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                </span>
              </div>
            </div>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
            {[
              { label: "Enrolled seats", value: String(firm.enrolledSeats) },
              { label: "Seat limit", value: firm.seatLimit != null ? String(firm.seatLimit) : "∞" },
              {
                label: "Remaining",
                value: firm.seatsRemaining === "unlimited" ? "∞" : String(firm.seatsRemaining),
              },
              {
                label: "Subscription",
                value: firm.stripeSubscriptionId ? "Stripe" : "Manual",
              },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-xl p-4" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
                <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: "#4A5568" }}>{label}</p>
                <p className="text-2xl font-bold tracking-tight" style={{
                  background: "linear-gradient(135deg, #818CF8 0%, #22D3EE 100%)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                }}>{value}</p>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div className="flex gap-0 mb-7" style={{ borderBottom: `1px solid ${BORDER}` }}>
            {(["overview", "users", "usage"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className="px-5 py-3 text-sm font-medium capitalize transition-all"
                style={{
                  borderBottom: tab === t ? "2px solid #4F46E5" : "2px solid transparent",
                  color: tab === t ? "#818CF8" : "#4A5568",
                  marginBottom: "-1px",
                }}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Overview */}
          {tab === "overview" && (
            <div className="rounded-2xl p-7" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                {[
                  { label: "Firm ID", value: firm.id },
                  { label: "Created", value: new Date(firm.createdAt).toLocaleString() },
                  { label: "Stripe Customer ID", value: firm.stripeCustomerId ?? "Not connected" },
                  { label: "Stripe Subscription ID", value: firm.stripeSubscriptionId ?? "—" },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <dt className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: "#4A5568" }}>{label}</dt>
                    <dd className="text-sm font-mono break-all" style={{ color: "#94A3B8" }}>{value}</dd>
                  </div>
                ))}
              </dl>

              {firm.stripeCustomerId && (
                <div className="mt-7 pt-6" style={{ borderTop: `1px solid ${BORDER}` }}>
                  <button
                    onClick={openBillingPortal}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
                    style={{ background: "hsl(217 35% 15%)", color: "#94A3B8", border: `1px solid ${BORDER}` }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "#F8FAFC"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "#94A3B8"; }}
                  >
                    <span>↗</span> Open Stripe Billing Portal
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Users */}
          {tab === "users" && (
            <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
              {usersLoading && <p className="p-6 text-sm" style={{ color: "#4A5568" }}>Loading…</p>}
              {users && (
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${BORDER}`, background: "rgba(255,255,255,.02)" }}>
                      {["Name", "Email", "Role", "Enrolled", "Joined"].map((h) => (
                        <th key={h} className="text-left px-5 py-3.5 text-xs font-semibold uppercase tracking-wider" style={{ color: "#4A5568" }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u: UserRow, i: number) => (
                      <tr
                        key={u.id}
                        style={{ background: SURFACE, borderBottom: i < users.length - 1 ? `1px solid ${BORDER}` : "none" }}
                      >
                        <td className="px-5 py-4 font-medium text-white">{u.name ?? "—"}</td>
                        <td className="px-5 py-4" style={{ color: "#8C9AB3" }}>{u.email ?? "—"}</td>
                        <td className="px-5 py-4">
                          <span
                            className="px-2 py-0.5 rounded-md text-xs font-medium"
                            style={u.role === "admin"
                              ? { background: "rgba(139,92,246,.15)", color: "#C4B5FD", border: "1px solid rgba(196,181,253,.2)" }
                              : { background: "rgba(148,163,184,.08)", color: "#94A3B8", border: "1px solid rgba(148,163,184,.15)" }
                            }
                          >
                            {u.role}
                          </span>
                        </td>
                        <td className="px-5 py-4">
                          <span
                            className="px-2 py-0.5 rounded-md text-xs font-medium"
                            style={u.enrolled
                              ? { background: "rgba(16,185,129,.12)", color: "#34D399", border: "1px solid rgba(52,211,153,.2)" }
                              : { background: "rgba(148,163,184,.08)", color: "#4A5568" }
                            }
                          >
                            {u.enrolled ? "Yes" : "No"}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-xs font-mono" style={{ color: "#4A5568" }}>
                          {new Date(u.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                    {users.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-5 py-14 text-center text-sm" style={{ color: "#4A5568", background: SURFACE }}>
                          No users enrolled yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Usage */}
          {tab === "usage" && (
            <div className="rounded-2xl p-7" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
              <div className="flex items-start justify-between mb-6">
                <div>
                  <h3 className="text-base font-semibold text-white">Active seats by month</h3>
                  <p className="text-xs mt-1" style={{ color: "#4A5568" }}>
                    Counted on each user's first AI tool call per calendar month
                  </p>
                </div>
                {usage && usage.length > 0 && (
                  <div className="text-right">
                    <p className="text-xs" style={{ color: "#4A5568" }}>This month</p>
                    <p className="text-xl font-bold" style={{
                      background: "linear-gradient(135deg, #818CF8 0%, #22D3EE 100%)",
                      WebkitBackgroundClip: "text",
                      WebkitTextFillColor: "transparent",
                      backgroundClip: "text",
                    }}>
                      {(() => {
                        const now = new Date();
                        const cur = usage.find((d) => d.year === now.getFullYear() && d.month === now.getMonth() + 1);
                        return cur ? `${cur.activeSeats} seat${cur.activeSeats !== 1 ? "s" : ""}` : "0 seats";
                      })()}
                    </p>
                  </div>
                )}
              </div>
              {usageLoading && <p className="text-sm" style={{ color: "#4A5568" }}>Loading…</p>}
              {usage && <UsageChart data={usage} />}
            </div>
          )}
        </main>
      )}
    </div>
  );
}
