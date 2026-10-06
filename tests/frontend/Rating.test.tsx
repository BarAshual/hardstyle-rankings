import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { musicURL } from "../../src/Rating";
import { readPending, savePending } from "../../src/pendingVotes";
import type { API, Choice, Home, Track, VoteAction } from "../../src/api";
const sid = "20000000-0000-0000-0000-000000000001";
const uid = "10000000-0000-0000-0000-000000000001";
const tracks: Track[] = [1, 2, 3].map((n) => ({
  id: `30000000-0000-0000-0000-00000000000${n}`,
  title: `Track ${n}`,
  artists: ["Fictional Artist"],
  artwork_url: null,
  spotify_url: null,
  apple_music_url: null,
}));
function fake() {
  const votes = new Map<string, Choice>();
  let catalog = [...tracks];
  let state: Home["season"]["state"] = "VOTING";
  const api = {
    restore: vi.fn().mockResolvedValue({ id: uid }),
    subscribe: vi.fn(() => () => {}),
    signIn: vi.fn(),
    complete: vi.fn(),
    signOut: vi.fn(),
    memberships: vi.fn(),
    inspect: vi.fn(),
    accept: vi.fn(),
    home: vi.fn(async (): Promise<Home> => ({
      season: { id: sid, name: "Test season", year: 2026, state },
      nickname: "Duke",
      progress: {
        active_tracks: catalog.length,
        rated: votes.size,
        unrated: catalog.length - votes.size,
        super_likes_used: [...votes.values()].filter((v) => v === "SUPER_LIKE")
          .length,
        super_likes_available:
          1 - [...votes.values()].filter((v) => v === "SUPER_LIKE").length,
        completion_percent: 0,
      },
    })),
    nextTrack: vi.fn(async () => catalog.find((t) => !votes.has(t.id)) ?? null),
    castVote: vi.fn(
      async (
        action: VoteAction,
      ): Promise<Awaited<ReturnType<API["castVote"]>>> => {
        votes.set(action.track_id, action.choice);
        return { ...action, version: 1, accepted_at: "2026-10-03T00:00:00Z" };
      },
    ),
  } satisfies API;
  return {
    api,
    votes,
    add: (t: Track) => {
      catalog = [...catalog, t];
    },
    lock: () => {
      state = "LOCKED";
    },
  };
}
function mount(api: API, route = `/seasons/${sid}/rate`) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <App api={api} />
    </MemoryRouter>,
  );
}
const button = (choice: Choice) =>
  screen.getByRole("button", {
    name:
      choice === "PASS"
        ? "← PASS"
        : choice === "LIKE"
          ? "LIKE →"
          : "↑ SUPER LIKE",
  });

describe("durable rating", () => {
  it.each<Choice>(["PASS", "LIKE", "SUPER_LIKE"])(
    "saves %s with expected version zero then advances and refreshes personal progress",
    async (choice) => {
      const { api, votes } = fake();
      mount(api);
      await screen.findByRole("heading", { name: "Track 1" });
      await userEvent.click(button(choice));
      await screen.findByRole("heading", { name: "Track 2" });
      expect(votes.get(tracks[0].id)).toBe(choice);
      expect(api.castVote).toHaveBeenCalledWith(
        expect.objectContaining({ choice, expected_version: 0, user_id: uid }),
      );
      expect(readPending(uid, sid)).toBeNull();
      expect(
        screen.getByText(
          `1 / 3 rated · ${choice === "SUPER_LIKE" ? 0 : 1} Super Likes remaining`,
        ),
      ).toBeInTheDocument();
    },
  );
  it("blocks duplicate submissions and waits for backend acceptance", async () => {
    const { api } = fake();
    let resolve!: (value: Awaited<ReturnType<API["castVote"]>>) => void;
    api.castVote.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    const pass = button("PASS");
    fireEvent.click(pass);
    fireEvent.click(pass);
    expect(api.castVote).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("heading", { name: "Track 1" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Saving vote…" })).toBeDisabled();
    const action = api.castVote.mock.calls[0][0];
    await act(async () =>
      resolve({ ...action, version: 1, accepted_at: "now" }),
    );
  });
  it("does not advance on an uncertain failure and replays the identical action after reload", async () => {
    const { api, votes } = fake();
    api.castVote.mockImplementationOnce(async (a) => {
      votes.set(a.track_id, a.choice);
      throw new Error("lost response");
    });
    const view = mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    await userEvent.click(button("LIKE"));
    await screen.findByText(/couldn’t confirm this vote/);
    const original = api.castVote.mock.calls[0][0];
    expect(
      screen.getByRole("heading", { name: "Track 1" }),
    ).toBeInTheDocument();
    view.unmount();
    mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    await userEvent.click(
      screen.getByRole("button", { name: "Retry pending vote" }),
    );
    await screen.findByRole("heading", { name: "Track 2" });
    expect(api.castVote.mock.calls[1][0]).toEqual(original);
    expect(votes.size).toBe(1);
  });
  it("preserves distinct choices across remount, updates home, and discovers catalog growth after completion", async () => {
    const { api, votes, add } = fake();
    const view = mount(api);
    for (const [index, choice] of (
      ["PASS", "LIKE", "SUPER_LIKE"] as const
    ).entries()) {
      await screen.findByRole("heading", { name: `Track ${index + 1}` });
      await userEvent.click(button(choice));
    }
    await screen.findByRole("heading", { name: "You’re caught up." });
    view.unmount();
    mount(api);
    await screen.findByRole("heading", { name: "You’re caught up." });
    expect([...votes.values()]).toEqual(["PASS", "LIKE", "SUPER_LIKE"]);
    expect(
      screen.getByText("3 / 3 rated · 0 Super Likes remaining"),
    ).toBeInTheDocument();
    add({
      ...tracks[0],
      id: "30000000-0000-0000-0000-000000000004",
      title: "New release",
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Check for new tracks" }),
    );
    await screen.findByRole("heading", { name: "New release" });
    await userEvent.click(screen.getByRole("link", { name: "← Season home" }));
    await screen.findByRole("heading", { name: /Welcome, Duke/ });
    expect(
      screen.getByText("1 track waiting for your take"),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("link", { name: /Continue rating/ }),
    );
    await screen.findByRole("heading", { name: "New release" });
  });
  it("explains the Super Like limit and permits another choice with a new action", async () => {
    const { api } = fake();
    api.castVote.mockRejectedValueOnce({ message: "super_like_limit" });
    mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    await userEvent.click(button("SUPER_LIKE"));
    await screen.findByText(/used all your Super Likes/);
    await waitFor(() => expect(button("PASS")).toBeEnabled());
    await userEvent.click(button("PASS"));
    await screen.findByRole("heading", { name: "Track 2" });
    expect(api.castVote.mock.calls[1][0].action_id).not.toBe(
      api.castVote.mock.calls[0][0].action_id,
    );
  });
  it("handles a season locking while a track is on screen", async () => {
    const { api, lock } = fake();
    api.castVote.mockImplementationOnce(async () => {
      lock();
      throw { message: "voting_closed" };
    });
    mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    await userEvent.click(button("LIKE"));
    await screen.findByRole("heading", { name: "Voting is closed." });
    expect(screen.getByText(/This vote wasn’t saved/)).toBeInTheDocument();
    expect(readPending(uid, sid)).toBeNull();
  });
  it("can replay an accepted pending action after the season locks", async () => {
    const { api, lock, votes } = fake();
    const action: VoteAction = {
      user_id: uid,
      season_id: sid,
      track_id: tracks[0].id,
      choice: "LIKE",
      expected_version: 0,
      action_id: crypto.randomUUID(),
    };
    savePending({ action, track: tracks[0] });
    votes.set(tracks[0].id, "LIKE");
    lock();
    mount(api);
    await screen.findByRole("button", { name: "Retry pending vote" });
    await userEvent.click(
      screen.getByRole("button", { name: "Retry pending vote" }),
    );
    await screen.findByRole("heading", { name: "Voting is closed." });
    expect(api.castVote).toHaveBeenCalledWith(action);
  });
  it.each(["vote_version_conflict", "action_payload_conflict"])(
    "reconciles %s without editing or silently resubmitting",
    async (code) => {
      const { api, votes } = fake();
      api.castVote.mockImplementationOnce(async (a) => {
        votes.set(a.track_id, "PASS");
        throw { message: code };
      });
      mount(api);
      await screen.findByRole("heading", { name: "Track 1" });
      await userEvent.click(button("LIKE"));
      await screen.findByRole("heading", { name: "Track 2" });
      expect(api.castVote).toHaveBeenCalledOnce();
      expect(votes.get(tracks[0].id)).toBe("PASS");
      expect(screen.getByRole("status")).toHaveTextContent(
        code === "vote_version_conflict" ? "already rated" : "different vote",
      );
    },
  );
  it("fails closed when browser storage cannot journal a vote", async () => {
    const { api } = fake();
    mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    try {
      await userEvent.click(button("PASS"));
      expect(api.castVote).not.toHaveBeenCalled();
      expect(screen.getByText(/No new vote was sent/)).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });
  it("keeps the track and pending action when the backend fails before acceptance", async () => {
    const { api, votes } = fake();
    api.castVote.mockRejectedValueOnce(new Error("network failed"));
    mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    await userEvent.click(button("PASS"));
    await screen.findByText(/couldn’t confirm this vote/);
    expect(votes.size).toBe(0);
    expect(
      screen.getByRole("heading", { name: "Track 1" }),
    ).toBeInTheDocument();
    expect(api.nextTrack).toHaveBeenCalledOnce();
    expect(readPending(uid, sid)?.action).toEqual(
      api.castVote.mock.calls[0][0],
    );
  });
  it("retries only the queue when progress loading fails after a confirmed vote", async () => {
    const { api, votes } = fake();
    mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    api.home.mockRejectedValueOnce(new Error("network failed"));
    await userEvent.click(button("PASS"));
    await screen.findByText(/couldn’t load your rating session/);
    expect(votes.size).toBe(1);
    expect(readPending(uid, sid)).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Track 1" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Track 2" });
    expect(api.castVote).toHaveBeenCalledOnce();
  });
  it("keeps pending actions isolated by account and never overwrites another action", () => {
    const action: VoteAction = {
      user_id: uid,
      season_id: sid,
      track_id: tracks[0].id,
      choice: "LIKE",
      expected_version: 0,
      action_id: crypto.randomUUID(),
    };
    savePending({ action, track: tracks[0] });
    savePending({
      action: { ...action, action_id: crypto.randomUUID() },
      track: tracks[0],
    });
    expect(readPending("another-user", sid)).toBeNull();
    expect(Object.keys(localStorage)).toHaveLength(2);
  });
  it("rejects unsafe/provider-mismatched URLs and handles missing links", async () => {
    expect(musicURL("javascript:alert(1)", "spotify")).toBeNull();
    expect(
      musicURL("https://open.spotify.com.evil.test/track/1", "spotify"),
    ).toBeNull();
    expect(musicURL("https://open.spotify.com/track/example", "spotify")).toBe(
      "https://open.spotify.com/track/example",
    );
    expect(
      musicURL("https://music.apple.com/us/album/example", "apple"),
    ).toBeTruthy();
    const { api } = fake();
    mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    expect(screen.getByText("Spotify unavailable")).toBeInTheDocument();
    expect(screen.getByText("Apple Music unavailable")).toBeInTheDocument();
  });
});
