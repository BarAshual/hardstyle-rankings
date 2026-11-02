import {
  uuidPattern,
  type AdminSeason,
  type Season,
  type VisibilityAction,
} from "./api";

export const seasonStates = ["SETUP", "VOTING", "LOCKED", "REVEAL"] as const;
export function nextSeasonState(
  state: Season["state"],
): Season["state"] | undefined {
  return seasonStates[seasonStates.indexOf(state) + 1];
}
export type LifecycleAction = {
  kind: "lifecycle";
  userId: string;
  seasonId: string;
  // Local recovery marker only: transition_season has NO action UUID argument.
  actionId: string;
  from: Season["state"];
  to: Season["state"];
};
export type PendingAdmin = VisibilityAction | LifecycleAction;
const prefix = "hardstyle.admin.v1:";
export const adminScope = (user: string, season: string) =>
  `${prefix}${user}:${season}:`;
const key = (a: PendingAdmin) =>
  `${adminScope(a.userId, a.seasonId)}${a.actionId}`;

// Per-action keys cannot overwrite another tab's unresolved request. The journal
// carries only operational intent, never authority or cached server state.
export function saveAdminPending(action: PendingAdmin) {
  localStorage.setItem(key(action), JSON.stringify(action));
}
export function removeAdminPending(action: PendingAdmin) {
  localStorage.removeItem(key(action));
}
export function readAdminPending(user: string, season: string): PendingAdmin[] {
  return Object.keys(localStorage)
    .filter((k) => k.startsWith(adminScope(user, season)))
    .sort()
    .map((k) => {
      const a = JSON.parse(localStorage.getItem(k)!);
      if (
        !a ||
        a.userId !== user ||
        a.seasonId !== season ||
        typeof a.actionId !== "string" ||
        !uuidPattern.test(a.actionId) ||
        key(a) !== k ||
        !(a.kind === "visibility"
          ? typeof a.visible === "boolean"
          : a.kind === "lifecycle" &&
            seasonStates.includes(a.from) &&
            nextSeasonState(a.from) === a.to &&
            a.to !== undefined)
      ) {
        throw new Error("Invalid saved admin action");
      }
      // Reconstruct the exact allowed payload; storage cannot add RPC parameters.
      const base = { userId: user, seasonId: season, actionId: a.actionId };
      return a.kind === "visibility"
        ? { ...base, kind: "visibility", visible: a.visible }
        : { ...base, kind: "lifecycle", from: a.from, to: a.to };
    });
}
export function validateAdminSeason(
  value: AdminSeason,
  seasonId: string,
): AdminSeason {
  if (
    !value ||
    value.seasonId !== seasonId ||
    value.category !== "love_similarity" ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    !seasonStates.includes(value.state) ||
    typeof value.visible !== "boolean" ||
    value.canChange !== (value.state === "REVEAL")
  )
    throw new Error("Invalid admin metadata");
  return value;
}
export function validateVisibilityReceipt(
  value: unknown,
  action: VisibilityAction,
) {
  if (!value || typeof value !== "object")
    throw new Error("Invalid visibility receipt");
  const r = value as Record<string, unknown>;
  if (
    r.seasonId !== action.seasonId ||
    r.category !== "love_similarity" ||
    r.actionId !== action.actionId ||
    r.visible !== action.visible ||
    typeof r.changedAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT/.test(r.changedAt) ||
    !Number.isFinite(Date.parse(r.changedAt))
  ) {
    throw new Error("Invalid visibility receipt");
  }
}
export function adminDenied(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const e = error as { message?: string; code?: string };
  return (
    ["authentication_required", "season_admin_required"].includes(
      e.message ?? "",
    ) || ["42501", "PGRST301", "PGRST303"].includes(e.code ?? "")
  );
}
export function visibilityRejected(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const e = error as { message?: string; code?: string };
  // Only explicit server rejections may discard intent without a receipt.
  return (
    (e.code === "P0001" &&
      ["results_require_reveal", "action_payload_conflict"].includes(
        e.message ?? "",
      )) ||
    (e.code === "22023" && e.message === "invalid_result_visibility_payload")
  );
}
