import { describe, expect, it } from "vitest";
import {
  serializeLoveSimilarityResults,
  type LoveSimilarityCountsResponse,
  type LoveSimilarityPairCounts,
} from "../../src/domain/love-similarity-results";

const seasonId = "synthetic-official-season";
const first = {
  memberId: "00000000-0000-4000-8000-000000000001",
  nickname: "Reference",
};
const second = {
  memberId: "00000000-0000-4000-8000-000000000002",
  nickname: "Friend A",
};
const referencePair: LoveSimilarityPairCounts = {
  first,
  second,
  coRatedCount: 1200,
  loveIntersectionCount: 400,
  loveUnionCount: 600,
  slIntersectionCount: 5,
  slUnionCount: 75,
};
const response = (
  pair: LoveSimilarityPairCounts = referencePair,
): LoveSimilarityCountsResponse => ({
  seasonId,
  algorithm: "taste-love-v1",
  pairs: [pair],
});

describe("authorized evidence to serializable results", () => {
  it("preserves selected season, names, evidence and the unrounded 75/25 score", () => {
    const result = serializeLoveSimilarityResults(seasonId, response());
    expect(result).toEqual({
      seasonId,
      algorithm: "taste-love-v1",
      pairs: [
        {
          first,
          second,
          coRatedCount: 1200,
          loveOverlap: {
            intersectionCount: 400,
            unionCount: 600,
            value: 400 / 600,
          },
          slOverlap: {
            intersectionCount: 5,
            unionCount: 75,
            value: 5 / 75,
          },
          score: { value: 0.75 * (400 / 600) + 0.25 * (5 / 75) },
        },
      ],
    });
    expect(result.pairs[0].score.value).toBeCloseTo(31 / 60, 14);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it.each([0, 2])(
    "retains zero-union evidence and null reasons through JSON with %i co-ratings",
    (coRatedCount) => {
      const result = serializeLoveSimilarityResults(
        seasonId,
        response({
          first,
          second,
          coRatedCount,
          loveIntersectionCount: 0,
          loveUnionCount: 0,
          slIntersectionCount: 0,
          slUnionCount: 0,
        }),
      );
      expect(JSON.parse(JSON.stringify(result)).pairs[0]).toEqual({
        first,
        second,
        coRatedCount,
        loveOverlap: {
          intersectionCount: 0,
          unionCount: 0,
          value: null,
          reason: "empty_union",
        },
        slOverlap: {
          intersectionCount: 0,
          unionCount: 0,
          value: null,
          reason: "empty_union",
        },
        score: { value: null, reason: "undefined_overlap" },
      });
    },
  );

  it("preserves defined love with absent SL without reweighting or a fallback", () => {
    const result = serializeLoveSimilarityResults(
      seasonId,
      response({ ...referencePair, slIntersectionCount: 0, slUnionCount: 0 }),
    );
    const pair = JSON.parse(JSON.stringify(result)).pairs[0];
    expect(pair.loveOverlap.value).toBe(400 / 600);
    expect(pair.slOverlap).toEqual({
      intersectionCount: 0,
      unionCount: 0,
      value: null,
      reason: "empty_union",
    });
    expect(pair.score).toEqual({ value: null, reason: "undefined_overlap" });
  });

  it("distinguishes zero shared SL in a positive union from undefined SL", () => {
    const pair = serializeLoveSimilarityResults(
      seasonId,
      response({ ...referencePair, slIntersectionCount: 0 }),
    ).pairs[0];
    expect(pair.slOverlap).toEqual({
      intersectionCount: 0,
      unionCount: 75,
      value: 0,
    });
    expect(pair.score).toEqual({ value: 0.5 });
  });

  it("accepts an empty pair list without inventing a score or pair", () => {
    const input = { ...response(), pairs: [] };
    expect(serializeLoveSimilarityResults(seasonId, input)).toEqual(input);
  });

  it("projects only the documented fields and does not mutate a frozen response", () => {
    const input = Object.freeze({
      ...response(),
      audit: [{ ignored: true }],
      pairs: Object.freeze([
        Object.freeze({
          ...referencePair,
          first: Object.freeze({ ...first, email: "synthetic@example.invalid" }),
          ballots: [{ ignored: true }],
        }),
      ]),
    });
    expect(serializeLoveSimilarityResults(seasonId, input)).toEqual(
      serializeLoveSimilarityResults(seasonId, response()),
    );
    expect(input.pairs[0].first.nickname).toBe("Reference");
  });
});

describe("result response validation", () => {
  it.each(["", "   "])("rejects a missing selected season (%j)", (blank) => {
    expect(() => serializeLoveSimilarityResults(blank, response())).toThrow(
      "An explicit season ID is required.",
    );
  });

  it("rejects another season even when no pairs are present", () => {
    expect(() =>
      serializeLoveSimilarityResults(seasonId, {
        ...response(),
        seasonId: "synthetic-pilot-season",
        pairs: [],
      }),
    ).toThrow("Result season does not match the selected season.");
  });

  it("rejects a different algorithm instead of interpreting it as v1", () => {
    expect(() =>
      serializeLoveSimilarityResults(seasonId, {
        ...response(),
        algorithm: "taste-love-v2",
      }),
    ).toThrow("Unsupported love-similarity algorithm.");
  });

  it.each([null, [], 0, "response"])("rejects malformed response %j", (input) => {
    expect(() => serializeLoveSimilarityResults(seasonId, input)).toThrow(
      "Invalid love-similarity response.",
    );
  });

  it.each([null, {}, "pairs"])("rejects malformed pairs %j", (pairs) => {
    expect(() =>
      serializeLoveSimilarityResults(seasonId, { ...response(), pairs }),
    ).toThrow("Invalid love-similarity pairs.");
  });

  it.each([
    { coRatedCount: "1200" },
    { loveIntersectionCount: -1 },
    { loveUnionCount: 1.5 },
    { slIntersectionCount: null },
    { slUnionCount: Number.MAX_SAFE_INTEGER + 1 },
    { loveUnionCount: 1201 },
    { slIntersectionCount: 401, slUnionCount: 500 },
  ])("rejects malformed or impossible evidence %j", (changes) => {
    expect(() =>
      serializeLoveSimilarityResults(seasonId, {
        ...response(),
        pairs: [{ ...referencePair, ...changes }],
      }),
    ).toThrow(/Evidence counts/);
  });

  it.each([
    { memberId: "", nickname: "A" },
    { memberId: first.memberId, nickname: null },
    { memberId: first.memberId, nickname: " " },
  ])("rejects malformed member %j", (member) => {
    expect(() =>
      serializeLoveSimilarityResults(seasonId, {
        ...response(),
        pairs: [{ ...referencePair, first: member }],
      }),
    ).toThrow("Invalid love-similarity member.");
  });

  it.each([
    { pairs: [{ ...referencePair, second: first }] },
    { pairs: [{ ...referencePair, first: second, second: first }] },
    { pairs: [referencePair, referencePair] },
  ])("rejects self, reversed, or duplicate pairs", ({ pairs }) => {
    expect(() =>
      serializeLoveSimilarityResults(seasonId, { ...response(), pairs }),
    ).toThrow("Invalid or duplicate love-similarity pair.");
  });
});
