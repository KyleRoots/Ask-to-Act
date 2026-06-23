import { useState } from "react";
import { useLocation } from "wouter";
import { setToken } from "@/lib/api";

export default function Login() {
  const [token, setTokenValue] = useState("");
  const [error, setError] = useState("");
  const [, navigate] = useLocation();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!token.trim()) {
      setError("Enter your admin token.");
      return;
    }
    // Validate token by hitting a protected endpoint
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
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg bg-blue-500 flex items-center justify-center">
              <span className="text-white font-bold text-sm">A</span>
            </div>
            <span className="text-white font-semibold text-lg">AskToAct</span>
          </div>
          <h1 className="text-xl font-semibold text-white">Admin Portal</h1>
          <p className="text-slate-400 text-sm mt-1">Enter your bearer token to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              Admin Token
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => setTokenValue(e.target.value)}
              placeholder="MCP bearer token"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          {error && (
            <p className="text-red-400 text-sm">{error}</p>
          )}
          <button
            type="submit"
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
          >
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
