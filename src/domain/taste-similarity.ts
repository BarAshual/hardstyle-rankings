/** A formula change requires a new algorithm ID, never a vote-version change. */
export const TASTE_SIMILARITY_ALGORITHM = "taste-love-v1";

export type TasteChoice = "PASS" | "LIKE" | "SUPER_LIKE";

/** Caller-supplied eligibility for exactly one season; IDs are opaque identities. */
export interface EligibleTasteTracks {
  readonly seasonId: string;
  readonly trackIds: readonly string[];
}

/** One member's current choices in one season, not an action/audit history. */
export interface CurrentTasteBallot {
  readonly seasonId: string;
  readonly choices: readonly {
    readonly trackId: string;
    readonly choice: TasteChoice;
  }[];
}

/** Evidence computed from eligible co-rated tracks in exactly one season. */
export interface TasteSimilarityCounts {
  readonly seasonId: string;
  readonly coRatedCount: number;
  readonly loveIntersectionCount: number;
  readonly loveUnionCount: number;
  readonly slIntersectionCount: number;
  readonly slUnionCount: number;
}

export type TasteOverlap = {
  readonly intersectionCount: number;
  readonly unionCount: number;
} & (
  | { readonly value: number; readonly reason?: never }
  | { readonly value: undefined; readonly reason: "empty_union" }
);

export type TasteScore =
  | { readonly value: number; readonly reason?: never }
  | { readonly value: undefined; readonly reason: "undefined_overlap" };

export interface TasteSimilarityResult {
  readonly algorithm: typeof TASTE_SIMILARITY_ALGORITHM;
  readonly seasonId: string;
  readonly coRatedCount: number;
  readonly loveOverlap: TasteOverlap;
  readonly slOverlap: TasteOverlap;
  readonly score: TasteScore;
}

function currentChoices(ballot: CurrentTasteBallot): Map<string, TasteChoice> {
  const choices = new Map<string, TasteChoice>();
  for (const { trackId, choice } of ballot.choices) {
    // Validate the whole ballot, including choices outside the comparison set.
    if (choices.has(trackId)) {
      throw new Error("Duplicate current choice for a track.");
    }
    if (choice !== "PASS" && choice !== "LIKE" && choice !== "SUPER_LIKE") {
      throw new Error("Invalid current choice.");
    }
    choices.set(trackId, choice);
  }
  return choices;
}

function overlap(intersectionCount: number, unionCount: number): TasteOverlap {
  if (unionCount === 0) {
    return {
      intersectionCount,
      unionCount,
      value: undefined,
      reason: "empty_union",
    };
  }
  return {
    intersectionCount,
    unionCount,
    value: intersectionCount / unionCount,
  };
}

/**
 * Shared formula for ballot calculations and authorized server evidence counts.
 * Counts must be nonnegative safe integers consistent with SL being a subset of
 * love and all evidence belonging to the same co-rated comparison set. This
 * validates evidence shape only; authorization remains at the server boundary.
 */
export function calculateTasteSimilarityFromCounts(
  counts: TasteSimilarityCounts,
): TasteSimilarityResult {
  if (!counts.seasonId.trim()) {
    throw new Error("An explicit season ID is required.");
  }
  const {
    coRatedCount,
    loveIntersectionCount,
    loveUnionCount,
    slIntersectionCount,
    slUnionCount,
  } = counts;
  if (
    ![
      coRatedCount,
      loveIntersectionCount,
      loveUnionCount,
      slIntersectionCount,
      slUnionCount,
    ].every((count) => Number.isSafeInteger(count) && count >= 0)
  ) {
    throw new Error("Evidence counts must be nonnegative safe integers.");
  }
  if (
    loveIntersectionCount > loveUnionCount ||
    loveUnionCount > coRatedCount ||
    slIntersectionCount > slUnionCount ||
    slUnionCount > loveUnionCount ||
    slIntersectionCount > loveIntersectionCount
  ) {
    throw new Error("Evidence counts are inconsistent.");
  }
  const loveOverlap = overlap(loveIntersectionCount, loveUnionCount);
  const slOverlap = overlap(slIntersectionCount, slUnionCount);
  const score: TasteScore =
    loveOverlap.value === undefined || slOverlap.value === undefined
      ? { value: undefined, reason: "undefined_overlap" }
      : { value: 0.75 * loveOverlap.value + 0.25 * slOverlap.value };

  return {
    algorithm: TASTE_SIMILARITY_ALGORITHM,
    seasonId: counts.seasonId,
    coRatedCount,
    loveOverlap,
    slOverlap,
    score,
  };
}

/**
 * Both overlaps use eligible tracks rated by BOTH members in the supplied season.
 * LIKE and SUPER_LIKE form the loved set; SUPER_LIKE also forms the favorites set.
 * All values use 0–1 without rounding: score = 0.75 * love + 0.25 * SL.
 * An empty union has no value. If either overlap is undefined, score is undefined;
 * inspect each overlap's reason for the cause. No fallback or reweighting is used.
 *
 * Repeated eligible IDs have set semantics. Duplicate ballot rows (even identical
 * or ineligible ones) and mismatched seasons throw; edits must replace current
 * choices. Missing ratings stay missing, and distinct recording IDs stay separate.
 * The caller supplies eligibility and current state. This pure function provides
 * no data access, lifecycle/category authorization, presentation, or award policy.
 */
export function calculateTasteSimilarity(
  eligible: EligibleTasteTracks,
  first: CurrentTasteBallot,
  second: CurrentTasteBallot,
): TasteSimilarityResult {
  if (!eligible.seasonId.trim()) {
    throw new Error("An explicit season ID is required.");
  }
  if (
    first.seasonId !== eligible.seasonId ||
    second.seasonId !== eligible.seasonId
  ) {
    throw new Error("Season IDs must match the eligible catalog.");
  }
  const firstChoices = currentChoices(first);
  const secondChoices = currentChoices(second);
  let coRatedCount = 0;
  let loveIntersection = 0;
  let loveUnion = 0;
  let slIntersection = 0;
  let slUnion = 0;

  for (const trackId of new Set(eligible.trackIds)) {
    const a = firstChoices.get(trackId);
    const b = secondChoices.get(trackId);
    if (a === undefined || b === undefined) continue;
    coRatedCount += 1;
    const aLoves = a === "LIKE" || a === "SUPER_LIKE";
    const bLoves = b === "LIKE" || b === "SUPER_LIKE";
    if (aLoves && bLoves) loveIntersection += 1;
    if (aLoves || bLoves) loveUnion += 1;
    if (a === "SUPER_LIKE" && b === "SUPER_LIKE") slIntersection += 1;
    if (a === "SUPER_LIKE" || b === "SUPER_LIKE") slUnion += 1;
  }

  return calculateTasteSimilarityFromCounts({
    seasonId: eligible.seasonId,
    coRatedCount,
    loveIntersectionCount: loveIntersection,
    loveUnionCount: loveUnion,
    slIntersectionCount: slIntersection,
    slUnionCount: slUnion,
  });
}
