import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { api, clearToken, type FirmRow } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

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
      api.createFirm({
        name,
        ...(seatLimit ? { seatLimit: Number(seatLimit) } : {}),
      }),
    onSuccess: (data) => {
      onCreated(data.checkoutUrl, data.message);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md p-6">
        <h2 className="text-white font-semibold text-lg mb-4">Create Firm</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Firm Name *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Staffing LLC"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              Seat Limit <span className="text-slate-500">(leave blank for unlimited)</span>
            </label>
            <input
              type="number"
              min="1"
              value={seatLimit}
              onChange={(e) => setSeatLimit(e.target.value)}
              placeholder="e.g. 25"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium py-2.5 rounded-lg text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!name.trim() || mutation.isPending}
            className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
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
  const [checkoutResult, setCheckoutResult] = useState<{
    url: string | null;
    message: string;
  } | null>(null);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const { data: firms, isLoading, error } = useQuery({
    queryKey: ["firms"],
    queryFn: api.listFirms,
  });

  function handleSignOut() {
    clearToken();
    navigate("/login");
  }

  function handleCreated(checkoutUrl: string | null, message: string) {
    setShowCreate(false);
    queryClient.invalidateQueries({ queryKey: ["firms"] });
    setCheckoutResult({ url: checkoutUrl, message });
  }

  return (
    <div className="min-h-screen bg-slate-950">
      {/* Header */}
      <header className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-blue-500 flex items-center justify-center">
            <span className="text-white font-bold text-xs">A</span>
          </div>
          <span className="text-white font-semibold">AskToAct Admin</span>
        </div>
        <button
          onClick={handleSignOut}
          className="text-slate-400 hover:text-white text-sm transition-colors"
        >
          Sign out
        </button>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        {/* Checkout result banner */}
        {checkoutResult && (
          <div className="mb-6 bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4">
            <p className="text-emerald-300 text-sm">{checkoutResult.message}</p>
            {checkoutResult.url && (
              <a
                href={checkoutResult.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-sm font-medium text-emerald-400 hover:text-emerald-300 underline"
              >
                Open Stripe Checkout →
              </a>
            )}
            <button
              onClick={() => setCheckoutResult(null)}
              className="ml-4 text-emerald-500 hover:text-emerald-300 text-sm"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Page header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Firms</h1>
            <p className="text-slate-400 text-sm mt-0.5">
              {firms ? `${firms.length} firm${firms.length !== 1 ? "s" : ""}` : "Loading…"}
            </p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            + New Firm
          </button>
        </div>

        {/* Table */}
        {isLoading && (
          <div className="text-slate-400 text-sm">Loading…</div>
        )}
        {error && (
          <div className="text-red-400 text-sm">Failed to load: {(error as Error).message}</div>
        )}
        {firms && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left text-slate-400 font-medium px-4 py-3">Name</th>
                  <th className="text-left text-slate-400 font-medium px-4 py-3">Status</th>
                  <th className="text-left text-slate-400 font-medium px-4 py-3">Seats</th>
                  <th className="text-left text-slate-400 font-medium px-4 py-3">Limit</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {firms.map((firm: FirmRow, i: number) => (
                  <tr
                    key={firm.id}
                    className={`hover:bg-slate-800/50 cursor-pointer transition-colors ${i < firms.length - 1 ? "border-b border-slate-800" : ""}`}
                    onClick={() => navigate(`/firms/${firm.id}`)}
                  >
                    <td className="px-4 py-3 text-white font-medium">{firm.name}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={firm.subscriptionStatus} />
                    </td>
                    <td className="px-4 py-3 text-slate-300">{firm.enrolledSeats}</td>
                    <td className="px-4 py-3 text-slate-300">
                      {firm.seatLimit ?? "∞"}
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-right">→</td>
                  </tr>
                ))}
                {firms.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                      No firms yet — create your first one.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {showCreate && (
        <CreateFirmModal onClose={() => setShowCreate(false)} onCreated={handleCreated} />
      )}
    </div>
  );
}
