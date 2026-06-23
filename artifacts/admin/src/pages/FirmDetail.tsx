import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
    none: { background: "rgba(148,163,184,.08)", color: "#6B7A99", border: "1px solid rgba(107,122,153,.2)" },
  };
  const s = styles[status] ?? styles.none;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium" style={s}>
      {status === "active" && (
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "#34D399" }} />
      )}
      {status}
    </span>
  );
}

function UsageChart({ data }: { data: UsageMonth[] }) {
  if (!data.length) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <div className="w-11 h-11 rounded-2xl flex items-center justify-center text-xl" style={{ background: "rgba(79,70,229,.1)" }}>
          📊
        </div>
        <p className="text-sm text-center" style={{ color: "#3A4460" }}>
          No usage yet — data appears on first AI call per month.
        </p>
      </div>
    );
  }
  const max = Math.max(...data.map((d) => d.activeSeats), 1);
  return (
    <div className="space-y-3.5">
      {data.map((d) => (
        <div key={`${d.year}-${d.month}`} className="flex items-center gap-3">
          <span className="text-xs font-mono w-9 text-right shrink-0" style={{ color: "#6B7A99" }}>
            {MONTH_NAMES[d.month]}
          </span>
          <div className="flex-1 rounded-full h-2" style={{ background: "hsl(217 35% 14%)" }}>
            <div
              className="h-2 rounded-full transition-all"
              style={{
                width: `${Math.max((d.activeSeats / max) * 100, 3)}%`,
                background: "linear-gradient(90deg, #4F46E5 0%, #0EA5E9 100%)",
              }}
            />
          </div>
          <div className="shrink-0 flex items-center gap-3 text-xs">
            <span className="font-semibold text-white w-16 text-right">
              {d.activeSeats} seat{d.activeSeats !== 1 ? "s" : ""}
            </span>
            <span className="hidden sm:inline w-20" style={{ color: "#3A4460" }}>
              {d.totalCalls.toLocaleString()} calls
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

interface AddUsersModalProps {
  firmId: string;
  onClose: () => void;
  onDone: () => void;
}

function AddUsersModal({ firmId, onClose, onDone }: AddUsersModalProps) {
  const [text, setText] = useState("");
  const [defaultRole, setDefaultRole] = useState("recruiter");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [results, setResults] = useState<{ name: string; email: string; ok: boolean; error?: string }[]>([]);
  const { toast } = useToast();

  function parseLines(): { name: string; email: string; role: string }[] {
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const parts = l.split(",").map((p) => p.trim());
        return {
          name: parts[0] ?? "",
          email: parts[1] ?? "",
          role: parts[2] ?? defaultRole,
        };
      })
      .filter((u) => u.name && u.email && u.email.includes("@"));
  }

  const parsed = parseLines();

  async function handleSubmit() {
    if (!parsed.length) return;
    setIsSubmitting(true);
    const res: { name: string; email: string; ok: boolean; error?: string }[] = [];
    for (const u of parsed) {
      try {
        await api.createUser({ name: u.name, email: u.email, firmId, role: u.role });
        res.push({ name: u.name, email: u.email, ok: true });
      } catch (err) {
        res.push({ name: u.name, email: u.email, ok: false, error: (err as Error).message });
      }
    }
    setResults(res);
    setIsSubmitting(false);
    const ok = res.filter((r) => r.ok).length;
    const fail = res.filter((r) => !r.ok).length;
    toast({
      title: `${ok} user${ok !== 1 ? "s" : ""} added${fail > 0 ? `, ${fail} failed` : ""}`,
      variant: fail > 0 && ok === 0 ? "destructive" : "default",
    });
    if (ok > 0) onDone();
  }

  const isDone = results.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(5,13,26,.85)", backdropFilter: "blur(8px)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-full max-w-lg rounded-2xl p-6 sm:p-7 flex flex-col gap-5"
        style={{ background: "#141927", border: `1px solid ${BORDER}`, maxHeight: "90vh", overflowY: "auto" }}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Add users</h2>
            <p className="text-xs mt-0.5" style={{ color: "#3A4460" }}>
              One per line: <span className="font-mono text-sky-400">Name, email@domain.com</span>
              &nbsp; (role optional, defaults to recruiter)
            </p>
          </div>
          <button onClick={onClose} className="text-xl leading-none" style={{ color: "#3A4460" }}>✕</button>
        </div>

        {!isDone ? (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"Jane Smith, jane@myticas.com\nJohn Doe, john@myticas.com, admin"}
              rows={7}
              className="w-full rounded-xl p-3 text-sm font-mono resize-y"
              style={{
                background: "#0b1020",
                border: `1px solid ${BORDER}`,
                color: "#e8ecf3",
                outline: "none",
              }}
            />

            <div className="flex items-center gap-3">
              <label className="text-xs font-medium shrink-0" style={{ color: "#6B7A99" }}>Default role</label>
              <select
                value={defaultRole}
                onChange={(e) => setDefaultRole(e.target.value)}
                className="rounded-lg px-3 py-2 text-sm flex-1"
                style={{ background: "#0b1020", border: `1px solid ${BORDER}`, color: "#e8ecf3" }}
              >
                <option value="recruiter">Recruiter</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            {parsed.length > 0 && (
              <div className="rounded-xl p-3 text-xs space-y-1" style={{ background: "rgba(79,70,229,.06)", border: "1px solid rgba(79,70,229,.2)" }}>
                <p style={{ color: "#818CF8" }}>{parsed.length} valid entr{parsed.length !== 1 ? "ies" : "y"} found</p>
                {parsed.slice(0, 4).map((u, i) => (
                  <p key={i} style={{ color: "#4a5568" }}>
                    {u.name} · {u.email} · <span style={{ color: "#6B7A99" }}>{u.role}</span>
                  </p>
                ))}
                {parsed.length > 4 && <p style={{ color: "#3A4460" }}>…and {parsed.length - 4} more</p>}
              </div>
            )}

            <div className="flex gap-3 pt-1">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
                style={{ background: "hsl(217 35% 14%)", color: "#6B7A99", border: `1px solid ${BORDER}` }}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitting || parsed.length === 0}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-opacity"
                style={{
                  background: "linear-gradient(135deg,#4F46E5,#0EA5E9)",
                  opacity: isSubmitting || parsed.length === 0 ? 0.5 : 1,
                }}
              >
                {isSubmitting ? "Adding…" : `Add ${parsed.length || ""} user${parsed.length !== 1 ? "s" : ""}`}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-2">
              {results.map((r, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
                  style={{ background: r.ok ? "rgba(16,185,129,.07)" : "rgba(239,68,68,.07)", border: `1px solid ${r.ok ? "rgba(52,211,153,.2)" : "rgba(252,165,165,.2)"}` }}
                >
                  <span style={{ color: r.ok ? "#34D399" : "#FCA5A5" }}>{r.ok ? "✓" : "✕"}</span>
                  <span className="font-medium text-white">{r.name}</span>
                  <span style={{ color: "#6B7A99" }}>{r.email}</span>
                  {r.error && <span className="text-xs ml-auto" style={{ color: "#FCA5A5" }}>{r.error}</span>}
                </div>
              ))}
            </div>
            <button
              onClick={onClose}
              className="w-full px-4 py-2.5 rounded-xl text-sm font-medium"
              style={{ background: "hsl(217 35% 14%)", color: "#6B7A99", border: `1px solid ${BORDER}` }}
            >
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function FirmDetail({ firmId }: { firmId: string }) {
  const [tab, setTab] = useState<"overview" | "users" | "usage">("overview");
  const [showAddUsers, setShowAddUsers] = useState(false);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const logoInputRef = useRef<HTMLInputElement>(null);

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

  const activateMutation = useMutation({
    mutationFn: () => api.activateFirm(firmId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["firm", firmId] });
      queryClient.invalidateQueries({ queryKey: ["firms"] });
      toast({ title: "Firm activated as pilot ✓" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const inviteMutation = useMutation({
    mutationFn: (resend: boolean) => api.sendInvites(firmId, resend),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["firm-users", firmId] });
      toast({
        title: data.sent > 0 ? `${data.sent} invite${data.sent !== 1 ? "s" : ""} sent ✓` : "No invites sent",
        description: data.message,
        variant: data.sent === 0 ? "destructive" : "default",
      });
    },
    onError: (err: Error) => toast({ title: "Invite failed", description: err.message, variant: "destructive" }),
  });

  const logoMutation = useMutation({
    mutationFn: (logoData: string) => api.uploadLogo(firmId, logoData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["firm", firmId] });
      toast({ title: "Logo updated ✓" });
    },
    onError: (err: Error) => toast({ title: "Logo upload failed", description: err.message, variant: "destructive" }),
  });

  function handleLogoFile(file: File) {
    if (!file.type.startsWith("image/")) {
      toast({ title: "Please select an image file", variant: "destructive" });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: "Logo must be under 2 MB", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        logoMutation.mutate(reader.result);
      }
    };
    reader.readAsDataURL(file);
  }

  async function openBillingPortal() {
    try {
      const { url } = await api.billingPortal(firmId);
      window.open(url, "_blank");
    } catch (err) {
      toast({ title: "Billing portal unavailable", description: (err as Error).message, variant: "destructive" });
    }
  }

  const isPilotEligible =
    firm &&
    firm.subscriptionStatus !== "active" &&
    firm.subscriptionStatus !== "trialing";

  return (
    <div className="min-h-screen min-h-dvh" style={{ background: BG }}>
      {/* Hidden logo file input */}
      <input
        ref={logoInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleLogoFile(file);
          e.target.value = "";
        }}
      />

      {/* Add Users Modal */}
      {showAddUsers && firm && (
        <AddUsersModal
          firmId={firmId}
          onClose={() => setShowAddUsers(false)}
          onDone={() => {
            queryClient.invalidateQueries({ queryKey: ["firm-users", firmId] });
            queryClient.invalidateQueries({ queryKey: ["firm", firmId] });
            setShowAddUsers(false);
          }}
        />
      )}

      {/* Header */}
      <header
        className="sticky top-0 z-10 flex items-center justify-between px-4 sm:px-6 py-3.5"
        style={{
          background: "rgba(5,13,26,.9)",
          backdropFilter: "blur(14px)",
          borderBottom: `1px solid ${BORDER}`,
        }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/firms")}
            className="flex items-center gap-1.5 text-sm transition-colors shrink-0"
            style={{ color: "#6B7A99" }}
          >
            ← <span className="hidden sm:inline">Firms</span>
          </button>
          <div className="w-px h-4 shrink-0" style={{ background: BORDER }} />
          <LogoWordmark size={24} />
        </div>
        <button
          onClick={() => { clearToken(); navigate("/login"); }}
          className="text-sm px-3 py-1.5 rounded-lg transition-colors"
          style={{ color: "#6B7A99", border: `1px solid ${BORDER}` }}
        >
          Sign out
        </button>
      </header>

      {isLoading && (
        <div className="flex items-center justify-center h-64 text-sm" style={{ color: "#3A4460" }}>
          Loading…
        </div>
      )}

      {firm && (
        <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
          {/* Firm heading */}
          <div className="flex items-center gap-4 mb-7">
            {firm.logoUrl ? (
              <div
                className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl overflow-hidden shrink-0 flex items-center justify-center"
                style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
              >
                <img
                  src={firm.logoUrl}
                  alt={`${firm.name} logo`}
                  className="w-full h-full object-contain p-1"
                />
              </div>
            ) : (
              <div
                className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl flex items-center justify-center text-lg sm:text-xl font-extrabold text-white shrink-0"
                style={{ background: "linear-gradient(135deg, #4F46E5, #0EA5E9)" }}
              >
                {firm.name.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h1 className="text-xl sm:text-2xl font-extrabold text-white tracking-tight truncate">
                {firm.name}
              </h1>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <StatusBadge status={firm.subscriptionStatus} />
                <span className="text-xs" style={{ color: "#3A4460" }}>
                  Since{" "}
                  {new Date(firm.createdAt).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                </span>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-8">
            {[
              { label: "Enrolled seats", value: String(firm.enrolledSeats) },
              { label: "Seat limit", value: firm.seatLimit != null ? String(firm.seatLimit) : "∞" },
              { label: "Remaining", value: firm.seatsRemaining === "unlimited" ? "∞" : String(firm.seatsRemaining) },
              { label: "Billing", value: firm.stripeSubscriptionId ? "Stripe" : "Pilot" },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-xl p-4" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
                <p className="text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#3A4460" }}>
                  {label}
                </p>
                <p
                  className="text-2xl font-extrabold tracking-tight"
                  style={{
                    background: "linear-gradient(135deg, #818CF8 0%, #38BDF8 100%)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    backgroundClip: "text",
                  }}
                >
                  {value}
                </p>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div className="overflow-x-auto -mx-4 sm:mx-0 mb-7">
            <div className="flex gap-0 min-w-max px-4 sm:px-0" style={{ borderBottom: `1px solid ${BORDER}` }}>
              {(["overview", "users", "usage"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className="px-5 py-3 text-sm font-medium capitalize transition-all whitespace-nowrap"
                  style={{
                    borderBottom: tab === t ? "2px solid #4F46E5" : "2px solid transparent",
                    color: tab === t ? "#818CF8" : "#3A4460",
                    marginBottom: "-1px",
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* ── OVERVIEW TAB ── */}
          {tab === "overview" && (
            <div className="space-y-5">
              {/* Pilot activation banner */}
              {isPilotEligible && (
                <div
                  className="rounded-2xl p-5 flex items-center justify-between gap-4 flex-wrap"
                  style={{ background: "rgba(79,70,229,.06)", border: "1px solid rgba(79,70,229,.25)" }}
                >
                  <div>
                    <p className="text-sm font-semibold text-white mb-0.5">No active subscription</p>
                    <p className="text-xs" style={{ color: "#6B7A99" }}>
                      Activate as a complimentary pilot to unlock user enrollment for this firm.
                    </p>
                  </div>
                  <button
                    onClick={() => activateMutation.mutate()}
                    disabled={activateMutation.isPending}
                    className="shrink-0 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-opacity"
                    style={{
                      background: "linear-gradient(135deg,#4F46E5,#0EA5E9)",
                      opacity: activateMutation.isPending ? 0.6 : 1,
                    }}
                  >
                    {activateMutation.isPending ? "Activating…" : "Activate as Pilot"}
                  </button>
                </div>
              )}

              {/* Firm details card */}
              <div className="rounded-2xl p-5 sm:p-7" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-6">
                  {[
                    { label: "Firm ID", value: firm.id },
                    { label: "Created", value: new Date(firm.createdAt).toLocaleString() },
                    { label: "Stripe Customer ID", value: firm.stripeCustomerId ?? "Not connected" },
                    { label: "Stripe Subscription ID", value: firm.stripeSubscriptionId ?? "—" },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <dt className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: "#3A4460" }}>
                        {label}
                      </dt>
                      <dd className="text-sm font-mono break-all" style={{ color: "#6B7A99" }}>
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>

                {/* Logo upload */}
                <div className="pt-5" style={{ borderTop: `1px solid ${BORDER}` }}>
                  <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "#3A4460" }}>
                    Company logo
                  </p>
                  <div className="flex items-center gap-4">
                    {firm.logoUrl ? (
                      <div
                        className="w-14 h-14 rounded-xl flex items-center justify-center shrink-0"
                        style={{ background: "#0b1020", border: `1px solid ${BORDER}` }}
                      >
                        <img src={firm.logoUrl} alt="logo" className="w-full h-full object-contain p-1 rounded-xl" />
                      </div>
                    ) : (
                      <div
                        className="w-14 h-14 rounded-xl flex items-center justify-center text-xl shrink-0"
                        style={{ background: "hsl(217 35% 12%)", border: `1px dashed ${BORDER}` }}
                      >
                        🖼
                      </div>
                    )}
                    <div>
                      <button
                        onClick={() => logoInputRef.current?.click()}
                        disabled={logoMutation.isPending}
                        className="px-4 py-2 rounded-xl text-sm font-medium transition-colors"
                        style={{ background: "hsl(217 35% 14%)", color: "#6B7A99", border: `1px solid ${BORDER}` }}
                      >
                        {logoMutation.isPending ? "Uploading…" : firm.logoUrl ? "Replace logo" : "Upload logo"}
                      </button>
                      <p className="text-xs mt-1.5" style={{ color: "#3A4460" }}>PNG, JPG or SVG · Max 2 MB</p>
                    </div>
                  </div>
                </div>

                {firm.stripeCustomerId && (
                  <div className="mt-6 pt-5" style={{ borderTop: `1px solid ${BORDER}` }}>
                    <button
                      onClick={openBillingPortal}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
                      style={{ background: "hsl(217 35% 14%)", color: "#6B7A99", border: `1px solid ${BORDER}` }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = "#F8FAFC"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = "#6B7A99"; }}
                    >
                      ↗ Open Stripe Billing Portal
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── USERS TAB ── */}
          {tab === "users" && (
            <div className="space-y-4">
              {/* Toolbar */}
              <div className="flex items-center gap-2.5 flex-wrap">
                <button
                  onClick={() => setShowAddUsers(true)}
                  className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-semibold text-white"
                  style={{ background: "linear-gradient(135deg,#4F46E5,#0EA5E9)" }}
                >
                  + Add users
                </button>
                <div className="flex-1" />
                <button
                  onClick={() => inviteMutation.mutate(false)}
                  disabled={inviteMutation.isPending}
                  className="px-4 py-2.5 rounded-xl text-sm font-medium transition-opacity"
                  style={{
                    background: "rgba(16,185,129,.1)",
                    color: "#34D399",
                    border: "1px solid rgba(52,211,153,.25)",
                    opacity: inviteMutation.isPending ? 0.6 : 1,
                  }}
                  title="Send invites to users who haven't been invited yet"
                >
                  {inviteMutation.isPending ? "Sending…" : "✉ Send invites"}
                </button>
                <button
                  onClick={() => inviteMutation.mutate(true)}
                  disabled={inviteMutation.isPending}
                  className="px-4 py-2.5 rounded-xl text-sm font-medium transition-opacity"
                  style={{
                    background: "rgba(79,70,229,.08)",
                    color: "#818CF8",
                    border: "1px solid rgba(129,140,248,.25)",
                    opacity: inviteMutation.isPending ? 0.6 : 1,
                  }}
                  title="Re-send invites to all unenrolled users"
                >
                  ↺ Resend invites
                </button>
              </div>

              {/* Users list */}
              <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
                {usersLoading && (
                  <p className="p-6 text-sm" style={{ color: "#3A4460" }}>Loading…</p>
                )}
                {users && (
                  <>
                    {/* Mobile: card list */}
                    <div className="sm:hidden divide-y" style={{ borderColor: BORDER }}>
                      {users.map((u: UserRow) => (
                        <div key={u.id} className="p-4" style={{ background: SURFACE }}>
                          <div className="flex items-center gap-3 mb-2">
                            <div
                              className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white shrink-0"
                              style={{ background: "hsl(217 35% 20%)" }}
                            >
                              {(u.name ?? u.email ?? "?").charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-white text-sm truncate">{u.name ?? "—"}</p>
                              <p className="text-xs truncate" style={{ color: "#6B7A99" }}>{u.email ?? "—"}</p>
                            </div>
                            <span
                              className="px-2 py-0.5 rounded-md text-xs font-medium shrink-0"
                              style={u.role === "admin"
                                ? { background: "rgba(139,92,246,.15)", color: "#C4B5FD", border: "1px solid rgba(196,181,253,.2)" }
                                : { background: "rgba(148,163,184,.08)", color: "#6B7A99" }}
                            >
                              {u.role}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-xs flex-wrap" style={{ color: "#3A4460" }}>
                            <span
                              className="px-1.5 py-0.5 rounded text-xs"
                              style={u.enrolled
                                ? { background: "rgba(16,185,129,.1)", color: "#34D399" }
                                : u.invitedAt
                                  ? { background: "rgba(79,70,229,.08)", color: "#818CF8" }
                                  : {}}
                            >
                              {u.enrolled ? "Enrolled" : u.invitedAt ? "Invited" : "Not invited"}
                            </span>
                            {!u.enrolled && (
                              <button
                                onClick={() => { navigator.clipboard.writeText(u.enrollUrl); }}
                                className="text-xs underline"
                                style={{ color: "#38bdf8" }}
                              >
                                Copy link
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                      {users.length === 0 && (
                        <div className="p-10 text-center text-sm" style={{ color: "#3A4460", background: SURFACE }}>
                          No users yet. Click "+ Add users" to get started.
                        </div>
                      )}
                    </div>

                    {/* Desktop: table */}
                    <div className="hidden sm:block overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr style={{ borderBottom: `1px solid ${BORDER}`, background: "rgba(255,255,255,.015)" }}>
                            {["Name", "Email", "Role", "Status", "Invited", "Enroll link"].map((h) => (
                              <th
                                key={h}
                                className="text-left px-5 py-3.5 text-xs font-semibold uppercase tracking-wider"
                                style={{ color: "#3A4460" }}
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {users.map((u: UserRow, i: number) => (
                            <tr
                              key={u.id}
                              style={{
                                background: SURFACE,
                                borderBottom: i < users.length - 1 ? `1px solid ${BORDER}` : "none",
                              }}
                            >
                              <td className="px-5 py-4 font-medium text-white">{u.name ?? "—"}</td>
                              <td className="px-5 py-4" style={{ color: "#6B7A99" }}>{u.email ?? "—"}</td>
                              <td className="px-5 py-4">
                                <span
                                  className="px-2 py-0.5 rounded-md text-xs font-medium"
                                  style={u.role === "admin"
                                    ? { background: "rgba(139,92,246,.15)", color: "#C4B5FD", border: "1px solid rgba(196,181,253,.2)" }
                                    : { background: "rgba(148,163,184,.08)", color: "#6B7A99" }}
                                >
                                  {u.role}
                                </span>
                              </td>
                              <td className="px-5 py-4">
                                <span
                                  className="px-2 py-0.5 rounded-md text-xs font-medium"
                                  style={u.enrolled
                                    ? { background: "rgba(16,185,129,.12)", color: "#34D399", border: "1px solid rgba(52,211,153,.2)" }
                                    : u.invitedAt
                                      ? { background: "rgba(79,70,229,.08)", color: "#818CF8", border: "1px solid rgba(129,140,248,.2)" }
                                      : { background: "rgba(148,163,184,.08)", color: "#3A4460" }}
                                >
                                  {u.enrolled ? "Enrolled" : u.invitedAt ? "Invited" : "Pending"}
                                </span>
                              </td>
                              <td className="px-5 py-4 text-xs font-mono" style={{ color: "#3A4460" }}>
                                {u.invitedAt ? new Date(u.invitedAt).toLocaleDateString() : "—"}
                              </td>
                              <td className="px-5 py-4">
                                {!u.enrolled && (
                                  <button
                                    onClick={() => {
                                      navigator.clipboard.writeText(u.enrollUrl);
                                      toast({ title: "Enrollment link copied" });
                                    }}
                                    className="text-xs px-2.5 py-1 rounded-lg transition-colors"
                                    style={{ background: "rgba(56,189,248,.08)", color: "#38bdf8", border: "1px solid rgba(56,189,248,.2)" }}
                                  >
                                    Copy link
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                          {users.length === 0 && (
                            <tr>
                              <td colSpan={6} className="px-5 py-14 text-center text-sm" style={{ color: "#3A4460", background: SURFACE }}>
                                No users yet. Click "+ Add users" to get started.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ── USAGE TAB ── */}
          {tab === "usage" && (
            <div className="rounded-2xl p-5 sm:p-7" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
              <div className="flex items-start justify-between gap-4 mb-6">
                <div>
                  <h3 className="text-base font-semibold text-white">Active seats by month</h3>
                  <p className="text-xs mt-1" style={{ color: "#3A4460" }}>
                    First AI call per user per calendar month
                  </p>
                </div>
                {usage && usage.length > 0 && (
                  <div className="text-right shrink-0">
                    <p className="text-xs" style={{ color: "#3A4460" }}>This month</p>
                    <p
                      className="text-xl font-extrabold"
                      style={{
                        background: "linear-gradient(135deg, #818CF8 0%, #38BDF8 100%)",
                        WebkitBackgroundClip: "text",
                        WebkitTextFillColor: "transparent",
                        backgroundClip: "text",
                      }}
                    >
                      {(() => {
                        const now = new Date();
                        const cur = usage.find((d) => d.year === now.getFullYear() && d.month === now.getMonth() + 1);
                        return cur ? `${cur.activeSeats} seat${cur.activeSeats !== 1 ? "s" : ""}` : "0 seats";
                      })()}
                    </p>
                  </div>
                )}
              </div>
              {usageLoading && <p className="text-sm" style={{ color: "#3A4460" }}>Loading…</p>}
              {usage && <UsageChart data={usage} />}
            </div>
          )}
        </main>
      )}
    </div>
  );
}
