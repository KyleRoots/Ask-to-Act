/**
 * CLI to notify ops that an agent started / completed / failed work.
 *
 * Auth: OPS_HEALTH_SECRET or ASKTOACT_MCP_API_KEY (service bearer).
 * Base: ASKTOACT_MCP_BASE_URL (default https://connect.asktoact.ai).
 *
 * Examples:
 *   pnpm --filter @workspace/scripts ops-agent-notify -- --phase started --summary "Investigating stale note-snapshot"
 *   pnpm --filter @workspace/scripts ops-agent-notify -- --phase completed --summary "Fixed + verified" --details "ops-health ok after deploy"
 *   pnpm --filter @workspace/scripts ops-agent-notify -- --phase failed --summary "Could not reproduce" --fingerprint note-stale
 */

const DEFAULT_BASE_URL = "https://connect.asktoact.ai";

function getToken(): string {
  const ops = process.env["OPS_HEALTH_SECRET"]?.trim();
  if (ops) return ops;
  const key = process.env["ASKTOACT_MCP_API_KEY"]?.trim();
  if (key) return key;
  throw new Error(
    "Set OPS_HEALTH_SECRET or ASKTOACT_MCP_API_KEY (Cursor Secrets / shell).",
  );
}

function getBaseUrl(): string {
  const raw = process.env["ASKTOACT_MCP_BASE_URL"]?.trim() || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

function usage(): never {
  console.error(`Usage:
  ops-agent-notify --phase <started|completed|failed> --summary <text> [--details <text>] [--fingerprint <id>]

Examples:
  pnpm --filter @workspace/scripts ops-agent-notify -- --phase started --summary "Investigating report_jobs stuck"
  pnpm --filter @workspace/scripts ops-agent-notify -- --phase completed --summary "Fixed lease reclaim; ops-health ok"
`);
  process.exit(2);
}

function parseArgs(argv: string[]): {
  phase: string;
  summary: string;
  details?: string;
  fingerprint?: string;
} {
  let phase: string | undefined;
  let summary: string | undefined;
  let details: string | undefined;
  let fingerprint: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--phase" && next) {
      phase = next;
      i++;
    } else if (arg === "--summary" && next) {
      summary = next;
      i++;
    } else if (arg === "--details" && next) {
      details = next;
      i++;
    } else if (arg === "--fingerprint" && next) {
      fingerprint = next;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    }
  }

  if (!phase || !summary) usage();
  return { phase: phase!, summary: summary!, details, fingerprint };
}

async function main(): Promise<void> {
  const { phase, summary, details, fingerprint } = parseArgs(
    process.argv.slice(2),
  );

  const url = `${getBaseUrl()}/api/internal/ops-agent-notify`;
  const body: Record<string, string> = { phase, summary };
  if (details) body["details"] = details;
  if (fingerprint) body["fingerprint"] = fingerprint;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    console.error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    process.exit(2);
  }

  if (!res.ok) {
    console.error(`HTTP ${res.status}:`, JSON.stringify(parsed, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify(parsed, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
