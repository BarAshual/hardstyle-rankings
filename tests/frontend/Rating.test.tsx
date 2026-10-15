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
import { EXIT_MS } from "../../src/swipe";
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
    subscribe: vi.fn<API["subscribe"]>(() => () => {}),
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
    myPicks: vi.fn().mockResolvedValue([]),
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
    expect(pass).toBeDisabled();
    expect(readPending(uid, sid)).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Saving your choice|Pending:/),
    ).not.toBeInTheDocument();
    const action = api.castVote.mock.calls[0][0];
    await act(async () =>
      resolve({ ...action, version: 1, accepted_at: "now" }),
    );
    expect(screen.queryByText(/Vote saved|Confirmed/)).not.toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
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
    await userEvent.click(screen.getByRole("link", { name: "← Home" }));
    await screen.findByRole("heading", { name: /Welcome, Duke/ });
    expect(
      screen.getByText("1 track waiting for your take"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Rate tracks" }));
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
    await screen.findByRole("button", { name: "Try again" });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
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

const pointer = (x: number, y: number) => ({
  pointerId: 1,
  pointerType: "touch",
  isPrimary: true,
  button: 0,
  clientX: 160 + x,
  clientY: 220 + y,
});
function swipe(x: number, y: number) {
  const card = screen.getByRole("group", { name: /Swipe to rate/ });
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
    width: 320,
    height: 360,
  } as DOMRect);
  fireEvent.pointerDown(card, pointer(0, 0));
  fireEvent.pointerMove(card, pointer(x, y));
  fireEvent.pointerUp(card, pointer(x, y));
  return card;
}
describe("swipe submission and stable transitions", () => {
  it.each<[number, number, Choice]>([
    [-100, 0, "PASS"],
    [100, 0, "LIKE"],
    [0, -100, "SUPER_LIKE"],
  ])(
    "journals the %s, %s swipe through the existing receipt path",
    async (x, y, choice) => {
      const { api } = fake();
      const cast = api.castVote.getMockImplementation()!;
      api.castVote.mockImplementation(async (a) => {
        expect(readPending(uid, sid)?.action).toEqual(a);
        return cast(a);
      });
      mount(api);
      await screen.findByRole("heading", { name: "Track 1" });
      swipe(x, y);
      fireEvent.click(button("PASS"));
      await screen.findByRole("heading", { name: "Track 2" });
      expect(api.castVote).toHaveBeenCalledOnce();
      expect(api.castVote.mock.calls[0][0]).toMatchObject({
        choice,
        expected_version: 0,
      });
    },
  );
  it.each<[number, number, Choice]>([
    [-100, 5, "PASS"],
    [100, 5, "LIKE"],
    [5, -100, "SUPER_LIKE"],
  ])(
    "holds the released card while saving, then exits %s, %s after confirmation",
    async (x, y, choice) => {
      const { api, votes } = fake();
      let resolve!: (r: Awaited<ReturnType<API["castVote"]>>) => void;
      api.castVote.mockImplementation(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      const { container } = mount(api);
      await screen.findByRole("heading", { name: "Track 1" });
      const stage = container.querySelector(".rating-stage");
      const actions = container.querySelector(".vote-actions");
      const card = swipe(x, y);
      expect(card).toHaveAttribute("data-exit", "");
      expect(card.style.getPropertyValue("--drag-x")).toBe(`${x}px`);
      expect(card.style.getPropertyValue("--drag-y")).toBe(
        `${Math.min(y, 0)}px`,
      );
      fireEvent.lostPointerCapture(card, pointer(x, y));
      expect(card.style.getPropertyValue("--drag-x")).toBe(`${x}px`);
      expect(screen.getByText(/0 \/ 3 rated/)).toBeInTheDocument();
      expect(api.nextTrack).toHaveBeenCalledOnce();
      const a = api.castVote.mock.calls[0][0];
      votes.set(a.track_id, a.choice);
      await act(async () => resolve({ ...a, version: 1, accepted_at: "now" }));
      expect(card).toHaveAttribute("data-exit", choice);
      expect(card.style.getPropertyValue("--drag-x")).toBe(`${x}px`);
      expect(card.style.getPropertyValue("--drag-y")).toBe(
        `${Math.min(y, 0)}px`,
      );
      expect(button("LIKE")).toBeDisabled();
      await screen.findByRole("heading", { name: "Track 2" });
      expect(container.querySelector(".rating-stage")).toBe(stage);
      expect(container.querySelector(".vote-actions")).toBe(actions);
    },
  );
  it("retains a pending swipe and its context on a mismatched receipt", async () => {
    const { api } = fake();
    api.castVote.mockImplementationOnce(async (a) => ({
      ...a,
      choice: "PASS",
      version: 1,
      accepted_at: "now",
    }));
    mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    const card = swipe(100, 0);
    await screen.findByText(/couldn’t confirm this vote/);
    expect(card).toHaveAttribute("data-exit", "");
    expect(readPending(uid, sid)?.action.choice).toBe("LIKE");
    expect(api.nextTrack).toHaveBeenCalledOnce();
    expect(button("LIKE")).toBeDisabled();
  });
  it("returns a zero-allowance upward swipe without an RPC", async () => {
    const { api, votes } = fake();
    votes.set(tracks[2].id, "SUPER_LIKE");
    mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    const card = swipe(0, -120);
    await waitFor(() =>
      expect(card.style.getPropertyValue("--drag-y")).toBe("0px"),
    );
    expect(screen.getByText(/used all your Super Likes/)).toBeInTheDocument();
    expect(api.castVote).not.toHaveBeenCalled();
    expect(button("SUPER_LIKE")).toBeDisabled();
    expect(button("LIKE")).toBeEnabled();
  });
  it("reconciles a concurrent allowance rejection without a second submission", async () => {
    const { api, votes } = fake();
    api.castVote.mockImplementationOnce(async () => {
      votes.set(tracks[2].id, "SUPER_LIKE");
      throw { message: "super_like_limit" };
    });
    mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    swipe(0, -120);
    await waitFor(() => expect(button("LIKE")).toBeEnabled());
    expect(screen.getByText(/used all your Super Likes/)).toBeInTheDocument();
    expect(screen.getByText(/0 Super Likes remaining/)).toBeInTheDocument();
    expect(api.castVote).toHaveBeenCalledOnce();
    expect(readPending(uid, sid)).toBeNull();
  });
  it("does not flash the loader or delay a fast next track after the exit", async () => {
    const { api } = fake();
    let resolve!: (track: Track) => void;
    const { container } = mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    api.nextTrack.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    vi.useFakeTimers();
    try {
      fireEvent.click(button("LIKE"));
      await act(async () => {});
      await act(async () => {
        vi.advanceTimersByTime(EXIT_MS);
      });
      expect(container.querySelector(".rating-loading")).toBeInTheDocument();
      expect(
        screen.queryByRole("status", { name: "Loading your next track" }),
      ).not.toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      await act(async () => resolve(tracks[1]));
      expect(
        screen.getByRole("heading", { name: "Track 2" }),
      ).toBeInTheDocument();
      expect(button("LIKE")).toBeEnabled();
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(
        container.querySelector(".rating-loading"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("status", { name: "Loading your next track" }),
      ).not.toBeInTheDocument();
      expect(api.castVote).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("waits within the card slot for a slow next read and retries a failed read only", async () => {
    const { api } = fake();
    let reject!: (e: Error) => void;
    const { container } = mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    api.nextTrack.mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    vi.useFakeTimers();
    try {
      swipe(-100, 0);
      await act(async () => {});
      await act(async () => {
        vi.advanceTimersByTime(EXIT_MS);
      });
      const stage = container.querySelector(".rating-stage");
      expect(stage).toHaveAttribute("aria-busy", "true");
      await act(async () => {
        vi.advanceTimersByTime(499);
      });
      expect(
        screen.queryByRole("status", { name: "Loading your next track" }),
      ).not.toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(
        screen.getByRole("status", { name: "Loading your next track" }),
      ).toBeInTheDocument();
      expect(
        container.querySelector(".rating-loading .wordmark"),
      ).toHaveTextContent("HS/26");
      expect(container.querySelector(".rating-stage")).toBe(stage);
      expect(button("PASS")).toBeDisabled();
      expect(readPending(uid, sid)).toBeNull();
      await act(async () => reject(new Error("read failed")));
      expect(
        screen.queryByRole("status", { name: "Loading your next track" }),
      ).not.toBeInTheDocument();
      expect(stage).toHaveAttribute("aria-busy", "false");
    } finally {
      vi.useRealTimers();
    }
    await screen.findByRole("button", { name: "Try again" });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Track 2" });
    expect(api.castVote).toHaveBeenCalledOnce();
  });
  it("keeps provider interaction and outside scrolling out of the drag surface", async () => {
    const { api } = fake();
    api.nextTrack.mockResolvedValueOnce({
      ...tracks[0],
      spotify_url: "https://open.spotify.com/track/1",
    });
    mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    const link = screen.getByRole("link", { name: /Listen on Spotify/ });
    const card = screen.getByRole("group", { name: /Swipe to rate/ });
    expect(card).not.toContainElement(link);
    fireEvent.pointerDown(link, pointer(0, 0));
    fireEvent.pointerUp(link, pointer(150, 0));
    fireEvent.scroll(document.body);
    expect(api.castVote).not.toHaveBeenCalled();
  });
  it("preserves keyboard voting and skips motion delays when reduced motion is requested", async () => {
    const { api } = fake();
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    try {
      mount(api);
      await screen.findByRole("heading", { name: "Track 1" });
      button("PASS").focus();
      await userEvent.keyboard("{Enter}");
      await screen.findByRole("heading", { name: "Track 2" });
      expect(
        screen.getByRole("group", { name: /Swipe to rate/ }),
      ).toHaveAttribute("data-entering", "false");
      expect(api.castVote).toHaveBeenCalledOnce();
    } finally {
      window.matchMedia = original;
    }
  });
  it("cancels a gesture on account change and ignores the departing actor’s response", async () => {
    const { api } = fake();
    let identityChanged!: Parameters<API["subscribe"]>[0];
    api.subscribe.mockImplementation((listener) => {
      identityChanged = listener;
      return () => {};
    });
    mount(api);
    await screen.findByRole("heading", { name: "Track 1" });
    const card = screen.getByRole("group", { name: /Swipe to rate/ });
    fireEvent.pointerDown(card, pointer(0, 0));
    fireEvent.pointerMove(card, pointer(100, 0));
    act(() => identityChanged({ id: "10000000-0000-0000-0000-000000000002" }));
    fireEvent.pointerUp(card, pointer(100, 0));
    expect(api.castVote).not.toHaveBeenCalled();
  });
});

describe("adaptive scrolling and voting", () => {
  it("never journals a vertical scroll, while keeping horizontal swipes and the Super Like button", async () => {
    const height = vi
      .spyOn(document.documentElement, "scrollHeight", "get")
      .mockReturnValue(1200);
    try {
      const { api, votes } = fake();
      mount(api);
      await screen.findByRole("heading", { name: "Track 1" });
      const card = swipe(0, -140);
      expect(card).toHaveAttribute("data-allow-up", "false");
      expect(api.castVote).not.toHaveBeenCalled();
      expect(readPending(uid, sid)).toBeNull();
      expect(
        screen.getByText(/Super Like with the button/),
      ).toBeInTheDocument();
      swipe(100, 0);
      await screen.findByRole("heading", { name: "Track 2" });
      expect(votes.get(tracks[0].id)).toBe("LIKE");
      await userEvent.click(button("SUPER_LIKE"));
      await screen.findByRole("heading", { name: "Track 3" });
      expect(votes.get(tracks[1].id)).toBe("SUPER_LIKE");
      expect(button("SUPER_LIKE")).toBeDisabled();
      expect(api.castVote).toHaveBeenCalledTimes(2);
    } finally {
      height.mockRestore();
    }
  });
  it("cancels an active swipe on overflow and restores upward gestures only after the page fits again", async () => {
    const height = vi
      .spyOn(document.documentElement, "scrollHeight", "get")
      .mockReturnValue(500);
    try {
      const { api } = fake();
      mount(api);
      await screen.findByRole("heading", { name: "Track 1" });
      const card = screen.getByRole("group", { name: /Swipe to rate/ });
      expect(card).toHaveAttribute("data-allow-up", "true");
      fireEvent.pointerDown(card, pointer(0, 0));
      fireEvent.pointerMove(card, pointer(0, -140));
      height.mockReturnValue(1200);
      fireEvent(window, new Event("resize"));
      expect(card).toHaveAttribute("data-allow-up", "false");
      fireEvent.pointerUp(card, pointer(0, -140));
      expect(api.castVote).not.toHaveBeenCalled();
      height.mockReturnValue(500);
      fireEvent(window, new Event("resize"));
      swipe(0, -140);
      await screen.findByRole("heading", { name: "Track 2" });
      expect(api.castVote).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ choice: "SUPER_LIKE" }),
      );
    } finally {
      height.mockRestore();
    }
  });
  it.each(["layout", "visual"])(
    "cancels an active swipe when the %s viewport resizes even if the page still fits",
    async (kind) => {
      const height = vi
        .spyOn(document.documentElement, "scrollHeight", "get")
        .mockReturnValue(500);
      const original = Object.getOwnPropertyDescriptor(
        window,
        "visualViewport",
      );
      const viewport = Object.assign(new EventTarget(), { height: 700 });
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: viewport,
      });
      try {
        const { api } = fake();
        mount(api);
        await screen.findByRole("heading", { name: "Track 1" });
        const card = screen.getByRole("group", { name: /Swipe to rate/ });
        expect(card).toHaveAttribute("data-allow-up", "true");
        fireEvent.pointerDown(card, pointer(0, 0));
        fireEvent.pointerMove(card, pointer(110, 0));
        expect(card.style.getPropertyValue("--drag-x")).toBe("110px");
        viewport.height = 650;
        act(() =>
          (kind === "layout" ? window : viewport).dispatchEvent(
            new Event("resize"),
          ),
        );
        expect(card).toHaveAttribute("data-allow-up", "true");
        expect(card.style.getPropertyValue("--drag-x")).toBe("0px");
        fireEvent.pointerUp(card, pointer(110, 0));
        expect(api.castVote).not.toHaveBeenCalled();
        expect(readPending(uid, sid)).toBeNull();
        swipe(110, 0);
        await screen.findByRole("heading", { name: "Track 2" });
        expect(api.castVote).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ choice: "LIKE" }),
        );
      } finally {
        height.mockRestore();
        if (original) Object.defineProperty(window, "visualViewport", original);
        else Reflect.deleteProperty(window, "visualViewport");
      }
    },
  );
  it("uses the smaller visible viewport when browser chrome or zoom leaves less room", async () => {
    const height = vi
      .spyOn(document.documentElement, "scrollHeight", "get")
      .mockReturnValue(600);
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const viewport = Object.assign(new EventTarget(), { height: 400 });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    try {
      const { api } = fake();
      mount(api);
      await screen.findByRole("heading", { name: "Track 1" });
      const card = swipe(0, -140);
      expect(card).toHaveAttribute("data-allow-up", "false");
      expect(api.castVote).not.toHaveBeenCalled();
      viewport.height = 700;
      act(() => viewport.dispatchEvent(new Event("resize")));
      expect(card).toHaveAttribute("data-allow-up", "true");
    } finally {
      height.mockRestore();
      if (original) Object.defineProperty(window, "visualViewport", original);
      else Reflect.deleteProperty(window, "visualViewport");
    }
  });
});
