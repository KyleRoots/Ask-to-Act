import { useState } from "react";
import { useLocation } from "wouter";
import { setToken } from "@/lib/api";
import { LogoIcon } from "@/components/Logo";

export default function Login() {
  const [token, setTokenValue] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [, navigate] = useLocation();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!token.trim()) {
      setError("Please enter your admin token.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/firms", {
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      if (res.status === 401) {
        setError("Invalid token — access denied.");
        return;
      }
      setToken(token.trim());
      navigate("/firms");
    } catch {
      setError("Could not reach server. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="min-h-screen min-h-dvh flex items-center justify-center px-4 py-10"
      style={{ background: "hsl(220 50% 4%)" }}
    >
      {/* Ambient glows — hidden on very small screens for performance */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
        <div
          className="absolute -top-32 left-1/2 -translate-x-1/2 w-[min(600px,100vw)] h-[min(500px,80vw)] rounded-full opacity-20"
          style={{ background: "radial-gradient(circle, #4F46E5 0%, transparent 70%)" }}
        />
        <div
          className="absolute bottom-0 right-0 w-64 h-64 rounded-full opacity-10"
          style={{ background: "radial-gradient(circle, #0EA5E9 0%, transparent 70%)" }}
        />
      </div>

      <div className="relative w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="flex justify-center mb-4">
            <LogoIcon size={60} />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-white" style={{ letterSpacing: "-0.03em" }}>
            Ask<span style={{ color: "#38BDF8" }}>To</span>Act
          </h1>
          <p className="mt-1.5 text-sm" style={{ color: "#6B7A99" }}>
            Super-admin portal
          </p>
        </div>

        {/* Card */}
        <div
          className="rounded-2xl border p-6 sm:p-8 shadow-2xl"
          style={{ background: "hsl(222 45% 8%)", borderColor: "hsl(217 35% 18%)" }}
        >
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label
                className="block text-xs font-semibold uppercase tracking-wider mb-2"
                style={{ color: "#6B7A99" }}
              >
                Admin Token
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setTokenValue(e.target.value)}
                placeholder="Paste your bearer token"
                autoComplete="current-password"
                className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-[#3A4460] outline-none transition-all"
                style={{
                  background: "hsl(217 35% 11%)",
                  border: "1.5px solid hsl(217 35% 20%)",
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "#4F46E5";
                  e.currentTarget.style.boxShadow = "0 0 0 3px rgba(79,70,229,0.2)";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "hsl(217 35% 20%)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              />
            </div>

            {error && (
              <div
                className="flex items-start gap-2 rounded-xl px-4 py-3 text-sm"
                style={{
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.2)",
                  color: "#FCA5A5",
                }}
              >
                <span className="mt-px shrink-0">⚠</span>
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl text-sm font-bold text-white transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: "linear-gradient(135deg, #4F46E5 0%, #0EA5E9 100%)",
                boxShadow: "0 4px 18px rgba(79,70,229,0.45)",
                letterSpacing: "-0.01em",
              }}
            >
              {loading ? "Verifying…" : "Sign in →"}
            </button>
          </form>

          <p className="mt-5 text-center text-xs" style={{ color: "#3A4460" }}>
            Bearer token · AskToAct internal only
          </p>
        </div>
      </div>
    </div>
  );
}
