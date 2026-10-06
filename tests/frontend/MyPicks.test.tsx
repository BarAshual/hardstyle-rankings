import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi } from "vitest";
import { App } from "../../src/App";
import type {
  API,
  Choice,
  Home,
  Pick,
  VoteAction,
  VoteReceipt,
} from "../../src/api";
import { readPending, savePending } from "../../src/pendingVotes";
const sid = "20000000-0000-0000-0000-000000000001";
const uid = "10000000-0000-0000-0000-000000000001";
const tracks: Pick[] = [
  {
    id: "30000000-0000-0000-0000-000000000001",
    title: "Neon Skyline",
    artists: ["Phase Reactor"],
    choice: "LIKE",
    version: 3,
  },
  {
    id: "30000000-0000-0000-0000-000000000002",
    title: "Hidden Frequency",
    artists: ["Other Artist"],
    choice: "PASS",
    version: 1,
  },
  {
    id: "30000000-0000-0000-0000-000000000003",
    title: "Final Echo",
    artists: ["Last Artist"],
    choice: "SUPER_LIKE",
    version: 2,
  },
].map((p) => ({
  ...p,
  artwork_url: null,
  spotify_url: null,
  apple_music_url: null,
  active: true,
})) as Pick[];
function fake(initial = tracks) {
  let picks = structuredClone(initial);
  let state: Home["season"]["state"] = "VOTING";
  const receipts = new Map<string, VoteReceipt>();
  const api = {
    restore: vi.fn().mockResolvedValue({ id: uid }),
    subscribe: vi.fn(() => () => {}),
    signIn: vi.fn(),
    complete: vi.fn(),
    signOut: vi.fn(),
    memberships: vi.fn(),
    inspect: vi.fn(),
    accept: vi.fn(),
    nextTrack: vi.fn().mockResolvedValue(null),
    home: vi.fn(async (): Promise<Home> => ({
      season: { id: sid, name: "Test season", year: 2026, state },
      nickname: "Duke",
      progress: {
        active_tracks: picks.length,
        rated: picks.length,
        unrated: 0,
        super_likes_used: picks.filter((p) => p.choice === "SUPER_LIKE").length,
        super_likes_available:
          2 - picks.filter((p) => p.choice === "SUPER_LIKE").length,
        completion_percent: 100,
      },
    })),
    myPicks: vi.fn(async () => structuredClone(picks)),
    castVote: vi.fn(async (a: VoteAction): Promise<VoteReceipt> => {
      const prior = receipts.get(a.action_id);
      if (prior) return prior;
      const current = picks.find((p) => p.id === a.track_id)!;
      if (current.version !== a.expected_version)
        throw { message: "vote_version_conflict" };
      current.choice = a.choice;
      current.version++;
      const receipt = {
        ...a,
        version: current.version,
        accepted_at: "2026-10-06T00:00:00Z",
      };
      receipts.set(a.action_id, receipt);
      return receipt;
    }),
  } satisfies API;
  return {
    api,
    receipts,
    get picks() {
      return picks;
    },
    replace: (next: Pick[]) => {
      picks = structuredClone(next);
    },
    lock: () => {
      state = "LOCKED";
    },
  };
}
function mount(api: API, path = `/seasons/${sid}/my-picks`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App api={api} />
    </MemoryRouter>,
  );
}
const card = (title = "Neon Skyline") =>
  within(screen.getByRole("article", { name: title }));
const choice = (c: Choice) =>
  card().getByRole("button", { name: c.replace("_", " ") });
async function loaded() {
  await screen.findByRole("article", { name: "Neon Skyline" });
}

describe("My Picks", () => {
  it("loads own choices and supports title/artist search and all filters", async () => {
    const { api } = fake();
    mount(api);
    await loaded();
    expect(api.myPicks).toHaveBeenCalledWith(sid, uid);
    const search = screen.getByRole("searchbox", {
      name: "Search title or artist",
    });
    await userEvent.type(search, "neon");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await userEvent.clear(search);
    await userEvent.type(search, "Other Artist");
    expect(
      screen.getByRole("article", { name: "Hidden Frequency" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await userEvent.clear(search);
    for (const [filter, title] of [
      ["LIKE", "Neon Skyline"],
      ["PASS", "Hidden Frequency"],
      ["SUPER_LIKE", "Final Echo"],
    ]) {
      await userEvent.selectOptions(
        screen.getByLabelText("Filter choices"),
        filter,
      );
      expect(screen.getAllByRole("article")).toHaveLength(1);
      expect(screen.getByRole("article", { name: title })).toBeInTheDocument();
    }
    await userEvent.selectOptions(
      screen.getByLabelText("Filter choices"),
      "ALL",
    );
    expect(screen.getAllByRole("article")).toHaveLength(3);
    await userEvent.type(search, "missing");
    expect(screen.getByText(/No choices match/)).toBeInTheDocument();
  });
  it("shows an empty state and is reachable from Home", async () => {
    const { api } = fake([]);
    mount(api, `/seasons/${sid}`);
    await userEvent.click(
      await screen.findByRole("link", { name: "My Picks" }),
    );
    await screen.findByText(/No picks yet/);
    expect(api.castVote).not.toHaveBeenCalled();
  });
  it.each<[Choice, Choice]>([
    ["LIKE", "PASS"],
    ["PASS", "LIKE"],
    ["LIKE", "SUPER_LIKE"],
    ["SUPER_LIKE", "LIKE"],
  ])(
    "edits %s to %s using current version and authoritative allowance",
    async (from, to) => {
      const f = fake([{ ...tracks[0], choice: from }]);
      mount(f.api);
      await loaded();
      await userEvent.click(choice(to));
      await waitFor(() =>
        expect(
          card().getByText(to.replace("_", " "), { selector: "strong" }),
        ).toBeInTheDocument(),
      );
      expect(f.api.castVote.mock.calls[0][0]).toMatchObject({
        expected_version: 3,
        choice: to,
        track_id: tracks[0].id,
      });
      expect(f.picks[0].version).toBe(4);
      expect(
        screen.getByText(
          `${to === "SUPER_LIKE" ? 1 : 2} Super Likes remaining`,
        ),
      ).toBeInTheDocument();
      expect(readPending(uid, sid)).toBeNull();
    },
  );
  it("does not mutate a same-choice action", async () => {
    const { api } = fake();
    mount(api);
    await loaded();
    expect(choice("LIKE")).toBeDisabled();
    fireEvent.click(choice("LIKE"));
    expect(api.castVote).not.toHaveBeenCalled();
  });
  it("rejects invalid Super Like promotion without changing choice", async () => {
    const { api } = fake();
    api.castVote.mockRejectedValueOnce({ message: "super_like_limit" });
    mount(api);
    await loaded();
    await userEvent.click(choice("SUPER_LIKE"));
    await screen.findByText(/used all your Super Likes/);
    await loaded();
    expect(choice("LIKE")).toBeDisabled();
    expect(readPending(uid, sid)).toBeNull();
  });
  it("reloads latest choice on a stale version and requires a deliberate new action", async () => {
    const f = fake();
    f.api.castVote.mockImplementationOnce(async () => {
      f.replace([{ ...tracks[0], choice: "PASS", version: 4 }]);
      throw { message: "vote_version_conflict" };
    });
    mount(f.api);
    await loaded();
    await userEvent.click(choice("SUPER_LIKE"));
    await screen.findByText(/changed in another session/);
    await waitFor(() => expect(choice("PASS")).toBeDisabled());
    expect(f.api.castVote).toHaveBeenCalledOnce();
    await userEvent.click(choice("LIKE"));
    await waitFor(() => expect(choice("LIKE")).toBeDisabled());
    expect(f.api.castVote.mock.calls[1][0].expected_version).toBe(4);
    expect(f.api.castVote.mock.calls[1][0].action_id).not.toBe(
      f.api.castVote.mock.calls[0][0].action_id,
    );
  });
  it("replays a lost edit response after remount with identical payload", async () => {
    const f = fake();
    const real = f.api.castVote.getMockImplementation()!;
    f.api.castVote.mockImplementationOnce(async (a) => {
      await real(a);
      throw new Error("response lost");
    });
    const view = mount(f.api);
    await loaded();
    await userEvent.click(choice("PASS"));
    await screen.findByText(/couldn’t confirm this edit/);
    const original = f.api.castVote.mock.calls[0][0];
    expect(
      card().getByText("LIKE", { selector: "strong" }),
    ).toBeInTheDocument();
    view.unmount();
    mount(f.api);
    await userEvent.click(
      await screen.findByRole("button", { name: "Retry pending vote" }),
    );
    await waitFor(() => expect(readPending(uid, sid)).toBeNull());
    await loaded();
    expect(f.api.castVote.mock.calls[1][0]).toEqual(original);
    expect(f.receipts.size).toBe(1);
    expect(f.picks[0].version).toBe(4);
  });
  it("never rolls back a newer server vote when a replay returns its older receipt", async () => {
    const f = fake();
    const action: VoteAction = {
      user_id: uid,
      season_id: sid,
      track_id: tracks[0].id,
      choice: "PASS",
      expected_version: 3,
      action_id: crypto.randomUUID(),
    };
    await f.api.castVote(action);
    f.replace([{ ...tracks[0], choice: "SUPER_LIKE", version: 5 }]);
    savePending({ action, track: tracks[0] });
    mount(f.api);
    await userEvent.click(
      await screen.findByRole("button", { name: "Retry pending vote" }),
    );
    await waitFor(() => expect(readPending(uid, sid)).toBeNull());
    await loaded();
    expect(
      card().getByText("SUPER LIKE", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(f.picks[0].version).toBe(5);
  });
  it("handles action UUID conflicts without silently trying another UUID", async () => {
    const { api } = fake();
    api.castVote.mockRejectedValueOnce({ message: "action_payload_conflict" });
    mount(api);
    await loaded();
    await userEvent.click(choice("PASS"));
    await screen.findByText(/different vote/);
    await loaded();
    expect(api.castVote).toHaveBeenCalledOnce();
    expect(readPending(uid, sid)).toBeNull();
  });
  it("blocks duplicate edits while the request is in flight", async () => {
    const { api } = fake();
    let resolve!: (r: VoteReceipt) => void;
    api.castVote.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    mount(api);
    await loaded();
    const pass = choice("PASS");
    fireEvent.click(pass);
    fireEvent.click(pass);
    expect(api.castVote).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Saving vote…" })).toBeDisabled();
    await act(async () =>
      resolve({
        ...api.castVote.mock.calls[0][0],
        version: 4,
        accepted_at: "now",
      }),
    );
  });
  it("handles locking mid-edit and still displays own picks", async () => {
    const f = fake();
    f.api.castVote.mockImplementationOnce(async () => {
      f.lock();
      throw { message: "voting_closed" };
    });
    mount(f.api);
    await loaded();
    await userEvent.click(choice("PASS"));
    await screen.findByText(/You can still view your choices/);
    expect(screen.getAllByRole("article")).toHaveLength(3);
    for (const c of ["PASS", "LIKE", "SUPER_LIKE"] as Choice[])
      expect(choice(c)).toBeDisabled();
  });
  it("reconciles accepted edits after LOCKED", async () => {
    const f = fake();
    const action: VoteAction = {
      user_id: uid,
      season_id: sid,
      track_id: tracks[0].id,
      choice: "PASS",
      expected_version: 3,
      action_id: crypto.randomUUID(),
    };
    await f.api.castVote(action);
    savePending({ action, track: tracks[0] });
    f.lock();
    mount(f.api);
    await userEvent.click(
      await screen.findByRole("button", { name: "Retry pending vote" }),
    );
    await waitFor(() => expect(readPending(uid, sid)).toBeNull());
    await loaded();
    expect(
      card().getByText("PASS", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(choice("LIKE")).toBeDisabled();
  });
  it("rating can recover an edit from the same pending journal", async () => {
    const f = fake();
    const action: VoteAction = {
      user_id: uid,
      season_id: sid,
      track_id: tracks[0].id,
      choice: "PASS",
      expected_version: 3,
      action_id: crypto.randomUUID(),
    };
    savePending({ action, track: tracks[0] });
    mount(f.api, `/seasons/${sid}/rate`);
    await userEvent.click(
      await screen.findByRole("button", { name: "Retry pending vote" }),
    );
    await screen.findByRole("heading", { name: "You’re caught up." });
    expect(f.picks[0].version).toBe(4);
    expect(readPending(uid, sid)).toBeNull();
  });
  it("preserves edits across reload and uses their new version for another edit", async () => {
    const f = fake();
    const view = mount(f.api);
    await loaded();
    await userEvent.click(choice("PASS"));
    await waitFor(() => expect(choice("PASS")).toBeDisabled());
    view.unmount();
    mount(f.api);
    await loaded();
    expect(
      card().getByText("PASS", { selector: "strong" }),
    ).toBeInTheDocument();
    await userEvent.click(choice("LIKE"));
    await waitFor(() => expect(choice("LIKE")).toBeDisabled());
    expect(f.api.castVote.mock.calls[1][0].expected_version).toBe(4);
  });
  it("fails closed when storage cannot save a new edit", async () => {
    const { api } = fake();
    mount(api);
    await loaded();
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    try {
      await userEvent.click(choice("PASS"));
      expect(api.castVote).not.toHaveBeenCalled();
      expect(screen.getByText(/No new vote was sent/)).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });
});
