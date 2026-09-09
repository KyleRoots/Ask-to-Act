/** Pure env helpers for proactive Bullhorn OAuth refresh (no DB). */

/** True when proactive refresh is enabled (default on; set BULLHORN_AUTH_REFRESH=0). */
export function bullhornAuthRefreshEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env["BULLHORN_AUTH_REFRESH"];
  if (raw === undefined || raw.trim() === "") return true;
  return raw.trim() !== "0";
}
