/**
 * Firm entitlement gate for live MCP / REST tools.
 *
 * Default OFF (`ENTITLEMENTS_ENFORCED` unset or not "1"/"true") so pilots keep
 * working without Stripe. When ON, uses firms.subscription_status — pilots set
 * to "active" via activate-pilot; paid firms will get the same via Stripe webhooks.
 *
 * Stripe plug-in later: keep assertFirmEntitled; enrich resolveFirmEntitlement
 * (live Stripe lookup / firm_entitlements table); then set ENTITLEMENTS_ENFORCED=1.
 * No Stripe keys required for this stub.
 */
import { stripeStorage } from "./stripe/storage.js";

export type FirmEntitlementStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "none";

export class FirmNotEntitledError extends Error {
  readonly statusCode = 402;
  readonly firmId: string;
  readonly entitlementStatus: FirmEntitlementStatus;

  constructor(firmId: string, entitlementStatus: FirmEntitlementStatus) {
    super(
      `Your firm's AskToAct subscription is not active (status: ${entitlementStatus}). ` +
        `Ask your administrator to complete billing setup before using the AI tools.`,
    );
    this.name = "FirmNotEntitledError";
    this.firmId = firmId;
    this.entitlementStatus = entitlementStatus;
  }
}

/** True when live-tool entitlement checks are enabled. Default: off. */
export function entitlementsEnforced(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env["ENTITLEMENTS_ENFORCED"];
  if (raw === undefined || raw.trim() === "") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function isEntitledSubscriptionStatus(
  status: FirmEntitlementStatus,
): boolean {
  return status === "active" || status === "trialing";
}

/**
 * Resolve whether a firm is entitled to use live AI tools.
 * Until Stripe is live, this is subscription_status on firms (pilot activate → active).
 */
export async function resolveFirmEntitlement(firmId: string): Promise<{
  entitled: boolean;
  status: FirmEntitlementStatus;
}> {
  const status = await stripeStorage.resolveFirmStatus(firmId);
  return {
    entitled: isEntitledSubscriptionStatus(status),
    status,
  };
}

/**
 * No-op when ENTITLEMENTS_ENFORCED is off.
 * When on, throws FirmNotEntitledError (HTTP 402) if not entitled.
 */
export async function assertFirmEntitled(firmId: string): Promise<void> {
  if (!entitlementsEnforced()) return;
  const { entitled, status } = await resolveFirmEntitlement(firmId);
  if (!entitled) {
    throw new FirmNotEntitledError(firmId, status);
  }
}
