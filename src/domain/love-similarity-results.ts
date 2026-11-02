import {
  calculateTasteSimilarityFromCounts,
  TASTE_SIMILARITY_ALGORITHM,
  type TasteOverlap,
  type TasteSimilarityCounts,
} from "./taste-similarity";

export interface LoveSimilarityMember {
  readonly memberId: string;
  readonly nickname: string;
}

/** The bounded get_love_similarity_results RPC response, without raw ballots. */
export interface LoveSimilarityPairCounts extends Omit<
  TasteSimilarityCounts,
  "seasonId"
> {
  readonly first: LoveSimilarityMember;
  readonly second: LoveSimilarityMember;
}

export interface LoveSimilarityCountsResponse {
  readonly seasonId: string;
  readonly algorithm: typeof TASTE_SIMILARITY_ALGORITHM;
  readonly pairs: readonly LoveSimilarityPairCounts[];
}

/** JSON retains an explicit null and reason for undefined values. */
export type LoveSimilarityOverlapDto = {
  readonly intersectionCount: number;
  readonly unionCount: number;
} & (
  | { readonly value: number; readonly reason?: never }
  | { readonly value: null; readonly reason: "empty_union" }
);

export type LoveSimilarityScoreDto =
  | { readonly value: number; readonly reason?: never }
  | { readonly value: null; readonly reason: "undefined_overlap" };

export interface LoveSimilarityPairDto {
  readonly first: LoveSimilarityMember;
  readonly second: LoveSimilarityMember;
  readonly coRatedCount: number;
  readonly loveOverlap: LoveSimilarityOverlapDto;
  readonly slOverlap: LoveSimilarityOverlapDto;
  readonly score: LoveSimilarityScoreDto;
}

export interface LoveSimilarityResultsDto {
  readonly seasonId: string;
  readonly algorithm: typeof TASTE_SIMILARITY_ALGORITHM;
  readonly pairs: readonly LoveSimilarityPairDto[];
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid love-similarity response.");
  }
  return value as Record<string, unknown>;
}

function member(value: unknown): LoveSimilarityMember {
  const input = record(value);
  if (
    typeof input.memberId !== "string" ||
    !input.memberId.trim() ||
    typeof input.nickname !== "string" ||
    !input.nickname.trim()
  ) {
    throw new Error("Invalid love-similarity member.");
  }
  return { memberId: input.memberId, nickname: input.nickname };
}

function count(value: unknown): number {
  if (typeof value !== "number") {
    throw new Error("Evidence counts must be nonnegative safe integers.");
  }
  return value;
}

function serializeOverlap(overlap: TasteOverlap): LoveSimilarityOverlapDto {
  return overlap.value === undefined
    ? { ...overlap, value: null }
    : { ...overlap };
}

/**
 * Convert only an authorized RPC response for the explicitly selected season.
 * This pure adapter performs no I/O and grants no access. The RPC must enforce
 * membership, REVEAL, and category visibility before returning any evidence.
 * No extra response fields survive this projection; values remain unrounded 0–1.
 * Defined values omit reason; undefined overlaps/score use null plus a reason.
 */
export function serializeLoveSimilarityResults(
  expectedSeasonId: string,
  response: unknown,
): LoveSimilarityResultsDto {
  if (!expectedSeasonId.trim()) {
    throw new Error("An explicit season ID is required.");
  }
  const input = record(response);
  if (input.seasonId !== expectedSeasonId) {
    throw new Error("Result season does not match the selected season.");
  }
  if (input.algorithm !== TASTE_SIMILARITY_ALGORITHM) {
    throw new Error("Unsupported love-similarity algorithm.");
  }
  if (!Array.isArray(input.pairs)) {
    throw new Error("Invalid love-similarity pairs.");
  }
  const seen = new Map<string, Set<string>>();
  const pairs = input.pairs.map((value): LoveSimilarityPairDto => {
    const pair = record(value);
    const first = member(pair.first);
    const second = member(pair.second);
    // The RPC orders each pair by UUID and includes each unordered pair once.
    if (
      first.memberId >= second.memberId ||
      seen.get(first.memberId)?.has(second.memberId)
    ) {
      throw new Error("Invalid or duplicate love-similarity pair.");
    }
    const secondIds = seen.get(first.memberId) ?? new Set<string>();
    secondIds.add(second.memberId);
    seen.set(first.memberId, secondIds);
    const result = calculateTasteSimilarityFromCounts({
      seasonId: expectedSeasonId,
      coRatedCount: count(pair.coRatedCount),
      loveIntersectionCount: count(pair.loveIntersectionCount),
      loveUnionCount: count(pair.loveUnionCount),
      slIntersectionCount: count(pair.slIntersectionCount),
      slUnionCount: count(pair.slUnionCount),
    });
    return {
      first,
      second,
      coRatedCount: result.coRatedCount,
      loveOverlap: serializeOverlap(result.loveOverlap),
      slOverlap: serializeOverlap(result.slOverlap),
      score:
        result.score.value === undefined
          ? { value: null, reason: "undefined_overlap" }
          : { value: result.score.value },
    };
  });
  return {
    seasonId: expectedSeasonId,
    algorithm: TASTE_SIMILARITY_ALGORITHM,
    pairs,
  };
}
