import { uuidPattern, type Track, type API, type VoteAction } from "./api";

export type PendingVote = { action: VoteAction; track: Track };
const prefix = "hardstyle.vote.v1:";
const scope = (user: string, season: string) => `${prefix}${user}:${season}:`;
const key = (a: VoteAction) => `${scope(a.user_id, a.season_id)}${a.action_id}`;

// One record per action prevents another tab overwriting an uncertain submission.
// This is a retry journal, never an authority for membership, votes, or progress.
export function savePending(pending: PendingVote) {
  localStorage.setItem(key(pending.action), JSON.stringify(pending));
}
export function removePending(action: VoteAction) {
  localStorage.removeItem(key(action));
}
export function readPending(user: string, season: string): PendingVote | null {
  const keys = Object.keys(localStorage)
    .filter((k) => k.startsWith(scope(user, season)))
    .sort();
  if (!keys.length) return null;
  const pending: PendingVote = JSON.parse(localStorage.getItem(keys[0])!);
  const a = pending?.action;
  if (
    !a ||
    a.user_id !== user ||
    a.season_id !== season ||
    !uuidPattern.test(a.action_id) ||
    !uuidPattern.test(a.track_id) ||
    !Number.isInteger(a.expected_version) ||
    a.expected_version < 0 ||
    a.expected_version >= 2147483647 ||
    !["PASS", "LIKE", "SUPER_LIKE"].includes(a.choice) ||
    pending.track?.id !== a.track_id ||
    typeof pending.track.title !== "string" ||
    !Array.isArray(pending.track.artists) ||
    !pending.track.artists.every((n) => typeof n === "string") ||
    key(a) !== keys[0]
  )
    throw new Error("Invalid pending vote");
  return pending;
}

// Both rating and editing validate the same durable receipt, then remove only this action.
export async function confirmPending(api: API, pending: PendingVote) {
  const a = pending.action;
  const receipt = await api.castVote(a);
  if (
    receipt.action_id !== a.action_id ||
    receipt.season_id !== a.season_id ||
    receipt.track_id !== a.track_id ||
    receipt.choice !== a.choice ||
    receipt.version !== a.expected_version + 1
  )
    throw new Error("Unexpected vote receipt");
  removePending(a);
}
