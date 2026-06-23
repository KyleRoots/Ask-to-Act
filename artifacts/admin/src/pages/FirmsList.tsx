import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { api, clearToken, type FirmRow } from "@/lib/api";
import { LogoWordmark } from "@/components/Logo";
import { useToast } from "@/hooks/use-toast";

const BG = "hsl(220 50% 4%)";
const SURFACE = "hsl(222 45% 8%)";
const BORDER = "hsl(217 35% 18%)";

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
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium" style={s}>
      {status === "active" && <span className="mr-1.5 w-1.5 h-1.5 rounded-full inline-block" style={{ background: "#34D399" }} />}
      {status}
    </span>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(3,7,18,.75)" }}>
      <div className="w-full max-w-md rounded-2xl border p-7 shadow-2xl" style={{ background: SURFACE, borderColor: BORDER }}>
        <h2 className="text-lg font-semibold text-white mb-6">Create new firm</h2>

        <div className="space-y-5">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "#8C9AB3" }}>
              Firm Name *
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Staffing LLC"
              className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-[#4A5568] outline-none"
              style={{ background: "hsl(217 35% 12%)", border: "1px solid hsl(217 35% 22%)" }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "#4F46E5"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "hsl(217 35% 22%)"; }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "#8C9AB3" }}>
              Seat Limit <span style={{ color: "#4A5568", textTransform: "none", fontWeight: 400 }}>(blank = unlimited)</span>
            </label>
            <input
              type="number"
              min="1"
              value={seatLimit}
              onChange={(e) => setSeatLimit(e.target.value)}
              placeholder="e.g. 25"
              className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-[#4A5568] outline-none"
              style={{ background: "hsl(217 35% 12%)", border: "1px solid hsl(217 35% 22%)" }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "#4F46E5"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "hsl(217 35% 22%)"; }}
            />
          </div>
        </div>

        <div className="flex gap-3 mt-7">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl py-2.5 text-sm font-medium transition-colors"
            style={{ background: "hsl(217 35% 15%)", color: "#94A3B8", border: "1px solid hsl(217 35% 22%)" }}
          >
            Cancel
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!name.trim() || mutation.isPending}
            className="flex-1 rounded-xl py-2.5 text-sm font-semibold text-white transition-all disabled:opacity-50"
            style={{ background: "linear-gradient(135deg, #4F46E5 0%, #3B82F6 100%)", boxShadow: "0 4px 14px rgba(79,70,229,0.35)" }}
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
  const [checkoutResult, setCheckoutResult] = useState<{ url: string | null; message: string } | null>(null);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const { data: firms, isLoading, error } = useQuery({
    queryKey: ["firms"],
    queryFn: api.listFirms,
  });

  function handleCreated(checkoutUrl: string | null, message: string) {
    setShowCreate(false);
    queryClient.invalidateQueries({ queryKey: ["firms"] });
    setCheckoutResult({ url: checkoutUrl, message });
  }

  const totalSeats = firms?.reduce((s, f) => s + f.enrolledSeats, 0) ?? 0;
  const activeFirms = firms?.filter((f) => f.subscriptionStatus === "active").length ?? 0;

  return (
    <div className="min-h-screen" style={{ background: BG }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10 flex items-center justify-between px-6 py-4"
        style={{ background: "rgba(5,13,26,.85)", backdropFilter: "blur(12px)", borderBottom: `1px solid ${BORDER}` }}
      >
        <LogoWordmark size={30} />
        <div className="flex items-center gap-4">
          <span className="text-xs" style={{ color: "#4A5568" }}>Super-admin</span>
          <div className="w-px h-4" style={{ background: BORDER }} />
          <button
            onClick={() => { clearToken(); navigate("/login"); }}
            className="text-sm transition-colors"
            style={{ color: "#8C9AB3" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#F8FAFC"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "#8C9AB3"; }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10">
        {/* Checkout banner */}
        {checkoutResult && (
          <div
            className="mb-6 flex items-start gap-3 rounded-xl px-5 py-4"
            style={{ background: "rgba(16,185,129,.08)", border: "1px solid rgba(52,211,153,.2)" }}
          >
            <span className="text-lg">✓</span>
            <div className="flex-1">
              <p className="text-sm" style={{ color: "#6EE7B7" }}>{checkoutResult.message}</p>
              {checkoutResult.url && (
                <a href={checkoutResult.url} target="_blank" rel="noopener noreferrer"
                  className="mt-1 text-xs font-medium underline" style={{ color: "#34D399" }}>
                  Open Stripe Checkout →
                </a>
              )}
            </div>
            <button onClick={() => setCheckoutResult(null)} className="text-xs" style={{ color: "#6EE7B7" }}>✕</button>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-10">
          {[
            { label: "Total firms", value: firms?.length ?? "—" },
            { label: "Active firms", value: activeFirms || "—" },
            { label: "Enrolled seats", value: totalSeats || "—" },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-xl p-5" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
              <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "#4A5568" }}>{label}</p>
              <p className="text-3xl font-bold tracking-tight" style={{
                background: "linear-gradient(135deg, #818CF8 0%, #22D3EE 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}>{value}</p>
            </div>
          ))}
        </div>

        {/* Table header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Firms</h1>
            <p className="text-xs mt-0.5" style={{ color: "#4A5568" }}>
              {firms ? `${firms.length} registered` : "Loading…"}
            </p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all"
            style={{ background: "linear-gradient(135deg, #4F46E5 0%, #3B82F6 100%)", boxShadow: "0 4px 14px rgba(79,70,229,0.35)" }}
            onMouseEnter={(e) => { e.currentTarget.style.boxShadow = "0 6px 20px rgba(79,70,229,0.55)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "0 4px 14px rgba(79,70,229,0.35)"; }}
          >
            + New Firm
          </button>
        </div>

        {/* Table */}
        {isLoading && <p className="text-sm" style={{ color: "#4A5568" }}>Loading…</p>}
        {error && <p className="text-sm" style={{ color: "#FCA5A5" }}>Error: {(error as Error).message}</p>}

        {firms && (
          <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: `1px solid ${BORDER}`, background: "rgba(255,255,255,.02)" }}>
                  {["Firm", "Status", "Seats", "Limit"].map((h) => (
                    <th key={h} className="text-left px-5 py-3.5 text-xs font-semibold uppercase tracking-wider" style={{ color: "#4A5568" }}>
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
                    onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "hsl(222 45% 11%)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = SURFACE; }}
                  >
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white shrink-0"
                          style={{ background: "linear-gradient(135deg, #4F46E5, #06B6D4)" }}>
                          {firm.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="font-medium text-white">{firm.name}</span>
                      </div>
                    </td>
                    <td className="px-5 py-4"><StatusBadge status={firm.subscriptionStatus} /></td>
                    <td className="px-5 py-4 text-white font-mono">{firm.enrolledSeats}</td>
                    <td className="px-5 py-4 font-mono" style={{ color: "#8C9AB3" }}>{firm.seatLimit ?? "∞"}</td>
                    <td className="px-5 py-4 text-right" style={{ color: "#4A5568" }}>
                      <span className="text-xs">View →</span>
                    </td>
                  </tr>
                ))}
                {firms.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-5 py-14 text-center text-sm" style={{ color: "#4A5568", background: SURFACE }}>
                      No firms yet — create your first one.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {showCreate && <CreateFirmModal onClose={() => setShowCreate(false)} onCreated={handleCreated} />}
    </div>
  );
}
