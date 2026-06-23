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
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "hsl(220 50% 4%)" }}
    >
      {/* Ambient glow */}
      <div
        className="pointer-events-none fixed inset-0 overflow-hidden"
        aria-hidden
      >
        <div
          className="absolute -top-40 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full opacity-20"
          style={{
            background:
              "radial-gradient(circle, #4F46E5 0%, transparent 70%)",
          }}
        />
        <div
          className="absolute top-1/3 left-1/4 w-[300px] h-[300px] rounded-full opacity-10"
          style={{
            background:
              "radial-gradient(circle, #06B6D4 0%, transparent 70%)",
          }}
        />
      </div>

      <div className="relative w-full max-w-sm">
        {/* Logo lockup */}
        <div className="mb-10 text-center">
          <div className="flex justify-center mb-5">
            <LogoIcon size={56} />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Ask<span style={{ color: "#22D3EE" }}>To</span>Act
          </h1>
          <p className="mt-1 text-sm" style={{ color: "#8C9AB3" }}>
            Super-admin portal
          </p>
        </div>

        {/* Card */}
        <div
          className="rounded-2xl border p-7 shadow-xl"
          style={{
            background: "hsl(222 45% 8%)",
            borderColor: "hsl(217 35% 18%)",
          }}
        >
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label
                className="block text-xs font-semibold uppercase tracking-wider mb-2"
                style={{ color: "#8C9AB3" }}
              >
                Admin Token
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setTokenValue(e.target.value)}
                placeholder="Enter your bearer token"
                autoComplete="new-password"
                className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-[#4A5568] outline-none transition-all"
                style={{
                  background: "hsl(217 35% 12%)",
                  border: "1px solid hsl(217 35% 22%)",
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "#4F46E5";
                  e.currentTarget.style.boxShadow =
                    "0 0 0 3px rgba(79,70,229,0.18)";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "hsl(217 35% 22%)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              />
            </div>

            {error && (
              <div
                className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm"
                style={{
                  background: "rgba(239,68,68,0.1)",
                  border: "1px solid rgba(239,68,68,0.25)",
                  color: "#FCA5A5",
                }}
              >
                <span>⚠</span>
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-60 disabled:cursor-not-allowed"
              style={{
                background:
                  "linear-gradient(135deg, #4F46E5 0%, #3B82F6 100%)",
                boxShadow: "0 4px 14px rgba(79,70,229,0.4)",
              }}
              onMouseEnter={(e) => {
                if (!loading)
                  e.currentTarget.style.boxShadow =
                    "0 6px 20px rgba(79,70,229,0.55)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow =
                  "0 4px 14px rgba(79,70,229,0.4)";
              }}
            >
              {loading ? "Verifying…" : "Sign in →"}
            </button>
          </form>

          <p
            className="mt-5 text-center text-xs"
            style={{ color: "#4A5568" }}
          >
            Protected by bearer token · AskToAct internal use only
          </p>
        </div>
      </div>
    </div>
  );
}
