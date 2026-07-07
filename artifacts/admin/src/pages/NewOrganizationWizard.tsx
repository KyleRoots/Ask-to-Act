import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  api,
  clearToken,
  type DiscoverySummary,
  type VerifyResult,
} from "@/lib/api";
import { LogoWordmark } from "@/components/Logo";
import { useToast } from "@/hooks/use-toast";

const BG = "hsl(220 50% 4%)";
const SURFACE = "hsl(222 45% 8%)";
const BORDER = "hsl(217 35% 18%)";
const INPUT_BG = "hsl(217 35% 11%)";
const INPUT_BORDER = "hsl(217 35% 20%)";
const GRADIENT = "linear-gradient(135deg, #4F46E5 0%, #0EA5E9 100%)";

// Step order: create → connect → discover → verify → admin → summary
type StepId = "create" | "connect" | "discover" | "verify" | "admin" | "summary";
const STEPS: { id: StepId; label: string }[] = [
  { id: "create", label: "Organization" },
  { id: "connect", label: "Connect Bullhorn" },
  { id: "discover", label: "Discover fields" },
  { id: "verify", label: "Verify" },
  { id: "admin", label: "First admin" },
  { id: "summary", label: "Done" },
];

function inputStyle(): React.CSSProperties {
  return { background: INPUT_BG, border: `1.5px solid ${INPUT_BORDER}` };
}
function focusBorder(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = "#4F46E5";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = INPUT_BORDER;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label
      className="block text-xs font-semibold uppercase tracking-wider mb-2"
      style={{ color: "#6B7A99" }}
    >
      {children}
    </label>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="rounded-xl px-5 py-3 text-sm font-bold text-white transition-all hover:opacity-90 disabled:opacity-50 active:scale-[0.98]"
      style={{ background: GRADIENT, boxShadow: "0 4px 14px rgba(79,70,229,0.35)" }}
    >
      {children}
    </button>
  );
}

function GhostButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-xl px-5 py-3 text-sm font-medium transition-colors disabled:opacity-40"
      style={{ background: "hsl(217 35% 15%)", color: "#6B7A99", border: `1px solid ${BORDER}` }}
      onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.color = "#E2E8F0"; e.currentTarget.style.borderColor = "rgba(255,255,255,.15)"; } }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "#6B7A99"; e.currentTarget.style.borderColor = BORDER; }}
    >
      {children}
    </button>
  );
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div
      className="rounded-xl px-4 py-3 text-sm"
      style={{ background: "rgba(239,68,68,.08)", border: "1px solid rgba(252,165,165,.25)", color: "#FCA5A5" }}
    >
      {message}
    </div>
  );
}

function Stepper({ current }: { current: StepId }) {
  const currentIdx = STEPS.findIndex((s) => s.id === current);
  return (
    <div className="flex items-center gap-1.5 sm:gap-2 mb-8 overflow-x-auto pb-1">
      {STEPS.map((s, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <div key={s.id} className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <div
              className="flex items-center gap-2 rounded-full pl-2 pr-3 py-1.5"
              style={{
                background: active ? "rgba(79,70,229,.14)" : done ? "rgba(16,185,129,.1)" : "transparent",
                border: `1px solid ${active ? "rgba(129,140,248,.4)" : done ? "rgba(52,211,153,.25)" : BORDER}`,
              }}
            >
              <span
                className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                style={{
                  background: done ? "#34D399" : active ? GRADIENT : "hsl(217 35% 15%)",
                  color: done ? "#06281D" : active ? "#fff" : "#6B7A99",
                }}
              >
                {done ? "✓" : i + 1}
              </span>
              <span
                className="text-xs font-medium whitespace-nowrap"
                style={{ color: active ? "#E2E8F0" : done ? "#6EE7B7" : "#3A4460" }}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <span className="w-3 sm:w-5 h-px shrink-0" style={{ background: BORDER }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-6 sm:p-8" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
      {children}
    </div>
  );
}

function StepHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-lg font-bold text-white">{title}</h2>
      <p className="text-sm mt-1" style={{ color: "#6B7A99" }}>{subtitle}</p>
    </div>
  );
}

export default function NewOrganizationWizard({ firmId: firmIdProp }: { firmId?: string }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // null until a firm exists (created here or resumed). When resuming we begin in
  // a "resolving" state while we figure out which step the firm left off on.
  const [step, setStep] = useState<StepId>(firmIdProp ? "create" : "create");
  const [resolving, setResolving] = useState<boolean>(!!firmIdProp);
  const [firmId, setFirmId] = useState<string | null>(firmIdProp ?? null);
  const [firmName, setFirmName] = useState<string>("");
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  // Resume: determine where an existing firm left off.
  useEffect(() => {
    if (!firmIdProp) return;
    let cancelled = false;
    (async () => {
      try {
        const firm = await api.getFirm(firmIdProp);
        if (cancelled) return;
        setFirmName(firm.name);
      } catch {
        /* name is best-effort */
      }
      try {
        const status = await api.bullhornStatus(firmIdProp);
        if (cancelled) return;
        if (!status.connected || !status.healthy || status.needsReauthorization) {
          setStep("connect");
          return;
        }
        const cfg = await api.getFirmConfig(firmIdProp);
        if (cancelled) return;
        setStep(cfg.discovered ? "verify" : "discover");
      } catch {
        if (!cancelled) setStep("connect");
      } finally {
        if (!cancelled) setResolving(false);
      }
    })();
    return () => { cancelled = true; };
  }, [firmIdProp]);

  function goTo(next: StepId) {
    setStep(next);
  }

  return (
    <div className="min-h-screen min-h-dvh" style={{ background: BG }}>
      <header
        className="sticky top-0 z-10 flex items-center justify-between px-4 sm:px-6 py-3.5"
        style={{ background: "rgba(5,13,26,.9)", backdropFilter: "blur(14px)", borderBottom: `1px solid ${BORDER}` }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/firms")}
            className="flex items-center gap-1.5 text-sm transition-colors shrink-0"
            style={{ color: "#6B7A99" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#E2E8F0"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "#6B7A99"; }}
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
          onMouseEnter={(e) => { e.currentTarget.style.color = "#E2E8F0"; e.currentTarget.style.borderColor = "rgba(255,255,255,.15)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "#6B7A99"; e.currentTarget.style.borderColor = BORDER; }}
        >
          Sign out
        </button>
      </header>

      <main className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <div className="mb-7">
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
            {firmIdProp ? "Continue setup" : "New organization"}
          </h1>
          <p className="text-sm mt-1" style={{ color: "#6B7A99" }}>
            {firmName
              ? `Onboarding ${firmName} onto its own Bullhorn workspace.`
              : "Onboard a customer firm onto its own Bullhorn workspace."}
          </p>
        </div>

        <Stepper current={step} />

        {resolving ? (
          <Card>
            <p className="text-sm" style={{ color: "#6B7A99" }}>Checking where this firm left off…</p>
          </Card>
        ) : (
          <>
            {step === "create" && (
              <CreateStep
                onCreated={(id, name, checkout) => {
                  setFirmId(id);
                  setFirmName(name);
                  setCheckoutUrl(checkout);
                  queryClient.invalidateQueries({ queryKey: ["firms"] });
                  goTo("connect");
                }}
              />
            )}
            {step === "connect" && firmId && (
              <ConnectStep firmId={firmId} onBack={() => goTo("create")} onConnected={() => goTo("discover")} />
            )}
            {step === "discover" && firmId && (
              <DiscoverStep firmId={firmId} onBack={() => goTo("connect")} onDone={() => goTo("verify")} />
            )}
            {step === "verify" && firmId && (
              <VerifyStep firmId={firmId} onBack={() => goTo("discover")} onDone={() => goTo("admin")} />
            )}
            {step === "admin" && firmId && (
              <AdminStep
                firmId={firmId}
                onBack={() => goTo("verify")}
                onDone={() => {
                  queryClient.invalidateQueries({ queryKey: ["firms"] });
                  goTo("summary");
                }}
                toast={toast}
              />
            )}
            {step === "summary" && firmId && (
              <SummaryStep firmId={firmId} firmName={firmName} checkoutUrl={checkoutUrl} />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function CreateStep({
  onCreated,
}: {
  onCreated: (firmId: string, name: string, checkoutUrl: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [seatLimit, setSeatLimit] = useState("");

  const mutation = useMutation({
    mutationFn: () => api.createFirm({ name: name.trim(), ...(seatLimit ? { seatLimit: Number(seatLimit) } : {}) }),
    onSuccess: (data) => onCreated(data.id, name.trim(), data.checkoutUrl),
  });

  return (
    <Card>
      <StepHeading
        title="Organization details"
        subtitle="Create the firm record. You'll connect its Bullhorn workspace next."
      />
      <form
        className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); if (name.trim()) mutation.mutate(); }}
      >
        <div>
          <Label>Organization name *</Label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Staffing LLC"
            className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-[#3A4460] outline-none"
            style={inputStyle()}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </div>
        <div>
          <Label>
            Seat limit{" "}
            <span style={{ color: "#3A4460", textTransform: "none", fontWeight: 400 }}>(blank = unlimited)</span>
          </Label>
          <input
            type="number"
            min="1"
            value={seatLimit}
            onChange={(e) => setSeatLimit(e.target.value)}
            placeholder="e.g. 25"
            className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-[#3A4460] outline-none"
            style={inputStyle()}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </div>
        {mutation.isError && <ErrorNote message={(mutation.error as Error).message} />}
        <div className="flex justify-end pt-1">
          <PrimaryButton type="submit" disabled={!name.trim() || mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Create & continue →"}
          </PrimaryButton>
        </div>
      </form>
    </Card>
  );
}

function ConnectStep({
  firmId,
  onBack,
  onConnected,
}: {
  firmId: string;
  onBack: () => void;
  onConnected: () => void;
}) {
  const [opening, setOpening] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ["bh-status", firmId],
    queryFn: () => api.bullhornStatus(firmId),
    refetchInterval: (query) => (query.state.data?.healthy ? false : 4000),
  });

  const healthy = statusQuery.data?.healthy === true;
  const needsReauth = statusQuery.data?.needsReauthorization === true;

  async function openAuth() {
    setOpening(true);
    setOpenError(null);
    try {
      const { url } = await api.bullhornLoginUrl(firmId);
      window.open(url, "_blank", "noopener,noreferrer");
      setLaunched(true);
    } catch (err) {
      setOpenError((err as Error).message);
    } finally {
      setOpening(false);
    }
  }

  return (
    <Card>
      <StepHeading
        title="Connect Bullhorn"
        subtitle="Authorize this firm's Bullhorn workspace. A new tab opens for the Bullhorn sign-in — this page detects the connection automatically."
      />

      {healthy ? (
        <div
          className="rounded-xl px-4 py-4 flex items-start gap-3 mb-6"
          style={{ background: "rgba(16,185,129,.08)", border: "1px solid rgba(52,211,153,.2)" }}
        >
          <span>✓</span>
          <div>
            <p className="text-sm font-medium" style={{ color: "#6EE7B7" }}>Bullhorn connected</p>
            <p className="text-xs mt-0.5" style={{ color: "#6B7A99" }}>
              This firm's Bullhorn workspace is authorized and ready.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4 mb-6">
          {needsReauth && (
            <div
              className="rounded-xl px-4 py-4 flex items-start gap-3"
              style={{ background: "rgba(239,68,68,.08)", border: "1px solid rgba(248,113,113,.25)" }}
            >
              <span>⚠</span>
              <div>
                <p className="text-sm font-medium" style={{ color: "#FCA5A5" }}>
                  Bullhorn re-authorization required
                </p>
                <p className="text-xs mt-1" style={{ color: "#6B7A99", lineHeight: 1.6 }}>
                  The stored OAuth token is no longer valid (password change, revoked consent, or expired refresh).
                  Recruiters cannot use connector tools until you complete authorization below.
                </p>
              </div>
            </div>
          )}
          <PrimaryButton onClick={openAuth} disabled={opening}>
            {opening ? "Opening…" : launched ? "Re-open Bullhorn authorization" : "Open Bullhorn authorization →"}
          </PrimaryButton>
          {launched && (
            <div className="flex items-center gap-2 text-sm" style={{ color: "#6B7A99" }}>
              <span
                className="w-3.5 h-3.5 rounded-full border-2 border-t-transparent animate-spin shrink-0"
                style={{ borderColor: "#818CF8", borderTopColor: "transparent" }}
              />
              Waiting for authorization to complete in the other tab…
            </div>
          )}
          {openError && <ErrorNote message={openError} />}
        </div>
      )}

      <div className="flex justify-between pt-1">
        <GhostButton onClick={onBack}>← Back</GhostButton>
        <PrimaryButton onClick={onConnected} disabled={!healthy}>
          Continue →
        </PrimaryButton>
      </div>
    </Card>
  );
}

function DiscoverStep({
  firmId,
  onBack,
  onDone,
}: {
  firmId: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const [summary, setSummary] = useState<DiscoverySummary | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.discoverConfig(firmId),
    onSuccess: (data) => setSummary(data),
  });

  const deptEntries = useMemo(
    () => (summary ? Object.entries(summary.internalDepartment) : []),
    [summary],
  );

  return (
    <Card>
      <StepHeading
        title="Discover field configuration"
        subtitle="Bullhorn custom fields differ per firm. This inspects the workspace and maps the 'Internal Department' field for each entity."
      />

      {!summary && (
        <div className="space-y-4 mb-6">
          <PrimaryButton onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Discovering…" : "Run discovery"}
          </PrimaryButton>
          {mutation.isError && <ErrorNote message={(mutation.error as Error).message} />}
        </div>
      )}

      {summary && (
        <div className="space-y-4 mb-6">
          <div
            className="rounded-xl px-4 py-3 text-sm"
            style={{ background: "rgba(16,185,129,.08)", border: "1px solid rgba(52,211,153,.2)", color: "#6EE7B7" }}
          >
            Discovered {summary.entitiesDiscovered.length} entit
            {summary.entitiesDiscovered.length === 1 ? "y" : "ies"}, mapped department field for {deptEntries.length}.
          </div>

          {deptEntries.length > 0 && (
            <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: `1px solid ${BORDER}`, background: "rgba(255,255,255,.015)" }}>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider" style={{ color: "#3A4460" }}>Entity</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider" style={{ color: "#3A4460" }}>Internal Department field</th>
                  </tr>
                </thead>
                <tbody>
                  {deptEntries.map(([entity, field], i) => (
                    <tr key={entity} style={{ borderBottom: i < deptEntries.length - 1 ? `1px solid ${BORDER}` : "none" }}>
                      <td className="px-4 py-2.5 text-white">{entity}</td>
                      <td className="px-4 py-2.5 font-mono text-xs" style={{ color: "#818CF8" }}>{field}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {summary.missingInternalDepartment.length > 0 && (
            <p className="text-xs" style={{ color: "#6B7A99" }}>
              No department field detected on: {summary.missingInternalDepartment.join(", ")} (these fall back to defaults).
            </p>
          )}

          {summary.entitiesFailed.length > 0 && (
            <ErrorNote
              message={`Could not inspect: ${summary.entitiesFailed.map((f) => f.entity).join(", ")}. You can continue — these use defaults.`}
            />
          )}
        </div>
      )}

      <div className="flex justify-between pt-1">
        <GhostButton onClick={onBack}>← Back</GhostButton>
        <PrimaryButton onClick={onDone} disabled={!summary}>
          Continue →
        </PrimaryButton>
      </div>
    </Card>
  );
}

function VerifyStep({
  firmId,
  onBack,
  onDone,
}: {
  firmId: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const [result, setResult] = useState<VerifyResult | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.verifyConnection(firmId),
    onSuccess: (data) => setResult(data),
  });

  return (
    <Card>
      <StepHeading
        title="Verify the connection"
        subtitle="Run a live read against the firm's Bullhorn to confirm the connection actually works end-to-end."
      />

      {!result && (
        <div className="space-y-4 mb-6">
          <PrimaryButton onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Verifying…" : "Run verification"}
          </PrimaryButton>
          {mutation.isError && <ErrorNote message={(mutation.error as Error).message} />}
        </div>
      )}

      {result?.ok && (
        <div
          className="rounded-xl px-4 py-4 flex items-start gap-3 mb-6"
          style={{ background: "rgba(16,185,129,.08)", border: "1px solid rgba(52,211,153,.2)" }}
        >
          <span>✓</span>
          <div>
            <p className="text-sm font-medium" style={{ color: "#6EE7B7" }}>Connection verified</p>
            <p className="text-xs mt-0.5" style={{ color: "#6B7A99" }}>
              Read {result.entity ?? "records"}:{" "}
              <span className="font-mono" style={{ color: "#E2E8F0" }}>
                {(result.total ?? 0).toLocaleString()}
              </span>{" "}
              found.
            </p>
          </div>
        </div>
      )}

      <div className="flex justify-between pt-1">
        <GhostButton onClick={onBack}>← Back</GhostButton>
        <PrimaryButton onClick={onDone} disabled={!result?.ok}>
          Continue →
        </PrimaryButton>
      </div>
    </Card>
  );
}

function AdminStep({
  firmId,
  onBack,
  onDone,
  toast,
}: {
  firmId: string;
  onBack: () => void;
  onDone: () => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<{ name: string; email: string | null; enrollUrl: string } | null>(null);

  const firmQuery = useQuery({
    queryKey: ["firm", firmId],
    queryFn: () => api.getFirm(firmId),
  });

  const status = firmQuery.data?.subscriptionStatus;
  const billingReady = status === "active" || status === "trialing";

  const activateMutation = useMutation({
    mutationFn: () => api.activateFirm(firmId),
    onSuccess: () => { toast({ title: "Firm activated as pilot ✓" }); firmQuery.refetch(); },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const createMutation = useMutation({
    mutationFn: () => api.createUser({ name: name.trim(), email: email.trim(), firmId, role: "admin" }),
    onSuccess: (data) => setCreated({ name: data.name, email: data.email, enrollUrl: data.enrollUrl }),
  });

  return (
    <Card>
      <StepHeading
        title="First admin user"
        subtitle="Create the firm's first administrator. They can invite the rest of the team and manage the workspace."
      />

      {firmQuery.isLoading ? (
        <p className="text-sm mb-6" style={{ color: "#6B7A99" }}>Checking firm status…</p>
      ) : created ? (
        <div className="space-y-4 mb-6">
          <div
            className="rounded-xl px-4 py-4"
            style={{ background: "rgba(16,185,129,.08)", border: "1px solid rgba(52,211,153,.2)" }}
          >
            <p className="text-sm font-medium" style={{ color: "#6EE7B7" }}>
              {created.name} created as admin
            </p>
            <p className="text-xs mt-1" style={{ color: "#6B7A99" }}>
              Share this access link so they can enroll{created.email ? ` (also emailed to ${created.email})` : ""}:
            </p>
            <div className="flex items-center gap-2 mt-2">
              <code
                className="flex-1 text-xs px-3 py-2 rounded-lg break-all"
                style={{ background: INPUT_BG, color: "#A5B4FC", border: `1px solid ${BORDER}` }}
              >
                {created.enrollUrl}
              </code>
              <button
                onClick={() => { navigator.clipboard.writeText(created.enrollUrl); toast({ title: "Link copied" }); }}
                className="text-xs px-3 py-2 rounded-lg shrink-0 transition-colors"
                style={{ color: "#818CF8", border: "1px solid rgba(129,140,248,.3)" }}
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      ) : !billingReady ? (
        <div className="space-y-4 mb-6">
          <div
            className="rounded-xl px-4 py-4"
            style={{ background: "rgba(245,158,11,.08)", border: "1px solid rgba(252,211,77,.25)" }}
          >
            <p className="text-sm font-medium" style={{ color: "#FCD34D" }}>Subscription required to enroll users</p>
            <p className="text-xs mt-1" style={{ color: "#6B7A99" }}>
              This firm has no active subscription yet (status: {status ?? "none"}). Activate it as a complimentary
              pilot to unlock user enrollment, or set up billing later from the firm page.
            </p>
          </div>
          <PrimaryButton onClick={() => activateMutation.mutate()} disabled={activateMutation.isPending}>
            {activateMutation.isPending ? "Activating…" : "Activate as pilot"}
          </PrimaryButton>
        </div>
      ) : (
        <form
          className="space-y-4 mb-6"
          onSubmit={(e) => { e.preventDefault(); if (name.trim() && emailValid) createMutation.mutate(); }}
        >
          <div>
            <Label>Admin name *</Label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jordan Smith"
              className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-[#3A4460] outline-none"
              style={inputStyle()}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </div>
          <div>
            <Label>
              Email *{" "}
              <span style={{ color: "#3A4460", textTransform: "none", fontWeight: 400 }}>(used to sign in; sends an invite)</span>
            </Label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jordan@acme.com"
              className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-[#3A4460] outline-none"
              style={inputStyle()}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </div>
          {createMutation.isError && <ErrorNote message={(createMutation.error as Error).message} />}
          <div className="flex justify-end">
            <PrimaryButton type="submit" disabled={!name.trim() || !emailValid || createMutation.isPending}>
              {createMutation.isPending ? "Creating…" : "Create admin"}
            </PrimaryButton>
          </div>
        </form>
      )}

      <div className="flex justify-between pt-1">
        <GhostButton onClick={onBack}>← Back</GhostButton>
        <PrimaryButton onClick={onDone} disabled={!created}>
          Finish →
        </PrimaryButton>
      </div>
    </Card>
  );
}

function SummaryStep({
  firmId,
  firmName,
  checkoutUrl,
}: {
  firmId: string;
  firmName: string;
  checkoutUrl: string | null;
}) {
  const [, navigate] = useLocation();
  return (
    <Card>
      <div className="flex flex-col items-center text-center py-2">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl mb-4"
          style={{ background: "rgba(16,185,129,.12)", border: "1px solid rgba(52,211,153,.25)" }}
        >
          ✓
        </div>
        <h2 className="text-lg font-bold text-white">{firmName || "Organization"} is set up</h2>
        <p className="text-sm mt-1 mb-6" style={{ color: "#6B7A99" }}>
          Bullhorn is connected, fields are mapped, the connection is verified, and the first admin is in place.
        </p>

        {checkoutUrl && (
          <div
            className="w-full rounded-xl px-4 py-3 mb-5 text-left"
            style={{ background: "rgba(79,70,229,.08)", border: "1px solid rgba(129,140,248,.25)" }}
          >
            <p className="text-xs mb-1" style={{ color: "#818CF8" }}>Optional: start a paid subscription</p>
            <a
              href={checkoutUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium underline break-all"
              style={{ color: "#A5B4FC" }}
            >
              Open Stripe Checkout →
            </a>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3 w-full">
          <GhostButton onClick={() => navigate("/firms")}>Back to firms</GhostButton>
          <div className="flex-1">
            <button
              onClick={() => navigate(`/firms/${firmId}`)}
              className="w-full rounded-xl px-5 py-3 text-sm font-bold text-white transition-all hover:opacity-90 active:scale-[0.98]"
              style={{ background: GRADIENT, boxShadow: "0 4px 14px rgba(79,70,229,0.35)" }}
            >
              Go to {firmName || "firm"} →
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}
