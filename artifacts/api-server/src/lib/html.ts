import { nonceAttr } from "./csp-nonce.js";

// Shared HTML helpers for the server-rendered pages (landing, enroll, connector
// setup, OAuth status). Centralizes HTML escaping, the brand logo SVG, and the
// standard status-page template so they don't drift across route modules.

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const brandLogo = `<svg width="32" height="32" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#4338CA"/><stop offset="55%" stop-color="#4F46E5"/><stop offset="100%" stop-color="#0EA5E9"/></linearGradient></defs><rect width="48" height="48" rx="13" fill="url(#g)"/><path d="M11 5 C11 3.3 12.3 2 14 2 L34 2 C35.7 2 37 3.3 37 5 L37 27 C37 28.7 35.7 30 34 30 L27.5 30 L24 36.5 L20.5 30 L14 30 C12.3 30 11 28.7 11 27 Z" fill="white" fill-opacity="0.97"/><line x1="15.5" y1="16" x2="29.5" y2="16" stroke="#4338CA" stroke-width="3" stroke-linecap="round"/><polyline points="25,11 31,16 25,21" fill="none" stroke="#4338CA" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function page(title: string, message: string): string {
  const t = escapeHtml(title);
  const m = escapeHtml(message);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title><style${nonceAttr()}>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e8ecf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:520px;padding:40px;text-align:center}.logo{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:28px}.logo-text{font-size:18px;font-weight:800;letter-spacing:-0.02em;color:#f8fafc}.logo-text span{color:#38BDF8}h1{font-size:22px;margin:0 0 12px}p{font-size:15px;line-height:1.6;color:#aab4c5;margin:0}</style></head><body><main><div class="logo">${brandLogo}<span class="logo-text">Ask<span>To</span>Act</span></div><h1>${t}</h1><p>${m}</p></main></body></html>`;
}
