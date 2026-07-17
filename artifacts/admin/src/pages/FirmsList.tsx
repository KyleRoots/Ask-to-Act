import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { api, clearToken, type FirmRow } from "@/lib/api";
import { LogoWordmark } from "@/components/Logo";
import { useToast } from "@/hooks/use-toast";

const BG = "hsl(220 50% 4%)";
const SURFACE = "hsl(222 45% 8%)";
const BORDER = "hsl(217 35% 18%)";

function FirmAvatar({ name, logoUrl, size = "md" }: { name: string; logoUrl: string | null; size?: "sm" | "md" }) {
  const dim = size === "sm" ? "w-8 h-8 rounded-lg text-xs" : "w-9 h-9 rounded-xl text-sm";
  if (logoUrl) {
    return (
      <div
        className={`${dim} flex items-center justify-center overflow-hidden shrink-0`}
        style={{ background: "hsl(217 35% 12%)", border: "1px solid hsl(217 35% 18%)" }}
      >
        <img src={logoUrl} alt={`${name} logo`} className="w-full h-full object-contain p-0.5" />
      </div>
    );
  }
  return (
    <div
      className={`${dim} flex items-center justify-center font-bold text-white shrink-0`}
      style={{ background: "linear-gradient(135deg, #4F46E5, #0EA5E9)" }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

const GHOST_HOVER = {
  enter: (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.color = "#E2E8F0";
    e.currentTarget.style.borderColor = "rgba(255,255,255,.15)";
  },
  leave: (e: React.MouseEvent<HTMLButtonElement>, color = "#6B7A99") => {
    e.currentTarget.style.color = color;
    e.currentTarget.style.borderColor = BORDER;
  },
};

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, React.CSSProperties> = {
    active: { background: "rgba(16,185,129,.12)", color: "#34D399", border: "1px solid rgba(52,211,153,.25)" },
    trialing: { background: "rgba(79,70,229,.12)", color: "#818CF8", border: "1px solid rgba(129,140,248,.25)" },
    past_due: { background: "rgba(245,158,11,.12)", color: "#FCD34D", border: "1px solid rgba(252,211,77,.25)" },
    canceled: { background: "rgba(239,68,68,.12)", color: "#FCA5A5", border: "1px solid rgba(252,165,165,.25)" },
    suspended: { background: "rgba(245,158,11,.12)", color: "#FCD34D", border: "1px solid rgba(252,211,77,.25)" },
    archived: { background: "rgba(148,163,184,.08)", color: "#94A3B8", border: "1px solid rgba(148,163,184,.25)" },
    none: { background: "rgba(148,163,184,.08)", color: "#6B7A99", border: "1px solid rgba(107,122,153,.2)" },
  };
  const s = styles[status] ?? styles.none;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium" style={s}>
      {status === "active" && (
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "#34D399" }} />
      )}
      {status}
    </span>
  );
}

type BullhornListState = "connected" | "not_connected" | "reconnect_required" | "unhealthy";

function bullhornState(firm: FirmRow): BullhornListState {
  const bh = firm.bullhorn;
  if (!bh?.connected) return "not_connected";
  if (bh.needsReauthorization) return "reconnect_required";
  if (!bh.healthy) return "unhealthy";
  return "connected";
}

function firmNeedsAttention(firm: FirmRow): boolean {
  const state = bullhornState(firm);
  return state === "not_connected" || state === "reconnect_required" || state === "unhealthy";
}

function BullhornBadge({
  firm,
  onReconnect,
}: {
  firm: FirmRow;
  onReconnect: (firmId: string) => void;
}) {
  const state = bullhornState(firm);
  const styles: Record<BullhornListState, React.CSSProperties> = {
    connected: { background: "rgba(16,185,129,.12)", color: "#34D399", border: "1px solid rgba(52,211,153,.25)" },
    not_connected: { background: "rgba(148,163,184,.08)", color: "#94A3B8", border: "1px solid rgba(148,163,184,.25)" },
    reconnect_required: { background: "rgba(245,158,11,.12)", color: "#FCD34D", border: "1px solid rgba(252,211,77,.25)" },
    unhealthy: { background: "rgba(239,68,68,.12)", color: "#FCA5A5", border: "1px solid rgba(252,165,165,.25)" },
  };
  const labels: Record<BullhornListState, string> = {
    connected: "Connected",
    not_connected: "Not connected",
    reconnect_required: "Reconnect required",
    unhealthy: "Unhealthy",
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium" style={styles[state]}>
        {state === "connected" && (
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "#34D399" }} />
        )}
        {labels[state]}
      </span>
      {(state === "reconnect_required" || state === "not_connected" || state === "unhealthy") && (
        <button
          type="button"
          className="text-xs font-semibold underline-offset-2 hover:underline"
          style={{ color: state === "not_connected" ? "#818CF8" : "#FCD34D" }}
          onClick={(e) => {
            e.stopPropagation();
            onReconnect(firm.id);
          }}
        >
          {state === "not_connected" ? "Connect →" : "Reconnect →"}
        </button>
      )}
    </div>
  );
}

function CreateFirmModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (checkoutUrl: string | null, message: string) => void;
}) {
  const [name, setName] = useState("");
  const [seatLimit, setSeatLimit] = useState("");
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: () =>
      api.createFirm({ name, ...(seatLimit ? { seatLimit: Number(seatLimit) } : {}) }),
    onSuccess: (data) => onCreated(data.checkoutUrl, data.message),
    onError: (err: Error) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4"
      style={{ background: "rgba(3,7,18,.8)", backdropFilter: "blur(4px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl border border-b-0 sm:border-b p-6 sm:p-7 shadow-2xl"
        style={{ background: SURFACE, borderColor: BORDER }}
      >
        <div className="flex justify-center mb-5 sm:hidden">
          <div className="w-10 h-1 rounded-full" style={{ background: BORDER }} />
        </div>

        <h2 className="text-lg font-bold text-white mb-6">Create new firm</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "#6B7A99" }}>
              Firm Name *
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Staffing LLC"
              className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-[#3A4460] outline-none"
              style={{ background: "hsl(217 35% 11%)", border: "1.5px solid hsl(217 35% 20%)" }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "#4F46E5"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "hsl(217 35% 20%)"; }}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "#6B7A99" }}>
              Seat Limit{" "}
              <span style={{ color: "#3A4460", textTransform: "none", fontWeight: 400 }}>
                (blank = unlimited)
              </span>
            </label>
            <input
              type="number"
              min="1"
              value={seatLimit}
              onChange={(e) => setSeatLimit(e.target.value)}
              placeholder="e.g. 25"
              className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-[#3A4460] outline-none"
              style={{ background: "hsl(217 35% 11%)", border: "1.5px solid hsl(217 35% 20%)" }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "#4F46E5"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "hsl(217 35% 20%)"; }}
            />
          </div>
        </div>

        <div className="flex gap-3 mt-7">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl py-3 text-sm font-medium transition-colors"
            style={{ background: "hsl(217 35% 15%)", color: "#6B7A99", border: `1px solid ${BORDER}` }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#E2E8F0"; e.currentTarget.style.borderColor = "rgba(255,255,255,.15)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "#6B7A99"; e.currentTarget.style.borderColor = BORDER; }}
          >
            Cancel
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!name.trim() || mutation.isPending}
            className="flex-1 rounded-xl py-3 text-sm font-bold text-white transition-all hover:opacity-90 disabled:opacity-50 active:scale-[0.98]"
            style={{
              background: "linear-gradient(135deg, #4F46E5 0%, #0EA5E9 100%)",
              boxShadow: "0 4px 14px rgba(79,70,229,0.35)",
            }}
          >
            {mutation.isPending ? "Creating…" : "Create Firm"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function FirmsList() {
  const [showCreate, setShowCreate] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [checkoutResult, setCheckoutResult] = useState<{ url: string | null; message: string } | null>(null);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const { data: firms, isLoading, error } = useQuery({
    queryKey: ["firms", { showArchived }],
    queryFn: () => api.listFirms(showArchived),
  });

  function handleCreated(checkoutUrl: string | null, message: string) {
    setShowCreate(false);
    queryClient.invalidateQueries({ queryKey: ["firms"] });
    setCheckoutResult({ url: checkoutUrl, message });
  }

  const totalSeats = firms?.reduce((s, f) => s + f.enrolledSeats, 0) ?? 0;
  const activeFirms = firms?.filter((f) => f.status === "active").length ?? 0;
  const needsAttention = firms?.filter(firmNeedsAttention).length ?? 0;

  function goReconnect(firmId: string) {
    navigate(`/firms/${firmId}/setup?mode=reconnect`);
  }

  return (
    <div className="min-h-screen min-h-dvh" style={{ background: BG }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10 flex items-center justify-between px-4 sm:px-6 py-3.5"
        style={{
          background: "rgba(5,13,26,.9)",
          backdropFilter: "blur(14px)",
          borderBottom: `1px solid ${BORDER}`,
        }}
      >
        <LogoWordmark size={28} />
        <div className="flex items-center gap-3">
          <span className="hidden sm:block text-xs" style={{ color: "#3A4460" }}>
            Super-admin
          </span>
          <div className="hidden sm:block w-px h-4" style={{ background: BORDER }} />
          <button
            onClick={() => { clearToken(); navigate("/login"); }}
            className="text-sm px-3 py-1.5 rounded-lg transition-colors"
            style={{ color: "#6B7A99", border: `1px solid ${BORDER}` }}
            onMouseEnter={GHOST_HOVER.enter}
            onMouseLeave={(e) => GHOST_HOVER.leave(e)}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        {/* Checkout banner */}
        {checkoutResult && (
          <div
            className="mb-6 flex items-start gap-3 rounded-xl px-4 py-4"
            style={{ background: "rgba(16,185,129,.08)", border: "1px solid rgba(52,211,153,.2)" }}
          >
            <span>✓</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm" style={{ color: "#6EE7B7" }}>{checkoutResult.message}</p>
              {checkoutResult.url && (
                <a
                  href={checkoutResult.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 text-xs font-medium underline break-all transition-colors hover:text-[#34D399]"
                  style={{ color: "#34D399" }}
                >
                  Open Stripe Checkout →
                </a>
              )}
            </div>
            <button
              onClick={() => setCheckoutResult(null)}
              className="text-xs shrink-0 transition-colors"
              style={{ color: "#6EE7B7" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#F0FDF4"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "#6EE7B7"; }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-8 sm:mb-10">
          {[
            { label: "Total firms", value: firms?.length ?? "—", accent: false },
            { label: "Active firms", value: activeFirms || "—", accent: false },
            { label: "Enrolled seats", value: totalSeats || "—", accent: false },
            {
              label: "Needs attention",
              value: firms ? needsAttention : "—",
              accent: needsAttention > 0,
            },
          ].map(({ label, value, accent }) => (
            <div
              key={label}
              className="rounded-xl p-4 sm:p-5 flex sm:block items-center gap-4"
              style={{
                background: SURFACE,
                border: accent
                  ? "1px solid rgba(252,211,77,.35)"
                  : `1px solid ${BORDER}`,
              }}
            >
              <p className="text-xs font-semibold uppercase tracking-wider sm:mb-2" style={{ color: accent ? "#FCD34D" : "#3A4460" }}>
                {label}
              </p>
              <p
                className="text-2xl sm:text-3xl font-extrabold tracking-tight ml-auto sm:ml-0"
                style={
                  accent
                    ? { color: "#FCD34D" }
                    : {
                        background: "linear-gradient(135deg, #818CF8 0%, #38BDF8 100%)",
                        WebkitBackgroundClip: "text",
                        WebkitTextFillColor: "transparent",
                        backgroundClip: "text",
                      }
                }
              >
                {value}
              </p>
            </div>
          ))}
        </div>

        {needsAttention > 0 && (
          <div
            className="mb-6 rounded-xl px-4 py-3 text-sm"
            style={{ background: "rgba(245,158,11,.08)", border: "1px solid rgba(252,211,77,.25)", color: "#FDE68A" }}
          >
            {needsAttention === 1
              ? "1 firm needs a Bullhorn connect or reconnect — recruiters there may see auth errors until it’s fixed."
              : `${needsAttention} firms need a Bullhorn connect or reconnect — recruiters there may see auth errors until they’re fixed.`}
          </div>
        )}

        {/* Table header */}
        <div className="flex items-center justify-between mb-4 gap-3">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Firms</h1>
            <p className="text-xs mt-0.5" style={{ color: "#3A4460" }}>
              {firms ? `${firms.length} registered` : "Loading…"}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="text-sm px-3 py-2.5 rounded-xl transition-colors"
              style={
                showArchived
                  ? { color: "#E2E8F0", border: "1px solid rgba(255,255,255,.15)" }
                  : { color: "#6B7A99", border: `1px solid ${BORDER}` }
              }
              onMouseEnter={GHOST_HOVER.enter}
              onMouseLeave={(e) => GHOST_HOVER.leave(e, showArchived ? "#E2E8F0" : "#6B7A99")}
            >
              {showArchived ? "Hide archived" : "Show archived"}
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="text-sm px-3 py-2.5 rounded-xl transition-colors"
              style={{ color: "#6B7A99", border: `1px solid ${BORDER}` }}
              onMouseEnter={GHOST_HOVER.enter}
              onMouseLeave={(e) => GHOST_HOVER.leave(e)}
            >
              Quick add
            </button>
            <button
              onClick={() => navigate("/firms/new")}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold text-white transition-all hover:opacity-90 active:scale-[0.97]"
              style={{
                background: "linear-gradient(135deg, #4F46E5 0%, #0EA5E9 100%)",
                boxShadow: "0 4px 14px rgba(79,70,229,0.35)",
              }}
            >
              <span className="hidden sm:inline">+ New Organization</span>
              <span className="sm:hidden">+ New</span>
            </button>
          </div>
        </div>

        {isLoading && <p className="text-sm py-4" style={{ color: "#3A4460" }}>Loading…</p>}
        {error && (
          <p className="text-sm py-4" style={{ color: "#FCA5A5" }}>
            Error: {(error as Error).message}
          </p>
        )}

        {firms && (
          <>
            {/* Mobile: card list */}
            <div className="sm:hidden space-y-3">
              {firms.map((firm: FirmRow) => (
                <button
                  key={firm.id}
                  className="w-full text-left rounded-2xl p-4 transition-all"
                  style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
                  onClick={() => navigate(`/firms/${firm.id}`)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "hsl(222 45% 11%)";
                    e.currentTarget.style.borderColor = "rgba(79,70,229,.4)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = SURFACE;
                    e.currentTarget.style.borderColor = BORDER;
                  }}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <FirmAvatar name={firm.name} logoUrl={firm.logoUrl} size="md" />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-white truncate">{firm.name}</p>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <StatusBadge status={firm.subscriptionStatus} />
                        {firm.status !== "active" && <StatusBadge status={firm.status} />}
                      </div>
                    </div>
                    <span className="text-xs" style={{ color: "#3A4460" }}>→</span>
                  </div>
                  <div className="mb-3" onClick={(e) => e.stopPropagation()}>
                    <BullhornBadge firm={firm} onReconnect={goReconnect} />
                  </div>
                  <div className="flex gap-4 text-xs" style={{ color: "#6B7A99" }}>
                    <span>
                      <span className="font-semibold text-white">{firm.enrolledSeats}</span> seats
                    </span>
                    <span>
                      Limit: <span className="font-semibold text-white">{firm.seatLimit ?? "∞"}</span>
                    </span>
                  </div>
                </button>
              ))}
              {firms.length === 0 && (
                <div
                  className="rounded-2xl p-10 text-center text-sm"
                  style={{ background: SURFACE, border: `1px solid ${BORDER}`, color: "#3A4460" }}
                >
                  No firms yet — create your first one.
                </div>
              )}
            </div>

            {/* Desktop: table */}
            <div className="hidden sm:block rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${BORDER}`, background: "rgba(255,255,255,.015)" }}>
                      {["Firm", "Status", "Bullhorn", "Seats", "Limit"].map((h) => (
                        <th
                          key={h}
                          className="text-left px-5 py-3.5 text-xs font-semibold uppercase tracking-wider"
                          style={{ color: "#3A4460" }}
                        >
                          {h}
                        </th>
                      ))}
                      <th className="px-5 py-3.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {firms.map((firm: FirmRow, i: number) => (
                      <tr
                        key={firm.id}
                        className="cursor-pointer transition-colors"
                        style={{
                          background: SURFACE,
                          borderBottom: i < firms.length - 1 ? `1px solid ${BORDER}` : "none",
                        }}
                        onClick={() => navigate(`/firms/${firm.id}`)}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "hsl(222 45% 11%)"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = SURFACE; }}
                      >
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <FirmAvatar name={firm.name} logoUrl={firm.logoUrl} size="sm" />
                            <span className="font-medium text-white">{firm.name}</span>
                          </div>
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <StatusBadge status={firm.subscriptionStatus} />
                            {firm.status !== "active" && <StatusBadge status={firm.status} />}
                          </div>
                        </td>
                        <td className="px-5 py-4" onClick={(e) => e.stopPropagation()}>
                          <BullhornBadge firm={firm} onReconnect={goReconnect} />
                        </td>
                        <td className="px-5 py-4 text-white font-mono">{firm.enrolledSeats}</td>
                        <td className="px-5 py-4 font-mono" style={{ color: "#6B7A99" }}>
                          {firm.seatLimit ?? "∞"}
                        </td>
                        <td className="px-5 py-4 text-right text-xs" style={{ color: "#3A4460" }}>
                          View →
                        </td>
                      </tr>
                    ))}
                    {firms.length === 0 && (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-5 py-14 text-center text-sm"
                          style={{ color: "#3A4460", background: SURFACE }}
                        >
                          No firms yet — create your first one.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>

      <footer
        className="max-w-5xl mx-auto px-4 sm:px-6 py-6 border-t flex flex-col sm:flex-row items-center justify-between gap-3"
        style={{ borderColor: BORDER }}
      >
        <span className="text-xs" style={{ color: "#3A4460" }}>
          © {new Date().getFullYear()} AskToAct · All rights reserved
        </span>
        <span className="flex items-center gap-4 text-xs" style={{ color: "#3A4460" }}>
          <a href="/privacy" target="_blank" rel="noopener noreferrer" className="hover:text-[#818CF8] transition-colors">Privacy</a>
          <a href="/terms" target="_blank" rel="noopener noreferrer" className="hover:text-[#818CF8] transition-colors">Terms</a>
        </span>
      </footer>

      {showCreate && (
        <CreateFirmModal onClose={() => setShowCreate(false)} onCreated={handleCreated} />
      )}
    </div>
  );
}
