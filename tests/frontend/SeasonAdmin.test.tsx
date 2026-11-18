import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type {
  API,
  AdminSeason,
  Identity,
  Season,
} from "../../src/api";
import {
  adminScope,
  readAdminPending,
  saveAdminPending,
} from "../../src/pendingAdmin";

const sid = "20000000-0000-0000-0000-000000000001";
const otherSid = "20000000-0000-0000-0000-000000000002";
const uid = "10000000-0000-0000-0000-000000000001";
const otherUid = "10000000-0000-0000-0000-000000000002";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function fake(state: Season["state"] = "REVEAL") {
  const metadata: AdminSeason = {
    seasonId: sid,
    name: "Synthetic 2026",
    state,
    category: "love_similarity",
    visible: state === "REVEAL",
    canChange: false,
  };
  let listener: (identity: Identity | null) => void = () => {};
  const api = {
    restore: vi.fn().mockResolvedValue({ id: uid }),
    subscribe: vi.fn<API["subscribe"]>((fn) => {
      listener = fn;
      return () => {};
    }),
    signIn: vi.fn(),
    complete: vi.fn(),
    signOut: vi.fn(),
    memberships: vi.fn(),
    inspect: vi.fn(),
    accept: vi.fn(),
    home: vi.fn<API["home"]>().mockResolvedValue({
      season: { id: sid, name: metadata.name, state, year: 2026 },
      role: "admin",
      nickname: "Synthetic Admin",
      progress: {
        rated: 0,
        unrated: 0,
        active_tracks: 0,
        completion_percent: null,
        super_likes_available: 40,
        super_likes_used: 0,
      },
    }),
    myPicks: vi.fn(),
    nextTrack: vi.fn(),
    castVote: vi.fn(),
    adminSeason: vi
      .fn<API["adminSeason"]>()
      .mockImplementation(async (seasonId) => ({ ...metadata, seasonId })),
    setLoveVisibility: vi
      .fn<API["setLoveVisibility"]>()
      .mockRejectedValue(new Error("result_visibility_control_removed")),
    transitionSeason: vi
      .fn<API["transitionSeason"]>()
      .mockImplementation(async (_s, _u, next) => {
        metadata.state = next;
        metadata.visible = next === "REVEAL";
        return next;
      }),
  } satisfies API;
  return {
    api,
    metadata,
    notify: (identity: Identity | null) => listener(identity),
  };
}
function NavigateFixture() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate(`/seasons/${otherSid}/admin`)}>
        Other season
      </button>
      <button onClick={() => navigate(`/seasons/${sid}/admin`)}>
        First season
      </button>
    </>
  );
}
function mount(api: API, path = `/seasons/${sid}/admin`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NavigateFixture />
      <App api={api} />
    </MemoryRouter>,
  );
}
async function ready() {
  await screen.findByRole("heading", { name: "Season lifecycle" });
}
async function confirm(label: string) {
  await userEvent.click(screen.getByRole("button", { name: label }));
  await userEvent.click(
    screen.getByRole("button", { name: `Confirm ${label.toLowerCase()}` }),
  );
}

describe("season admin access and operational metadata", () => {
  it("links from the current admin's Home and fetches no preferences in the panel", async () => {
    const { api } = fake();
    mount(api, `/seasons/${sid}`);
    await userEvent.click(
      await screen.findByRole("link", { name: /Season admin/ }),
    );
    await ready();
    expect(api.adminSeason).toHaveBeenCalledWith(sid, uid);
    expect(api.home).toHaveBeenCalledOnce(); // Home only, never the panel.
    expect(api.myPicks).not.toHaveBeenCalled();
    expect(api.nextTrack).not.toHaveBeenCalled();
    expect(api.castVote).not.toHaveBeenCalled();
  });
  it("omits the entry for members and denies a direct link, including another season's admin", async () => {
    const { api } = fake();
    const home = await api.home(sid, uid);
    api.home.mockResolvedValue({ ...home!, role: "member" });
    api.adminSeason.mockRejectedValue({
      message: "season_admin_required",
      code: "42501",
    });
    mount(api, `/seasons/${sid}`);
    await screen.findByRole("heading", { name: /Welcome/ });
    expect(
      screen.queryByRole("link", { name: /Season admin/ }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Other season" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "aren’t available",
    );
    expect(api.adminSeason).toHaveBeenCalledWith(otherSid, uid);
    expect(screen.queryByRole("heading", { name: "Love similarity" })).not.toBeInTheDocument();
  });
  it("does not read settings while signed out or for an invalid season", async () => {
    const { api } = fake();
    api.restore.mockResolvedValue(null);
    const view = mount(api);
    await screen.findByRole("button", { name: /Continue with Google/ });
    expect(api.adminSeason).not.toHaveBeenCalled();
    view.unmount();
    api.restore.mockResolvedValue({ id: uid });
    mount(api, "/seasons/invalid/admin");
    await screen.findByRole("alert");
    expect(api.adminSeason).not.toHaveBeenCalled();
  });
  it.each(["SETUP", "VOTING", "LOCKED", "REVEAL"] as const)(
    "shows only the allowed controls in %s",
    async (state) => {
      const { api } = fake(state);
      mount(api);
      await ready();
      expect(
        screen.getByText(state, { selector: "strong" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Love similarity" })).not.toBeInTheDocument();
      const labels = {
        SETUP: "Open voting",
        VOTING: "Close voting",
        LOCKED: "Enter reveal",
        REVEAL: undefined,
      };
      for (const label of ["Open voting", "Close voting", "Enter reveal"]) {
        if (label === labels[state])
          expect(screen.getByRole("button", { name: label })).toBeEnabled();
        else
          expect(
            screen.queryByRole("button", { name: label }),
          ).not.toBeInTheDocument();
      }
      if (state === "REVEAL") {
        expect(screen.getByRole("link", { name: "See results" })).toHaveAttribute(
          "href",
          `/seasons/${sid}/results`,
        );
      } else {
        expect(screen.queryByRole("link", { name: "See results" })).not.toBeInTheDocument();
      }
      expect(api.home).not.toHaveBeenCalled();
      expect(api.transitionSeason).not.toHaveBeenCalled();
    },
  );
  it("loads, sanitizes read errors and retries without writes", async () => {
    const { api } = fake();
    const read = deferred<AdminSeason>();
    api.adminSeason.mockReturnValueOnce(read.promise);
    mount(api);
    await screen.findByText("Loading season settings…");
    expect(
      screen.queryByRole("link", { name: "See results" }),
    ).not.toBeInTheDocument();
    await act(async () => read.reject(new Error("private SQL detail")));
    expect(await screen.findByRole("alert")).not.toHaveTextContent(
      "private SQL",
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
    expect(api.adminSeason).toHaveBeenCalledTimes(2);
  });
  it.each([
    { seasonId: otherSid },
    { state: "BOGUS" },
    { visible: false },
    { canChange: true },
    { category: "other" },
    { name: "" },
  ])("blocks malformed operational metadata %j", async (invalid) => {
    const { api, metadata } = fake();
    api.adminSeason.mockResolvedValue({
      ...metadata,
      ...invalid,
    } as AdminSeason);
    mount(api);
    await screen.findByRole("alert");
    expect(
      screen.queryByRole("heading", { name: "Love similarity" }),
    ).not.toBeInTheDocument();
  });
});

describe("deliberate lifecycle changes and read-only recovery", () => {
  it("confirms every one-step advance, permits cancellation and publishes at REVEAL", async () => {
    const { api } = fake("SETUP");
    mount(api);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Open voting" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.transitionSeason).not.toHaveBeenCalled();
    for (const [label, state] of [
      ["Open voting", "VOTING"],
      ["Close voting", "LOCKED"],
      ["Enter reveal", "REVEAL"],
    ] as const) {
      await confirm(label);
      await ready();
      expect(api.transitionSeason).toHaveBeenLastCalledWith(sid, uid, state);
      expect(readAdminPending(uid, sid)).toEqual([]);
    }
    expect(api.transitionSeason).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("link", { name: "See results" })).toHaveAttribute("href", `/seasons/${sid}/results`);
  });
  it.each([false, true])(
    "refreshes after a lost lifecycle response (applied=%s), never retries it",
    async (applied) => {
      const { api, metadata } = fake("VOTING");
      api.transitionSeason.mockImplementation(async () => {
        if (applied) metadata.state = "LOCKED";
        throw new Error("lost response");
      });
      mount(api);
      await ready();
      await confirm("Close voting");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Refresh the season state",
      );
      expect(
        screen.getByRole("button", { name: "Close voting" }),
      ).toBeDisabled();
      expect(api.transitionSeason).toHaveBeenCalledOnce();
      const read = deferred<AdminSeason>();
      api.adminSeason.mockReturnValueOnce(read.promise);
      await userEvent.click(
        screen.getByRole("button", { name: "Refresh season state" }),
      );
      expect(
        screen.queryByRole("button", { name: "Enter reveal" }),
      ).not.toBeInTheDocument();
      await act(async () => read.resolve({ ...metadata }));
      await ready();
      expect(
        screen.getByRole("button", {
          name: applied ? "Enter reveal" : "Close voting",
        }),
      ).toBeEnabled();
      expect(api.transitionSeason).toHaveBeenCalledOnce();
      expect(readAdminPending(uid, sid)).toEqual([]);
    },
  );
  it("recovers a lifecycle marker on reload by reading, including a failed first read", async () => {
    saveAdminPending({
      kind: "lifecycle",
      userId: uid,
      seasonId: sid,
      actionId: crypto.randomUUID(),
      from: "LOCKED",
      to: "REVEAL",
    });
    const { api } = fake("REVEAL");
    api.adminSeason.mockRejectedValueOnce(new Error("offline"));
    mount(api);
    await screen.findByRole("alert");
    expect(readAdminPending(uid, sid)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
    expect(readAdminPending(uid, sid)).toEqual([]);
    expect(api.transitionSeason).not.toHaveBeenCalled();
  });
  it("treats an unexpected lifecycle receipt as uncertain and blocks double submission", async () => {
    const { api } = fake("VOTING");
    const write = deferred<unknown>();
    api.transitionSeason.mockReturnValue(write.promise);
    mount(api);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Close voting" }));
    const button = screen.getByRole("button", { name: "Confirm close voting" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.transitionSeason).toHaveBeenCalledOnce();
    await act(async () => write.resolve("REVEAL"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "couldn’t confirm",
    );
    expect(readAdminPending(uid, sid)[0].kind).toBe("lifecycle");
  });
});

describe("account and season isolation", () => {
  it("does not expose the admin route after account authorization changes", async () => {
    const { api, metadata, notify } = fake();
    const oldRead = deferred<AdminSeason>();
    api.adminSeason.mockReturnValueOnce(oldRead.promise).mockRejectedValue({ message: "season_admin_required", code: "42501" });
    mount(api);
    await waitFor(() => expect(api.adminSeason).toHaveBeenCalledWith(sid, uid));
    act(() => notify({ id: otherUid }));
    await screen.findByRole("alert");
    await act(async () => oldRead.resolve(metadata));
    expect(api.adminSeason).toHaveBeenLastCalledWith(sid, otherUid);
    expect(screen.queryByRole("link", { name: "See results" })).not.toBeInTheDocument();
  });
});

describe("lifecycle recovery journals", () => {
  const marker = () => ({
    kind: "lifecycle" as const, userId: uid, seasonId: sid,
    actionId: crypto.randomUUID(), from: "VOTING" as const, to: "LOCKED" as const,
  });
  it("discards retired visibility intent only after an authorized read, never replays it", async () => {
    saveAdminPending({ kind: "visibility", userId: uid, seasonId: sid, actionId: crypto.randomUUID(), visible: false });
    const foreign = { ...marker(), userId: otherUid, seasonId: otherSid };
    saveAdminPending(foreign);
    const { api } = fake();
    api.adminSeason.mockRejectedValueOnce(new Error("offline"));
    mount(api);
    await screen.findByRole("alert");
    expect(readAdminPending(uid, sid)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
    expect(readAdminPending(uid, sid)).toEqual([]);
    expect(readAdminPending(otherUid, otherSid)).toEqual([foreign]);
    expect(api.setLoveVisibility).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "See results" })).toHaveAttribute("href", `/seasons/${sid}/results`);
  });
  it("keeps an uncertain lifecycle write in its original account and recovers with reads only", async () => {
    const { api, notify } = fake("VOTING");
    const write = deferred<unknown>();
    api.transitionSeason.mockReturnValueOnce(write.promise);
    mount(api);
    await ready();
    await confirm("Close voting");
    const saved = readAdminPending(uid, sid);
    expect(saved).toHaveLength(1);
    act(() => notify({ id: otherUid }));
    await ready();
    await act(async () => write.reject(new Error("late response")));
    expect(readAdminPending(uid, sid)).toEqual(saved);
    expect(readAdminPending(otherUid, sid)).toEqual([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    act(() => notify({ id: uid }));
    await ready();
    expect(readAdminPending(uid, sid)).toEqual([]);
    expect(api.transitionSeason).toHaveBeenCalledOnce();
  });
  it("ignores late season reads and clears confirmation when navigating seasons", async () => {
    const { api, metadata } = fake("VOTING");
    const first = deferred<AdminSeason>();
    api.adminSeason.mockReturnValueOnce(first.promise);
    mount(api);
    await waitFor(() => expect(api.adminSeason).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Other season" }));
    await ready();
    await act(async () => first.resolve({ ...metadata, name: "Stale season" }));
    expect(screen.queryByText("Stale season")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close voting" }));
    await userEvent.click(screen.getByRole("button", { name: "First season" }));
    await ready();
    expect(screen.queryByRole("button", { name: "Confirm close voting" })).not.toBeInTheDocument();
    expect(api.transitionSeason).not.toHaveBeenCalled();
  });
  it("prevents writes if storage fails and can recover after storage returns", async () => {
    const { api } = fake("VOTING");
    mount(api);
    await ready();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    try {
      await confirm("Close voting");
      expect(await screen.findByRole("alert")).toHaveTextContent("browser storage");
      expect(api.transitionSeason).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
    await confirm("Close voting");
    await ready();
    expect(api.transitionSeason).toHaveBeenCalledOnce();
  });
  it("blocks corrupt journals without discarding them", async () => {
    const { api } = fake();
    const key = adminScope(uid, sid) + crypto.randomUUID();
    localStorage.setItem(key, "broken");
    mount(api);
    await screen.findByRole("alert");
    expect(localStorage.getItem(key)).toBe("broken");
    expect(api.transitionSeason).not.toHaveBeenCalled();
  });
  it("retains a lifecycle marker when cleanup fails, then recovers without resubmitting", async () => {
    const { api } = fake("VOTING");
    mount(api);
    await ready();
    const spy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      await confirm("Close voting");
      await screen.findByRole("alert");
      expect(readAdminPending(uid, sid)).toHaveLength(1);
    } finally { spy.mockRestore(); }
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
    expect(readAdminPending(uid, sid)).toEqual([]);
    expect(api.transitionSeason).toHaveBeenCalledOnce();
  });
});
