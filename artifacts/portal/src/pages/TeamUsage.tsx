import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { portalApi, type TeamUsage as TeamUsageData } from "@/lib/api";

const BG = "hsl(220 50% 4%)";
const SURFACE = "hsl(222 45% 8%)";
const BORDER = "hsl(217 35% 18%)";
const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function monthOptions(): { year: number; month: number; label: string }[] {
  const out: { year: number; month: number; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ year: d.getFullYear(), month: d.getMonth() + 1, label: `${MONTH_NAMES[d.getMonth() + 1]} ${d.getFullYear()}` });
  }
  return out;
}

function UsageRow({ u }: { u: TeamUsageData["users"][number] }) {
  const [open, setOpen] = useState(false);
  const hasTools = u.tools.length > 0;
  return (
    <div className="rounded-xl" style={{ background: "hsl(217 35% 11%)", border: `1px solid ${BORDER}` }}>
      <button
        onClick={() => hasTools && setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
        style={{ cursor: hasTools ? "pointer" : "default" }}
      >
        <span className="shrink-0 w-5 text-center text-xs" style={{ color: "#3A4460" }}>
          {hasTools ? (open ? "▾" : "▸") : ""}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white truncate">{u.name}</p>
          <p className="text-xs truncate" style={{ color: "#3A4460" }}>{u.email ?? "—"}</p>
        </div>
        <div className="shrink-0 flex items-center gap-4 text-xs">
          <span className="font-semibold text-white w-20 text-right">{u.totalCalls.toLocaleString()} calls</span>
          <span className="hidden sm:inline w-20 text-right" style={{ color: u.totalErrors > 0 ? "#FCA5A5" : "#3A4460" }}>
            {u.totalErrors} err
          </span>
          <span className="hidden md:inline w-20 text-right" style={{ color: "#6B7A99" }}>{relTime(u.lastCallAt)}</span>
        </div>
      </button>
      {open && hasTools && (
        <div className="px-4 pb-3 pt-1 space-y-1.5" style={{ borderTop: `1px solid ${BORDER}` }}>
          {u.tools.map((t) => (
            <div key={t.toolName} className="flex items-center gap-3 text-xs pt-1.5">
              <span className="font-mono flex-1 truncate" style={{ color: "#9FB0CC" }}>{t.toolName}</span>
              <span className="w-16 text-right font-semibold text-white">{t.callCount.toLocaleString()}</span>
              <span className="w-14 text-right" style={{ color: t.errorCount > 0 ? "#FCA5A5" : "#3A4460" }}>{t.errorCount} err</span>
              <span className="hidden sm:inline w-20 text-right" style={{ color: "#6B7A99" }}>{relTime(t.lastCallAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TeamUsage() {
  const [, navigate] = useLocation();
  const nowDate = new Date();
  const [period, setPeriod] = useState({ year: nowDate.getFullYear(), month: nowDate.getMonth() + 1 });

  const { data: me, isLoading: meLoading } = useQuery({ queryKey: ["portal-me"], queryFn: portalApi.me });

  const isAdmin = me?.role === "admin";

  const { data, isLoading, error } = useQuery({
    queryKey: ["portal-team-usage", period.year, period.month],
    queryFn: () => portalApi.teamUsage(period.year, period.month),
    enabled: isAdmin,
  });

  const opts = monthOptions();
  const sorted = data ? [...data.users].sort((a, b) => b.totalCalls - a.totalCalls) : [];

  return (
    <div className="min-h-[100dvh]" style={{ background: BG }}>
      <header
        className="sticky top-0 z-10 flex items-center justify-between px-5 sm:px-8 py-4"
        style={{ background: "rgba(5,13,26,.9)", backdropFilter: "blur(14px)", borderBottom: `1px solid ${BORDER}` }}
      >
        <button onClick={() => navigate("/dashboard")} className="text-sm flex items-center gap-2" style={{ color: "#6B7A99" }}>
          <span>←</span> Back to dashboard
        </button>
      </header>

      <main className="max-w-4xl mx-auto px-5 sm:px-8 py-10">
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mb-2" style={{ letterSpacing: "-0.03em" }}>
            Team Usage & Activity
          </h1>
          <p className="text-sm" style={{ color: "#4A5568" }}>
            See how {me?.firmName ?? "your team"} uses AI tools each month.
          </p>
        </div>

        {meLoading && (
          <div className="rounded-2xl p-6 text-center" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
            <p className="text-sm" style={{ color: "#3A4460" }}>Loading…</p>
          </div>
        )}

        {!meLoading && !isAdmin && (
          <div className="rounded-2xl p-8 text-center" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
            <p className="text-base font-semibold text-white mb-2">Access denied</p>
            <p className="text-sm" style={{ color: "#6B7A99" }}>You need company admin access to view team usage.</p>
            <button
              onClick={() => navigate("/dashboard")}
              className="mt-5 text-xs px-4 py-2 rounded-lg"
              style={{ background: "rgba(99,102,241,.15)", color: "#A5B4FC", border: "1px solid rgba(165,180,252,.2)" }}
            >
              Back to dashboard
            </button>
          </div>
        )}

        {!meLoading && isAdmin && (
          <div className="rounded-2xl p-5 sm:p-7" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
            <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
              <div>
                <h3 className="text-base font-semibold text-white">Per-user activity</h3>
                <p className="text-xs mt-1" style={{ color: "#3A4460" }}>
                  Tool calls by team member — expand a row for the per-tool breakdown
                </p>
              </div>
              <select
                value={`${period.year}-${period.month}`}
                onChange={(e) => {
                  const [y, m] = e.target.value.split("-").map(Number);
                  setPeriod({ year: y, month: m });
                }}
                className="text-xs rounded-lg px-3 py-2 shrink-0"
                style={{ background: "hsl(217 35% 11%)", border: `1px solid ${BORDER}`, color: "#E2E8F0" }}
              >
                {opts.map((o) => (
                  <option key={`${o.year}-${o.month}`} value={`${o.year}-${o.month}`}>{o.label}</option>
                ))}
              </select>
            </div>

            {isLoading && <p className="text-sm" style={{ color: "#3A4460" }}>Loading…</p>}
            {error && <p className="text-sm" style={{ color: "#FCA5A5" }}>Could not load usage data.</p>}
            {!isLoading && data && (
              <>
                <div className="flex gap-6 mb-5 flex-wrap">
                  <div>
                    <p className="text-xs" style={{ color: "#3A4460" }}>Total calls</p>
                    <p className="text-lg font-bold text-white">{data.totalCalls.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-xs" style={{ color: "#3A4460" }}>Errors</p>
                    <p className="text-lg font-bold" style={{ color: data.totalErrors > 0 ? "#FCA5A5" : "#fff" }}>{data.totalErrors.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-xs" style={{ color: "#3A4460" }}>Active users</p>
                    <p className="text-lg font-bold text-white">{data.activeUsers}</p>
                  </div>
                </div>
                {data.totalCalls === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 gap-3">
                    <div className="w-11 h-11 rounded-2xl flex items-center justify-center text-xl" style={{ background: "rgba(79,70,229,.1)" }}>📋</div>
                    <p className="text-sm text-center" style={{ color: "#3A4460" }}>No tool activity this month.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {sorted.map((u) => <UsageRow key={u.userId} u={u} />)}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
