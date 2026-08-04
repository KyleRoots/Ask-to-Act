/**
 * Universal soft-wall → async job contract (host-complete).
 *
 * Sync paths keep channel-realism soft walls (~95s). On stopReason=wall_time,
 * every tool that opts in returns machine-readable asyncContinuation with BOTH
 * MCP start/poll tool names AND REST start/poll paths. Poll is shared:
 * get_report_job / GET /reports/jobs/{jobId}. Jobs persist in report_jobs.
 *
 * Sync TOPN/EXHAUSTIVE scout walls stay in scout-screen.ts and must not rise.
 */

/** Hard safety max for in-process async report jobs (no ChatGPT soft wall). */
export const ASYNC_REPORT_WALL_MS = 20 * 60 * 1000;

/**
 * Default sync soft wall for non-scout long walks (same channel realism as
 * scout top-N). Do not raise — gateway ~120s 504s.
 */
export const SYNC_SOFT_WALL_MS = 95_000;

/** Shared poll path for all async report_jobs (relative to /api/v1). */
export const ASYNC_POLL_REST = {
  method: "GET" as const,
  pathTemplate: "/reports/jobs/{jobId}",
} as const;

export type AsyncToolContinuationSpec = {
  /** MCP tool that starts the async job. */
  startTool: string;
  /** MCP poll tool — always get_report_job today. */
  pollTool?: string;
  /** REST start path relative to /api/v1 (POST). */
  restStartPath: string;
  /** Extra host guidance appended to the standard hint. */
  extraHint?: string;
};

export type AsyncContinuation = {
  tool: string;
  pollTool: string;
  rest: {
    start: { method: "POST"; path: string };
    poll: { method: "GET"; pathTemplate: string };
  };
  hint: string;
  resumeArgs?: Record<string, unknown>;
};

export function buildAsyncContinuationHint(
  spec: AsyncToolContinuationSpec,
): string {
  const pollTool = spec.pollTool ?? "get_report_job";
  const extra =
    spec.extraHint ??
    "Do NOT give up because of wall_time.";
  return (
    "Soft wall is channel realism, not a final answer. Continue with the same arguments via " +
    `MCP (${spec.startTool} → poll ${pollTool}) OR REST Actions ` +
    `(POST ${spec.restStartPath} → poll GET /reports/jobs/{jobId}; ` +
    "paths relative to /api/v1) until status is complete or failed. " +
    extra
  );
}

export function buildAsyncContinuation(
  spec: AsyncToolContinuationSpec,
  opts?: { resumeArgs?: Record<string, unknown> },
): AsyncContinuation {
  const pollTool = spec.pollTool ?? "get_report_job";
  return {
    tool: spec.startTool,
    pollTool,
    rest: {
      start: { method: "POST", path: spec.restStartPath },
      poll: { ...ASYNC_POLL_REST },
    },
    hint: buildAsyncContinuationHint(spec),
    ...(opts?.resumeArgs ? { resumeArgs: opts.resumeArgs } : {}),
  };
}

/**
 * Append host-complete asyncContinuation when stopReason === wall_time.
 * No-op for other stop reasons.
 */
export function withAsyncContinuationHint<T extends Record<string, unknown>>(
  result: T,
  spec: AsyncToolContinuationSpec,
  opts?: { resumeArgs?: Record<string, unknown> },
): T {
  if (result.stopReason !== "wall_time") return result;
  if (result.asyncContinuation) return result;

  const continuation = buildAsyncContinuation(spec, opts);
  const note = typeof result.note === "string" ? result.note : undefined;
  if (note && note.includes(spec.startTool)) {
    return {
      ...result,
      asyncContinuation: continuation,
    };
  }
  return {
    ...result,
    asyncContinuation: continuation,
    ...(note
      ? { note: `${note} ${continuation.hint}` }
      : { note: continuation.hint }),
  };
}

/** Scout dept report — first tool on this contract. */
export const SCOUT_ASYNC_SPEC: AsyncToolContinuationSpec = {
  startTool: "start_scout_dept_report_job",
  restStartPath: "/reports/scout-qualified-by-department/jobs",
  extraHint:
    "Do NOT fan out date windows. Do NOT give up because of wall_time.",
};

/** Match candidates for a job — sourcing fan-out. */
export const MATCH_ASYNC_SPEC: AsyncToolContinuationSpec = {
  startTool: "start_match_candidates_job",
  restStartPath: "/sourcing/match-candidates-for-job/jobs",
  extraHint:
    "Do NOT raise poolSize/limit yourself across many sync calls. Do NOT give up because of wall_time.",
};

/** Recruiter leaderboard — placement + per-recruiter count walk. */
export const RECRUITER_LEADERBOARD_ASYNC_SPEC: AsyncToolContinuationSpec = {
  startTool: "start_recruiter_leaderboard_job",
  restStartPath: "/reports/recruiter-leaderboard/jobs",
  extraHint: "Do NOT give up because of wall_time.",
};
