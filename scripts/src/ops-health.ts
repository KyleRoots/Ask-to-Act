/**
 * CLI for AskToAct ops health (production or local).
 *
 * Auth: OPS_HEALTH_SECRET or ASKTOACT_MCP_API_KEY (service bearer).
 * Base: ASKTOACT_MCP_BASE_URL (default https://connect.asktoact.ai).
 *
 * Examples:
 *   pnpm --filter @workspace/scripts ops-health
 *   pnpm --filter @workspace/scripts ops-health -- --alert
 *   pnpm --filter @workspace/scripts ops-health -- --json
 *
 * Exit: 0 ok, 1 warn, 2 critical, 3 status could not be determined.
 * A check that could not run (auth, config, transport) reports status
 * "unknown" and exit 3 — never 2, so a blind check is not mistaken for a
 * production incident and an incident is not dismissed as a config problem.
 */

const DEFAULT_BASE_URL = "https://connect.asktoact.ai";

const EXIT_OK = 0;
const EXIT_WARN = 1;
const EXIT_CRITICAL = 2;
const EXIT_UNKNOWN = 3;

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

/** What an operator should do about a check that could not produce a status. */
function unknownHint(httpStatus: number | null): string {
  if (httpStatus === 401) {
    return "Bearer missing or malformed. Set OPS_HEALTH_SECRET or ASKTOACT_MCP_API_KEY.";
  }
  if (httpStatus === 403) {
    return (
      "Bearer rejected. Ops routes accept only the service token (MCP_BEARER_TOKEN) " +
      "or OPS_HEALTH_SECRET; portal user API keys are refused by design. Set " +
      "OPS_HEALTH_SECRET to the ops secret, or supply the service bearer as " +
      "ASKTOACT_MCP_API_KEY."
    );
  }
  if (httpStatus === null) {
    return "Could not reach the server. Check ASKTOACT_MCP_BASE_URL and network egress.";
  }
  return "Server did not return an ops-health status. Check api-server logs for this request.";
}

/**
 * Report that production health is UNKNOWN and exit 3. Under --json the
 * payload always carries a `status`, so consumers can branch on one field
 * whether or not the check reached the health logic.
 */
function reportUnknown(
  asJson: boolean,
  detail: {
    httpStatus: number | null;
    error: string;
    body?: Record<string, unknown>;
  },
): never {
  const hint = unknownHint(detail.httpStatus);
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ...(detail.body ?? {}),
          status: "unknown",
          httpStatus: detail.httpStatus,
          error: detail.error,
          hint,
        },
        null,
        2,
      ),
    );
  } else {
    console.error("status: unknown (health could not be determined)");
    console.error(
      `reason: ${detail.httpStatus === null ? "" : `HTTP ${detail.httpStatus}: `}${detail.error}`,
    );
    console.error(`hint: ${hint}`);
  }
  process.exit(EXIT_UNKNOWN);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const alert = args.includes("--alert");
  const asJson = args.includes("--json");

  const url = new URL(`${getBaseUrl()}/api/internal/ops-health`);
  if (alert) url.searchParams.set("alert", "1");

  // Resolved before the request so a missing credential is not reported as a
  // network failure.
  const token = getToken();

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    reportUnknown(asJson, {
      httpStatus: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    reportUnknown(asJson, {
      httpStatus: res.status,
      error: `non-JSON response: ${text.slice(0, 500)}`,
    });
  }

  // A missing or unrecognized status means the request never reached the health
  // logic (auth, routing, misconfiguration) — that is a blind check, not a
  // verdict. Checked before printing so --json emits exactly one document.
  const reported = body["status"];
  if (reported !== "ok" && reported !== "warn" && reported !== "critical") {
    reportUnknown(asJson, {
      httpStatus: res.status,
      error: String(
        body["error"] ??
          (reported === undefined
            ? "response contained no status"
            : `unrecognized status: ${String(reported)}`),
      ),
      body,
    });
  }

  if (asJson) {
    console.log(JSON.stringify(body, null, 2));
  } else {
    const summary = String(body["summary"] ?? "");
    console.log(`status: ${reported}`);
    console.log(`summary: ${summary}`);
    if (typeof body["agentBrief"] === "string") {
      console.log("");
      console.log(body["agentBrief"]);
    }
    if (body["delivery"]) {
      console.log("");
      console.log("delivery:", JSON.stringify(body["delivery"]));
    }
  }

  if (reported === "critical") process.exit(EXIT_CRITICAL);
  if (reported === "warn") process.exit(EXIT_WARN);
  process.exit(EXIT_OK);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(EXIT_UNKNOWN);
});
