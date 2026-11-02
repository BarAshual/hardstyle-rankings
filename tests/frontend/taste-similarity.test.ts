import { describe, expect, it } from "vitest";
import {
  calculateTasteSimilarity,
  calculateTasteSimilarityFromCounts,
  TASTE_SIMILARITY_ALGORITHM,
  type CurrentTasteBallot,
  type EligibleTasteTracks,
  type TasteChoice,
  type TasteSimilarityCounts,
} from "../../src/domain/taste-similarity";

const seasonId = "synthetic-official-season";
const eligible = (...trackIds: string[]): EligibleTasteTracks => ({
  seasonId,
  trackIds,
});
const ballot = (
  ...choices: readonly (readonly [string, TasteChoice])[]
): CurrentTasteBallot => ({
  seasonId,
  choices: choices.map(([trackId, choice]) => ({ trackId, choice })),
});
const ids = (start: number, end: number) =>
  Array.from({ length: end - start }, (_, index) => String(start + index));
const allTrackIds = ids(0, 1200);
const referenceCatalog = eligible(...allTrackIds);

function completeBallot(
  lovedIds: string[],
  slIds: string[],
): CurrentTasteBallot {
  const loved = new Set(lovedIds);
  const sl = new Set(slIds);
  expect(slIds.every((id) => loved.has(id))).toBe(true);
  return ballot(
    ...allTrackIds.map((id): [string, TasteChoice] => [
      id,
      sl.has(id) ? "SUPER_LIKE" : loved.has(id) ? "LIKE" : "PASS",
    ]),
  );
}

function referenceBallots() {
  return {
    reference: completeBallot(ids(0, 500), ids(0, 40)),
    a: completeBallot(
      [...ids(0, 400), ...ids(500, 600)],
      [...ids(0, 5), ...ids(40, 75)],
    ),
    bClose: completeBallot(
      [...ids(0, 380), ...ids(500, 620)],
      [...ids(0, 20), ...ids(40, 60)],
    ),
    bLargerGap: completeBallot(
      [...ids(0, 300), ...ids(500, 700)],
      [...ids(0, 20), ...ids(40, 60)],
    ),
  };
}

describe("approved love similarity v1", () => {
  it("builds complete 1,200-track reference ballots with 500 loves including 40 SL", () => {
    for (const member of Object.values(referenceBallots())) {
      expect(member.choices).toHaveLength(1200);
      expect(new Set(member.choices.map(({ trackId }) => trackId)).size).toBe(
        1200,
      );
      expect(member.choices.map(({ trackId }) => trackId)).toEqual(allTrackIds);
      expect(
        member.choices.filter(({ choice }) => choice !== "PASS"),
      ).toHaveLength(500);
      expect(
        member.choices.filter(({ choice }) => choice === "SUPER_LIKE"),
      ).toHaveLength(40);
      expect(
        member.choices.filter(({ choice }) => choice === "PASS"),
      ).toHaveLength(700);
    }
  });

  it.each([
    {
      member: "a",
      loveIntersection: 400,
      loveUnion: 600,
      slIntersection: 5,
      slUnion: 75,
      score: 31 / 60,
    },
    {
      member: "bClose",
      loveIntersection: 380,
      loveUnion: 620,
      slIntersection: 20,
      slUnion: 60,
      score: 101 / 186,
    },
    {
      member: "bLargerGap",
      loveIntersection: 300,
      loveUnion: 700,
      slIntersection: 20,
      slUnion: 60,
      score: 17 / 42,
    },
  ] as const)(
    "reproduces the reference comparison with $member",
    (expected) => {
      const members = referenceBallots();
      const result = calculateTasteSimilarity(
        referenceCatalog,
        members.reference,
        members[expected.member],
      );
      expect(TASTE_SIMILARITY_ALGORITHM).toBe("taste-love-v1");
      expect(result).toMatchObject({
        algorithm: "taste-love-v1",
        seasonId,
        coRatedCount: 1200,
      });
      expect(result.loveOverlap).toEqual({
        intersectionCount: expected.loveIntersection,
        unionCount: expected.loveUnion,
        value: expected.loveIntersection / expected.loveUnion,
      });
      expect(result.slOverlap).toEqual({
        intersectionCount: expected.slIntersection,
        unionCount: expected.slUnion,
        value: expected.slIntersection / expected.slUnion,
      });
      expect(result.score.value).toBeCloseTo(expected.score, 14);
      expect(result.score.reason).toBeUndefined();
      expect(
        calculateTasteSimilarityFromCounts({
          seasonId,
          coRatedCount: 1200,
          loveIntersectionCount: expected.loveIntersection,
          loveUnionCount: expected.loveUnion,
          slIntersectionCount: expected.slIntersection,
          slUnionCount: expected.slUnion,
        }),
      ).toEqual(result);
    },
  );

  it("places B close above A and A above B with the larger love gap", () => {
    const members = referenceBallots();
    const score = (other: CurrentTasteBallot) =>
      calculateTasteSimilarity(referenceCatalog, members.reference, other).score
        .value;
    expect(score(members.bClose)).toBeGreaterThan(score(members.a)!);
    expect(score(members.a)).toBeGreaterThan(score(members.bLargerGap)!);
  });

  it("gives identical ballots with eligible co-rated SL a score of one", () => {
    const { reference } = referenceBallots();
    const result = calculateTasteSimilarity(
      referenceCatalog,
      reference,
      reference,
    );
    expect(result.loveOverlap).toEqual({
      intersectionCount: 500,
      unionCount: 500,
      value: 1,
    });
    expect(result.slOverlap).toEqual({
      intersectionCount: 40,
      unionCount: 40,
      value: 1,
    });
    expect(result.score).toEqual({ value: 1 });
  });

  it("gives identical loved sets with disjoint nonempty SL sets a score of 0.75", () => {
    const result = calculateTasteSimilarity(
      referenceCatalog,
      completeBallot(ids(0, 500), ids(0, 40)),
      completeBallot(ids(0, 500), ids(40, 80)),
    );
    expect(result.loveOverlap).toEqual({
      intersectionCount: 500,
      unionCount: 500,
      value: 1,
    });
    expect(result.slOverlap).toEqual({
      intersectionCount: 0,
      unionCount: 80,
      value: 0,
    });
    expect(result.score).toEqual({ value: 0.75 });
  });

  it.each([
    ["LIKE", "SUPER_LIKE", 1, 0, 0.75],
    ["SUPER_LIKE", "SUPER_LIKE", 1, 1, 1],
    ["SUPER_LIKE", "PASS", 0, 0, 0],
  ] as const)(
    "compares a single %s versus %s track without an evidence threshold",
    (first, second, love, sl, score) => {
      const result = calculateTasteSimilarity(
        eligible("one"),
        ballot(["one", first]),
        ballot(["one", second]),
      );
      expect(result.coRatedCount).toBe(1);
      expect(result.loveOverlap).toEqual({
        intersectionCount: love,
        unionCount: 1,
        value: love,
      });
      expect(result.slOverlap).toEqual({
        intersectionCount: sl,
        unionCount: 1,
        value: sl,
      });
      expect(result.score).toEqual({ value: score });
    },
  );
});

describe("comparison scope and undefined components", () => {
  const emptyOverlap = {
    intersectionCount: 0,
    unionCount: 0,
    value: undefined,
    reason: "empty_union",
  };
  const undefinedScore = { value: undefined, reason: "undefined_overlap" };

  it.each([
    { name: "empty ballots", first: ballot(), second: ballot(), count: 0 },
    {
      name: "disjoint rated tracks",
      first: ballot(["one", "SUPER_LIKE"]),
      second: ballot(["two", "SUPER_LIKE"]),
      count: 0,
    },
    {
      name: "only shared PASS",
      first: ballot(["one", "PASS"], ["two", "PASS"]),
      second: ballot(["one", "PASS"], ["two", "PASS"]),
      count: 2,
    },
  ])("keeps both overlaps undefined for $name", ({ first, second, count }) => {
    const result = calculateTasteSimilarity(
      eligible("one", "two"),
      first,
      second,
    );
    expect(result.coRatedCount).toBe(count);
    expect(result.loveOverlap).toEqual(emptyOverlap);
    expect(result.slOverlap).toEqual(emptyOverlap);
    expect(result.score).toEqual(undefinedScore);
    expect(
      calculateTasteSimilarityFromCounts({
        seasonId,
        coRatedCount: count,
        loveIntersectionCount: 0,
        loveUnionCount: 0,
        slIntersectionCount: 0,
        slUnionCount: 0,
      }),
    ).toEqual(result);
  });

  it("preserves a defined love component without using SL outside the comparison set", () => {
    const result = calculateTasteSimilarity(
      eligible("shared", "only-first"),
      ballot(
        ["shared", "LIKE"],
        ["only-first", "SUPER_LIKE"],
        ["ineligible", "SUPER_LIKE"],
      ),
      ballot(["shared", "LIKE"], ["ineligible", "SUPER_LIKE"]),
    );
    expect(result.coRatedCount).toBe(1);
    expect(result.loveOverlap).toEqual({
      intersectionCount: 1,
      unionCount: 1,
      value: 1,
    });
    expect(result.slOverlap).toEqual(emptyOverlap);
    expect(result.score).toEqual(undefinedScore);
    expect(
      calculateTasteSimilarityFromCounts({
        seasonId,
        coRatedCount: 1,
        loveIntersectionCount: 1,
        loveUnionCount: 1,
        slIntersectionCount: 0,
        slUnionCount: 0,
      }),
    ).toEqual(result);
  });

  it("ignores a unilateral rating and shared ineligible ratings", () => {
    const first = ballot(["shared", "SUPER_LIKE"]);
    const second = ballot(["shared", "LIKE"]);
    const baseline = calculateTasteSimilarity(
      eligible("shared"),
      first,
      second,
    );
    expect(
      calculateTasteSimilarity(
        eligible("shared", "only-first"),
        ballot(
          ["shared", "SUPER_LIKE"],
          ["only-first", "PASS"],
          ["excluded", "SUPER_LIKE"],
        ),
        ballot(["shared", "LIKE"], ["excluded", "PASS"]),
      ),
    ).toEqual(baseline);
    expect(
      calculateTasteSimilarityFromCounts({
        seasonId,
        coRatedCount: 1,
        loveIntersectionCount: 1,
        loveUnionCount: 1,
        slIntersectionCount: 0,
        slUnionCount: 1,
      }),
    ).toEqual(baseline);
  });

  it("treats eligible IDs as a set and keeps distinct recording UUIDs separate", () => {
    const original = "00000000-0000-4000-8000-000000000001";
    const remix = "00000000-0000-4000-8000-000000000002";
    const result = calculateTasteSimilarity(
      eligible(original, remix, original),
      ballot([original, "SUPER_LIKE"], [remix, "PASS"]),
      ballot([original, "PASS"], [remix, "SUPER_LIKE"]),
    );
    expect(result.coRatedCount).toBe(2);
    expect(result.loveOverlap).toEqual({
      intersectionCount: 0,
      unionCount: 2,
      value: 0,
    });
    expect(result.slOverlap).toEqual({
      intersectionCount: 0,
      unionCount: 2,
      value: 0,
    });
    expect(result.score).toEqual({ value: 0 });
  });

  it("uses a replacement current choice once instead of accumulating edits", () => {
    const catalog = eligible("track");
    const other = ballot(["track", "SUPER_LIKE"]);
    expect(
      calculateTasteSimilarity(catalog, ballot(["track", "SUPER_LIKE"]), other)
        .score.value,
    ).toBe(1);
    const edited = calculateTasteSimilarity(
      catalog,
      ballot(["track", "PASS"]),
      other,
    );
    expect(edited.coRatedCount).toBe(1);
    expect(edited.loveOverlap).toEqual({
      intersectionCount: 0,
      unionCount: 1,
      value: 0,
    });
    expect(edited.slOverlap).toEqual({
      intersectionCount: 0,
      unionCount: 1,
      value: 0,
    });
    expect(edited.score).toEqual({ value: 0 });
  });
});

describe("explicit current-ballot input contract", () => {
  it.each(["first", "second"] as const)(
    "rejects another season in the %s ballot, even when empty",
    (side) => {
      for (const choices of [
        [],
        [{ trackId: "track", choice: "SUPER_LIKE" as const }],
      ]) {
        const wrongSeason: CurrentTasteBallot = {
          seasonId: "synthetic-pilot-season",
          choices,
        };
        const valid = ballot(["track", "SUPER_LIKE"]);
        expect(() =>
          calculateTasteSimilarity(
            eligible("track"),
            side === "first" ? wrongSeason : valid,
            side === "second" ? wrongSeason : valid,
          ),
        ).toThrow("Season IDs must match the eligible catalog.");
      }
    },
  );

  it.each(["", "   "])("rejects an absent explicit season ID (%j)", (blank) => {
    expect(() =>
      calculateTasteSimilarity(
        { seasonId: blank, trackIds: [] },
        { seasonId: blank, choices: [] },
        { seasonId: blank, choices: [] },
      ),
    ).toThrow("An explicit season ID is required.");
  });

  it.each(["first", "second"] as const)(
    "rejects identical or conflicting duplicates in the %s ballot, even if ineligible",
    (side) => {
      for (const duplicateChoice of ["LIKE", "PASS"] as const) {
        for (const trackId of ["eligible", "ineligible"]) {
          const duplicate = ballot(
            [trackId, "LIKE"],
            [trackId, duplicateChoice],
          );
          const valid = ballot(["eligible", "SUPER_LIKE"]);
          expect(() =>
            calculateTasteSimilarity(
              eligible("eligible"),
              side === "first" ? duplicate : valid,
              side === "second" ? duplicate : valid,
            ),
          ).toThrow("Duplicate current choice for a track.");
        }
      }
    },
  );

  it.each(["first", "second"] as const)(
    "rejects invalid raw choices in the %s ballot",
    (side) => {
      const invalid = ballot(["track", "SL" as TasteChoice]);
      const valid = ballot(["track", "LIKE"]);
      expect(() =>
        calculateTasteSimilarity(
          eligible("track"),
          side === "first" ? invalid : valid,
          side === "second" ? invalid : valid,
        ),
      ).toThrow("Invalid current choice.");
    },
  );
});

describe("pure calculation invariants", () => {
  it("does not mutate frozen catalogs, ballots, or choice entries", () => {
    const catalog = Object.freeze({
      seasonId,
      trackIds: Object.freeze(["b", "a"]),
    });
    const first = Object.freeze({
      seasonId,
      choices: Object.freeze([
        Object.freeze({ trackId: "b", choice: "SUPER_LIKE" as const }),
        Object.freeze({ trackId: "a", choice: "LIKE" as const }),
      ]),
    });
    const second = Object.freeze({
      seasonId,
      choices: Object.freeze([
        Object.freeze({ trackId: "a", choice: "SUPER_LIKE" as const }),
        Object.freeze({ trackId: "b", choice: "LIKE" as const }),
      ]),
    });
    expect(calculateTasteSimilarity(catalog, first, second).score).toEqual({
      value: 0.75,
    });
    expect(catalog.trackIds).toEqual(["b", "a"]);
    expect(first.choices.map(({ trackId }) => trackId)).toEqual(["b", "a"]);
    expect(second.choices.map(({ trackId }) => trackId)).toEqual(["a", "b"]);
  });

  it("is symmetric, deterministic, order independent, and bounded across every two-track ballot pair", () => {
    const states = [undefined, "PASS", "LIKE", "SUPER_LIKE"] as const;
    const ballots = states.flatMap((one) =>
      states.map((two) =>
        ballot(
          ...(one === undefined ? [] : [["one", one] as const]),
          ...(two === undefined ? [] : [["two", two] as const]),
        ),
      ),
    );
    for (const first of ballots) {
      for (const second of ballots) {
        const result = calculateTasteSimilarity(
          eligible("one", "two"),
          first,
          second,
        );
        expect(
          calculateTasteSimilarityFromCounts({
            seasonId,
            coRatedCount: result.coRatedCount,
            loveIntersectionCount: result.loveOverlap.intersectionCount,
            loveUnionCount: result.loveOverlap.unionCount,
            slIntersectionCount: result.slOverlap.intersectionCount,
            slUnionCount: result.slOverlap.unionCount,
          }),
        ).toEqual(result);
        expect(
          calculateTasteSimilarity(eligible("one", "two"), second, first),
        ).toEqual(result);
        expect(
          calculateTasteSimilarity(eligible("one", "two"), first, second),
        ).toEqual(result);
        expect(
          calculateTasteSimilarity(
            eligible("two", "one"),
            { ...first, choices: [...first.choices].reverse() },
            { ...second, choices: [...second.choices].reverse() },
          ),
        ).toEqual(result);
        for (const component of [
          result.loveOverlap,
          result.slOverlap,
          result.score,
        ]) {
          if (component.value !== undefined) {
            expect(component.value).toBeGreaterThanOrEqual(0);
            expect(component.value).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});

describe("count-based evidence validation", () => {
  const valid: TasteSimilarityCounts = {
    seasonId,
    coRatedCount: 20,
    loveIntersectionCount: 8,
    loveUnionCount: 12,
    slIntersectionCount: 2,
    slUnionCount: 5,
  };

  it.each([
    "coRatedCount",
    "loveIntersectionCount",
    "loveUnionCount",
    "slIntersectionCount",
    "slUnionCount",
  ] as const)("rejects non-count numbers in %s", (key) => {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        calculateTasteSimilarityFromCounts({ ...valid, [key]: value }),
      ).toThrow("Evidence counts must be nonnegative safe integers.");
    }
  });

  it.each([
    { loveIntersectionCount: 13 },
    { loveUnionCount: 21 },
    { slIntersectionCount: 6 },
    { slUnionCount: 13 },
    { loveIntersectionCount: 1 },
  ])("rejects impossible subset counts %j", (changes) => {
    expect(() =>
      calculateTasteSimilarityFromCounts({ ...valid, ...changes }),
    ).toThrow("Evidence counts are inconsistent.");
  });

  it.each(["", "   "])("requires an explicit season (%j)", (blank) => {
    expect(() =>
      calculateTasteSimilarityFromCounts({ ...valid, seasonId: blank }),
    ).toThrow("An explicit season ID is required.");
  });

  it("retains valid safe-integer boundary counts without rounding", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    expect(
      calculateTasteSimilarityFromCounts({
        seasonId,
        coRatedCount: maximum,
        loveIntersectionCount: maximum,
        loveUnionCount: maximum,
        slIntersectionCount: maximum,
        slUnionCount: maximum,
      }).score,
    ).toEqual({ value: 1 });
  });
});
