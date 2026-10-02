import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import {
  BULLHORN_REFRESH_LEASE_MS,
  BULLHORN_REFRESH_SAVE_BACKOFF_MS,
  BULLHORN_REFRESH_SAVE_BUDGET_MS,
} from "./bullhorn-refresh-limits.js";

export type RefreshSubjectKind = "firm" | "user";
export type RefreshOutcome =
  | "idle"
  | "claimed"
  | "success"
  | "needs_reauth"
  | "uncertain";
export type NoticeState = "idle" | "claimed" | "accepted" | "failed" | "unknown";

type Flight<T> = {
  id: string;
  promise: Promise<T>;
};

const flights = new Map<string, Flight<unknown>>();

function flightKey(kind: RefreshSubjectKind, id: string): string {
  return `${kind}:${id}`;
}

export function refreshFlightKey(kind: RefreshSubjectKind, id: string): string {
  return flightKey(kind, id);
}

/**
 * Registers the in-process flight before the work factory is allowed to await.
 * Cleanup is identity-guarded so a late finally cannot remove a newer flight.
 */
export function runInProcessRefreshFlight<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const existing = flights.get(key) as Flight<T> | undefined;
  if (existing) return existing.promise;

  const flight: Flight<T> = {
    id: randomUUID(),
    promise: Promise.resolve().then(work),
  };
  flights.set(key, flight as Flight<unknown>);
  const cleanup = () => {
    if (flights.get(key)?.id === flight.id) {
      flights.delete(key);
    }
  };
  void flight.promise.then(cleanup, cleanup);
  return flight.promise;
}

type SubjectSql = {
  table: "bullhorn_tokens" | "users";
  idColumn: "firm_id" | "id";
  generationColumn: "refresh_generation" | "bullhorn_refresh_generation";
  outcomeColumn: "refresh_outcome" | "bullhorn_refresh_outcome";
  attemptColumn: "refresh_attempt_id" | "bullhorn_refresh_attempt_id";
  leaseColumn: "refresh_lease_expires_at" | "bullhorn_refresh_lease_expires_at";
  uncertainColumn: "refresh_uncertain_at" | "bullhorn_refresh_uncertain_at";
  noticeStateColumn: "reconnect_notice_state" | "bullhorn_reconnect_notice_state";
  noticeAttemptColumn:
    | "reconnect_notice_attempt_id"
    | "bullhorn_reconnect_notice_attempt_id";
  noticeClaimedColumn:
    | "reconnect_notice_claimed_at"
    | "bullhorn_reconnect_notice_claimed_at";
  noticeCompletedColumn:
    | "reconnect_notice_completed_at"
    | "bullhorn_reconnect_notice_completed_at";
  noticeErrorColumn: "reconnect_notice_error" | "bullhorn_reconnect_notice_error";
};

function subjectSql(kind: RefreshSubjectKind): SubjectSql {
  if (kind === "firm") {
    return {
      table: "bullhorn_tokens",
      idColumn: "firm_id",
      generationColumn: "refresh_generation",
      outcomeColumn: "refresh_outcome",
      attemptColumn: "refresh_attempt_id",
      leaseColumn: "refresh_lease_expires_at",
      uncertainColumn: "refresh_uncertain_at",
      noticeStateColumn: "reconnect_notice_state",
      noticeAttemptColumn: "reconnect_notice_attempt_id",
      noticeClaimedColumn: "reconnect_notice_claimed_at",
      noticeCompletedColumn: "reconnect_notice_completed_at",
      noticeErrorColumn: "reconnect_notice_error",
    };
  }
  return {
    table: "users",
    idColumn: "id",
    generationColumn: "bullhorn_refresh_generation",
    outcomeColumn: "bullhorn_refresh_outcome",
    attemptColumn: "bullhorn_refresh_attempt_id",
    leaseColumn: "bullhorn_refresh_lease_expires_at",
    uncertainColumn: "bullhorn_refresh_uncertain_at",
    noticeStateColumn: "bullhorn_reconnect_notice_state",
    noticeAttemptColumn: "bullhorn_reconnect_notice_attempt_id",
    noticeClaimedColumn: "bullhorn_reconnect_notice_claimed_at",
    noticeCompletedColumn: "bullhorn_reconnect_notice_completed_at",
    noticeErrorColumn: "bullhorn_reconnect_notice_error",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function currentRefreshGeneration(
  kind: RefreshSubjectKind,
  id: string,
): Promise<number | null> {
  const s = subjectSql(kind);
  const result = await pool.query<{ generation: number }>(
    `SELECT ${s.generationColumn} AS generation FROM ${s.table} WHERE ${s.idColumn} = $1 LIMIT 1`,
    [id],
  );
  return result.rows[0]?.generation ?? null;
}

export async function markExpiredRefreshLease(
  kind: RefreshSubjectKind,
  id: string,
  now = new Date(),
): Promise<boolean> {
  const s = subjectSql(kind);
  const firmSet =
    kind === "firm"
      ? "auth_healthy = false, last_auth_error_at = $2, last_auth_error = COALESCE(last_auth_error, 'refresh lease expired before completion'),"
      : "";
  const result = await pool.query(
    `
      UPDATE ${s.table}
      SET ${s.outcomeColumn} = 'uncertain',
          ${s.uncertainColumn} = COALESCE(${s.uncertainColumn}, $2),
          ${s.leaseColumn} = NULL,
          ${firmSet}
          updated_at = $2
      WHERE ${s.idColumn} = $1
        AND ${s.outcomeColumn} = 'claimed'
        AND ${s.leaseColumn} IS NOT NULL
        AND ${s.leaseColumn} <= $2
    `,
    [id, now],
  );
  return result.rowCount === 1;
}

export async function claimRefreshAttempt(opts: {
  kind: RefreshSubjectKind;
  id: string;
  attemptId: string;
  expectedGeneration: number;
  expectedEncryptedRefreshToken: string;
  now?: Date;
}): Promise<boolean> {
  const s = subjectSql(opts.kind);
  const now = opts.now ?? new Date();
  await markExpiredRefreshLease(opts.kind, opts.id, now);
  const leaseExpiresAt = new Date(now.getTime() + BULLHORN_REFRESH_LEASE_MS);
  const result = await pool.query(
    `
      UPDATE ${s.table}
      SET ${s.outcomeColumn} = 'claimed',
          ${s.attemptColumn} = $2,
          ${s.leaseColumn} = $5,
          ${s.uncertainColumn} = NULL,
          updated_at = $4
      WHERE ${s.idColumn} = $1
        AND refresh_token = $3
        AND ${s.generationColumn} = $6
        AND ${s.outcomeColumn} IN ('idle', 'success')
        AND ${s.attemptColumn} IS NULL
        AND ${s.leaseColumn} IS NULL
    `,
    [
      opts.id,
      opts.attemptId,
      opts.expectedEncryptedRefreshToken,
      now,
      leaseExpiresAt,
      opts.expectedGeneration,
    ],
  );
  return result.rowCount === 1;
}

export async function persistRefreshUncertain(opts: {
  kind: RefreshSubjectKind;
  id: string;
  attemptId: string;
  expectedGeneration: number;
  now?: Date;
  error?: string;
}): Promise<boolean> {
  const s = subjectSql(opts.kind);
  const now = opts.now ?? new Date();
  const error = opts.error?.slice(0, 2000) ?? null;
  const firmSet =
    opts.kind === "firm"
      ? "auth_healthy = false, last_auth_error_at = $4, last_auth_error = COALESCE($5, last_auth_error),"
      : "";
  const result = await pool.query(
    `
      UPDATE ${s.table}
      SET ${s.outcomeColumn} = 'uncertain',
          ${s.uncertainColumn} = $4,
          ${s.leaseColumn} = NULL,
          ${firmSet}
          updated_at = $4
      WHERE ${s.idColumn} = $1
        AND ${s.attemptColumn} = $2
        AND ${s.generationColumn} = $3
    `,
    opts.kind === "firm"
      ? [opts.id, opts.attemptId, opts.expectedGeneration, now, error]
      : [opts.id, opts.attemptId, opts.expectedGeneration, now],
  );
  return result.rowCount === 1;
}

export async function persistDefinitiveInvalidGrant(opts: {
  kind: RefreshSubjectKind;
  id: string;
  attemptId: string;
  expectedGeneration: number;
  error: string;
  now?: Date;
}): Promise<boolean> {
  const s = subjectSql(opts.kind);
  const now = opts.now ?? new Date();
  const firmSet =
    opts.kind === "firm"
      ? "auth_healthy = false, last_auth_error_at = $4, last_auth_error = $5,"
      : "";
  const result = await pool.query(
    `
      UPDATE ${s.table}
      SET ${s.outcomeColumn} = 'needs_reauth',
          ${s.leaseColumn} = NULL,
          ${s.uncertainColumn} = NULL,
          ${firmSet}
          updated_at = $4
      WHERE ${s.idColumn} = $1
        AND ${s.attemptColumn} = $2
        AND ${s.generationColumn} = $3
        AND ${s.outcomeColumn} = 'claimed'
    `,
    opts.kind === "firm"
      ? [opts.id, opts.attemptId, opts.expectedGeneration, now, opts.error.slice(0, 2000)]
      : [opts.id, opts.attemptId, opts.expectedGeneration, now],
  );
  return result.rowCount === 1;
}

export async function persistRefreshTokenSuccess(opts: {
  kind: RefreshSubjectKind;
  id: string;
  attemptId: string;
  expectedGeneration: number;
  expectedEncryptedRefreshToken: string;
  replacementEncryptedRefreshToken: string;
  now?: Date;
}): Promise<{ saved: boolean; generation: number; identicalCommitted: boolean }> {
  const s = subjectSql(opts.kind);
  const now = opts.now ?? new Date();
  const newGeneration = opts.expectedGeneration + 1;
  const startedAt = Date.now();

  for (let i = 0; i < BULLHORN_REFRESH_SAVE_BACKOFF_MS.length; i++) {
    const delay = BULLHORN_REFRESH_SAVE_BACKOFF_MS[i]!;
    const elapsed = Date.now() - startedAt;
    if (elapsed + delay > BULLHORN_REFRESH_SAVE_BUDGET_MS) break;
    if (delay > 0) await sleep(delay);

    try {
      const firmSet =
        opts.kind === "firm"
          ? "auth_healthy = true, last_auth_error_at = NULL, last_auth_error = NULL,"
          : "";
      const result = await pool.query(
        `
          UPDATE ${s.table}
          SET refresh_token = $4,
              ${s.generationColumn} = $7,
              ${s.outcomeColumn} = 'success',
              ${s.attemptColumn} = NULL,
              ${s.leaseColumn} = NULL,
              ${s.uncertainColumn} = NULL,
              ${firmSet}
              updated_at = $6
          WHERE ${s.idColumn} = $1
            AND refresh_token = $5
            AND ${s.generationColumn} = $3
            AND ${s.attemptColumn} = $2
            AND ${s.outcomeColumn} IN ('claimed', 'uncertain')
        `,
        [
          opts.id,
          opts.attemptId,
          opts.expectedGeneration,
          opts.replacementEncryptedRefreshToken,
          opts.expectedEncryptedRefreshToken,
          now,
          newGeneration,
        ],
      );
      if (result.rowCount === 1) {
        return { saved: true, generation: newGeneration, identicalCommitted: false };
      }

      const identical = await pool.query(
        `
          SELECT 1
          FROM ${s.table}
          WHERE ${s.idColumn} = $1
            AND refresh_token = $2
            AND ${s.generationColumn} = $3
            AND ${s.outcomeColumn} = 'success'
            AND ${s.attemptColumn} IS NULL
          LIMIT 1
        `,
        [opts.id, opts.replacementEncryptedRefreshToken, newGeneration],
      );
      if (identical.rowCount === 1) {
        return { saved: true, generation: newGeneration, identicalCommitted: true };
      }
    } catch (err) {
      if (Date.now() - startedAt >= BULLHORN_REFRESH_SAVE_BUDGET_MS) {
        await persistRefreshUncertain({
          kind: opts.kind,
          id: opts.id,
          attemptId: opts.attemptId,
          expectedGeneration: opts.expectedGeneration,
          now,
          error: err instanceof Error ? err.message : String(err),
        });
        return { saved: false, generation: opts.expectedGeneration, identicalCommitted: false };
      }
    }

    if (Date.now() - startedAt >= BULLHORN_REFRESH_SAVE_BUDGET_MS) break;
  }

  await persistRefreshUncertain({
    kind: opts.kind,
    id: opts.id,
    attemptId: opts.attemptId,
    expectedGeneration: opts.expectedGeneration,
    now,
    error: "conditional refresh-token save exhausted retry budget",
  });
  return { saved: false, generation: opts.expectedGeneration, identicalCommitted: false };
}

export async function updateFirmSessionAfterRefresh(opts: {
  firmId: string;
  generation: number;
  restUrl: string;
  loginUrl: string | null;
  now?: Date;
}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const result = await pool.query(
    `
      UPDATE bullhorn_tokens
      SET rest_url = $3,
          login_url = COALESCE($4, login_url),
          updated_at = $5
      WHERE firm_id = $1
        AND refresh_generation = $2
    `,
    [opts.firmId, opts.generation, opts.restUrl, opts.loginUrl, now],
  );
  return result.rowCount === 1;
}

export async function updateUserSessionAfterRefresh(opts: {
  userId: string;
  generation: number;
  bhRestToken: string;
  restUrl: string;
  tokenExpiresAt: number;
  sessionExpiresAt: number;
  now?: Date;
}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const result = await pool.query(
    `
      UPDATE users
      SET bh_rest_token = $3,
          rest_url = $4,
          token_expires_at = $5,
          session_expires_at = $6,
          updated_at = $7
      WHERE id = $1
        AND bullhorn_refresh_generation = $2
    `,
    [
      opts.userId,
      opts.generation,
      opts.bhRestToken,
      opts.restUrl,
      opts.tokenExpiresAt,
      opts.sessionExpiresAt,
      now,
    ],
  );
  return result.rowCount === 1;
}

export async function supersedeWithReconnect(opts: {
  kind: RefreshSubjectKind;
  id: string;
  expectedGeneration: number;
  encryptedRefreshToken: string;
  now?: Date;
  firm?: {
    oauthUrl: string;
    restUrl: string;
    loginUrl: string | null;
    authMode: "service" | "oauth";
  };
  user?: {
    bhRestToken: string;
    restUrl: string;
    tokenExpiresAt: number;
    sessionExpiresAt: number;
  };
}): Promise<{ saved: boolean; generation: number }> {
  const now = opts.now ?? new Date();
  const newGeneration = opts.expectedGeneration + 1;
  if (opts.kind === "firm") {
    const result = await pool.query(
      `
        UPDATE bullhorn_tokens
        SET refresh_token = $3,
            refresh_generation = $4,
            refresh_outcome = 'success',
            refresh_attempt_id = NULL,
            refresh_lease_expires_at = NULL,
            refresh_uncertain_at = NULL,
            oauth_url = $5,
            rest_url = $6,
            login_url = COALESCE($7, login_url),
            auth_healthy = true,
            last_auth_error_at = NULL,
            last_auth_error = NULL,
            reconnect_notice_state = 'idle',
            reconnect_notice_attempt_id = NULL,
            reconnect_notice_claimed_at = NULL,
            reconnect_notice_completed_at = NULL,
            reconnect_notice_error = NULL,
            connected_at = $8,
            updated_at = $8
        WHERE firm_id = $1
          AND refresh_generation = $2
      `,
      [
        opts.id,
        opts.expectedGeneration,
        opts.encryptedRefreshToken,
        newGeneration,
        opts.firm!.oauthUrl,
        opts.firm!.restUrl,
        opts.firm!.loginUrl,
        now,
      ],
    );
    return { saved: result.rowCount === 1, generation: newGeneration };
  }

  const result = await pool.query(
    `
      UPDATE users
      SET refresh_token = $3,
          bullhorn_refresh_generation = $4,
          bullhorn_refresh_outcome = 'success',
          bullhorn_refresh_attempt_id = NULL,
          bullhorn_refresh_lease_expires_at = NULL,
          bullhorn_refresh_uncertain_at = NULL,
          bh_rest_token = $5,
          rest_url = $6,
          token_expires_at = $7,
          session_expires_at = $8,
          bullhorn_reconnect_notice_state = 'idle',
          bullhorn_reconnect_notice_attempt_id = NULL,
          bullhorn_reconnect_notice_claimed_at = NULL,
          bullhorn_reconnect_notice_completed_at = NULL,
          bullhorn_reconnect_notice_error = NULL,
          updated_at = $9
      WHERE id = $1
        AND bullhorn_refresh_generation = $2
    `,
    [
      opts.id,
      opts.expectedGeneration,
      opts.encryptedRefreshToken,
      newGeneration,
      opts.user!.bhRestToken,
      opts.user!.restUrl,
      opts.user!.tokenExpiresAt,
      opts.user!.sessionExpiresAt,
      now,
    ],
  );
  return { saved: result.rowCount === 1, generation: newGeneration };
}

export async function persistReconnectTokenBeforeLogin(opts: {
  kind: RefreshSubjectKind;
  id: string;
  expectedGeneration: number;
  encryptedRefreshToken: string;
  expectedFirmId?: string | null;
  now?: Date;
  claimedState?: { state: string; attemptId: string };
  firm?: {
    oauthUrl: string;
    loginUrl: string | null;
    authMode: "service" | "oauth";
    allowInsert?: boolean;
  };
}): Promise<{ saved: boolean; generation: number }> {
  const now = opts.now ?? new Date();
  const generation = opts.expectedGeneration + 1;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let rowCount = 0;

    if (opts.kind === "firm") {
      const update = await client.query(
        `
          UPDATE bullhorn_tokens
          SET refresh_token = $3,
              refresh_generation = $4,
              refresh_outcome = 'success',
              refresh_attempt_id = NULL,
              refresh_lease_expires_at = NULL,
              refresh_uncertain_at = NULL,
              oauth_url = $5,
              login_url = COALESCE($6, login_url),
              auth_healthy = true,
              last_auth_error_at = NULL,
              last_auth_error = NULL,
              reconnect_notice_state = 'idle',
              reconnect_notice_attempt_id = NULL,
              reconnect_notice_claimed_at = NULL,
              reconnect_notice_completed_at = NULL,
              reconnect_notice_error = NULL,
              connected_at = $7,
              updated_at = $7
          WHERE firm_id = $1
            AND refresh_generation = $2
        `,
        [
          opts.id,
          opts.expectedGeneration,
          opts.encryptedRefreshToken,
          generation,
          opts.firm!.oauthUrl,
          opts.firm!.loginUrl,
          now,
        ],
      );
      rowCount = update.rowCount ?? 0;

      if (rowCount === 0 && opts.firm?.allowInsert && opts.expectedGeneration === 0) {
        const insert = await client.query(
          `
            INSERT INTO bullhorn_tokens (
              id,
              firm_id,
              refresh_token,
              oauth_url,
              login_url,
              auth_mode,
              auth_healthy,
              refresh_generation,
              refresh_outcome,
              connected_at,
              updated_at
            )
            VALUES ($1, $1, $2, $3, $4, $5, true, $6, 'success', $7, $7)
            ON CONFLICT DO NOTHING
          `,
          [
            opts.id,
            opts.encryptedRefreshToken,
            opts.firm.oauthUrl,
            opts.firm.loginUrl,
            opts.firm.authMode,
            generation,
            now,
          ],
        );
        rowCount = insert.rowCount ?? 0;
      }
    } else {
      const update = await client.query(
        `
          UPDATE users
          SET refresh_token = $3,
              bullhorn_refresh_generation = $4,
              bullhorn_refresh_outcome = 'success',
              bullhorn_refresh_attempt_id = NULL,
              bullhorn_refresh_lease_expires_at = NULL,
              bullhorn_refresh_uncertain_at = NULL,
              bullhorn_reconnect_notice_state = 'idle',
              bullhorn_reconnect_notice_attempt_id = NULL,
              bullhorn_reconnect_notice_claimed_at = NULL,
              bullhorn_reconnect_notice_completed_at = NULL,
              bullhorn_reconnect_notice_error = NULL,
              updated_at = $5
          WHERE id = $1
            AND bullhorn_refresh_generation = $2
            AND firm_id IS NOT DISTINCT FROM $6
        `,
        [
          opts.id,
          opts.expectedGeneration,
          opts.encryptedRefreshToken,
          generation,
          now,
          opts.expectedFirmId ?? null,
        ],
      );
      rowCount = update.rowCount ?? 0;
    }

    if (rowCount === 1 && opts.claimedState) {
      const deleted = await client.query(
        `
          DELETE FROM oauth_states
          WHERE state = $1
            AND claim_attempt_id = $2
        `,
        [opts.claimedState.state, opts.claimedState.attemptId],
      );
      if (deleted.rowCount !== 1) rowCount = 0;
    }

    if (rowCount === 1) {
      await client.query("COMMIT");
      return { saved: true, generation };
    }

    await client.query("ROLLBACK");
    return { saved: false, generation };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function claimReconnectNotice(opts: {
  kind: RefreshSubjectKind;
  id: string;
  expectedGeneration: number;
  attemptId: string;
  now?: Date;
}): Promise<boolean> {
  const s = subjectSql(opts.kind);
  const now = opts.now ?? new Date();
  const result = await pool.query(
    `
      UPDATE ${s.table}
      SET ${s.noticeStateColumn} = 'claimed',
          ${s.noticeAttemptColumn} = $2,
          ${s.noticeClaimedColumn} = $4,
          ${s.noticeCompletedColumn} = NULL,
          ${s.noticeErrorColumn} = NULL,
          updated_at = $4
      WHERE ${s.idColumn} = $1
        AND ${s.generationColumn} = $3
        AND ${s.noticeStateColumn} IN ('idle', 'failed')
    `,
    [opts.id, opts.attemptId, opts.expectedGeneration, now],
  );
  return result.rowCount === 1;
}

export async function completeReconnectNotice(opts: {
  kind: RefreshSubjectKind;
  id: string;
  expectedGeneration: number;
  attemptId: string;
  state: Exclude<NoticeState, "idle" | "claimed">;
  error?: string;
  now?: Date;
}): Promise<boolean> {
  const s = subjectSql(opts.kind);
  const now = opts.now ?? new Date();
  const result = await pool.query(
    `
      UPDATE ${s.table}
      SET ${s.noticeStateColumn} = $4,
          ${s.noticeCompletedColumn} = $5,
          ${s.noticeErrorColumn} = $6,
          updated_at = $5
      WHERE ${s.idColumn} = $1
        AND ${s.generationColumn} = $3
        AND ${s.noticeAttemptColumn} = $2
        AND ${s.noticeStateColumn} = 'claimed'
    `,
    [
      opts.id,
      opts.attemptId,
      opts.expectedGeneration,
      opts.state,
      now,
      opts.error?.slice(0, 2000) ?? null,
    ],
  );
  return result.rowCount === 1;
}
