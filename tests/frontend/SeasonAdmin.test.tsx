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
  VisibilityAction,
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
const action = (): VisibilityAction => ({
  kind: "visibility",
  userId: uid,
  seasonId: sid,
  actionId: crypto.randomUUID(),
  visible: true,
});
const receipt = (a: VisibilityAction) => ({
  seasonId: a.seasonId,
  category: "love_similarity",
  actionId: a.actionId,
  visible: a.visible,
  changedAt: "2026-10-25T12:00:00+00:00",
});
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
    visible: false,
    canChange: state === "REVEAL",
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
      .mockImplementation(async (a) => {
        metadata.visible = a.visible;
        return receipt(a);
      }),
    transitionSeason: vi
      .fn<API["transitionSeason"]>()
      .mockImplementation(async (_s, _u, next) => {
        metadata.state = next;
        metadata.canChange = next === "REVEAL";
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
  await screen.findByRole("heading", { name: "Love similarity" });
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
    expect(
      screen.queryByRole("button", { name: "Open love similarity" }),
    ).not.toBeInTheDocument();
    expect(api.setLoveVisibility).not.toHaveBeenCalled();
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
      const visibility = screen.getByRole("button", {
        name: "Open love similarity",
      });
      if (state === "REVEAL") expect(visibility).toBeEnabled();
      else expect(visibility).toBeDisabled();
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
      screen.queryByRole("button", { name: "Open love similarity" }),
    ).not.toBeInTheDocument();
    await act(async () => read.reject(new Error("private SQL detail")));
    expect(await screen.findByRole("alert")).not.toHaveTextContent(
      "private SQL",
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
    expect(api.adminSeason).toHaveBeenCalledTimes(2);
    expect(api.setLoveVisibility).not.toHaveBeenCalled();
  });
  it.each([
    { seasonId: otherSid },
    { state: "BOGUS" },
    { category: "other" },
    { canChange: false },
    { visible: null },
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
  it("confirms every one-step advance, permits cancellation and leaves REVEAL hidden", async () => {
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
    expect(
      screen.getByText("Hidden", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(api.setLoveVisibility).not.toHaveBeenCalled();
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
    expect(api.setLoveVisibility).not.toHaveBeenCalled();
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

describe("visibility receipt, reload and failure recovery", () => {
  it.each(["SETUP", "VOTING", "LOCKED"] as const)(
    "cannot retry saved visibility intent before REVEAL (%s)",
    async (state) => {
      const saved = action();
      saveAdminPending(saved);
      const { api } = fake(state);
      mount(api);
      await ready();
      expect(
        screen.getByRole("button", { name: "Retry saved visibility change" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Open love similarity" }),
      ).toBeDisabled();
      expect(api.setLoveVisibility).not.toHaveBeenCalled();
      expect(readAdminPending(uid, sid)).toEqual([saved]);
    },
  );
  it("saves intent before sending, confirms open/hide and refreshes authoritative metadata", async () => {
    const { api, metadata } = fake();
    api.setLoveVisibility.mockImplementation(async (a) => {
      expect(readAdminPending(uid, sid)).toEqual([a]);
      metadata.visible = a.visible;
      return receipt(a);
    });
    mount(api);
    await ready();
    await confirm("Open love similarity");
    await ready();
    expect(
      screen.getByText("Open", { selector: "strong" }),
    ).toBeInTheDocument();
    await confirm("Hide love similarity");
    await ready();
    expect(
      screen.getByText("Hidden", { selector: "strong" }),
    ).toBeInTheDocument();
    const [first, second] = api.setLoveVisibility.mock.calls.map(([a]) => a);
    expect(first.actionId).not.toBe(second.actionId);
    expect(api.adminSeason).toHaveBeenCalledTimes(3);
    expect(readAdminPending(uid, sid)).toEqual([]);
  });
  it("replays exactly after reload and ignores a historical receipt's visibility", async () => {
    const { api } = fake();
    api.setLoveVisibility.mockRejectedValueOnce(new Error("lost response"));
    const view = mount(api);
    await ready();
    await confirm("Open love similarity");
    await screen.findByRole("button", {
      name: "Retry saved visibility change",
    });
    const original = api.setLoveVisibility.mock.calls[0][0];
    expect(readAdminPending(uid, sid)).toEqual([original]);
    view.unmount();
    api.setLoveVisibility.mockImplementation(async (a) => receipt(a)); // Another admin already hid it.
    mount(api);
    await ready();
    expect(api.setLoveVisibility).toHaveBeenCalledOnce(); // No auto replay on load.
    expect(
      screen.getByRole("button", { name: "Open love similarity" }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry saved visibility change" }),
    );
    await ready();
    expect(api.setLoveVisibility).toHaveBeenLastCalledWith(original);
    expect(readAdminPending(uid, sid)).toEqual([]);
    expect(
      screen.getByText("Hidden", { selector: "strong" }),
    ).toBeInTheDocument();
  });
  it.each([
    { actionId: "other" },
    { seasonId: otherSid },
    { visible: false },
    { category: "other" },
    { changedAt: "invalid" },
    { changedAt: null },
  ])(
    "retains the exact action after mismatched receipt %j",
    async (invalid) => {
      const { api } = fake();
      api.setLoveVisibility.mockImplementation(async (a) => ({
        ...receipt(a),
        ...invalid,
      }));
      mount(api);
      await ready();
      await confirm("Open love similarity");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "couldn’t confirm",
      );
      const original = api.setLoveVisibility.mock.calls[0][0];
      expect(readAdminPending(uid, sid)).toEqual([original]);
      expect(
        screen.getByRole("button", { name: "Open love similarity" }),
      ).toBeDisabled();
      api.setLoveVisibility.mockImplementation(async (a) => receipt(a));
      await userEvent.click(
        screen.getByRole("button", { name: "Retry saved visibility change" }),
      );
      await ready();
      expect(api.setLoveVisibility).toHaveBeenLastCalledWith(original);
    },
  );
  it("retries only the read when refresh fails after a valid receipt", async () => {
    const { api } = fake();
    mount(api);
    await ready();
    api.adminSeason.mockRejectedValueOnce(new Error("refresh offline"));
    await confirm("Open love similarity");
    await screen.findByRole("button", { name: "Try again" });
    expect(readAdminPending(uid, sid)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
    expect(api.setLoveVisibility).toHaveBeenCalledOnce();
  });
  it("blocks writes when journal persistence fails and allows recovery after storage returns", async () => {
    const { api } = fake();
    mount(api);
    await ready();
    const store = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    try {
      await confirm("Open love similarity");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "browser storage",
      );
      expect(api.setLoveVisibility).not.toHaveBeenCalled();
    } finally {
      store.mockRestore();
    }
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
    await confirm("Open love similarity");
    await ready();
    expect(api.setLoveVisibility).toHaveBeenCalledOnce();
  });
  it("retains the request if receipt cleanup fails and retries with the same UUID", async () => {
    const { api } = fake();
    mount(api);
    await ready();
    const remove = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    try {
      await confirm("Open love similarity");
      await screen.findByRole("alert");
    } finally {
      remove.mockRestore();
    }
    const original = api.setLoveVisibility.mock.calls[0][0];
    expect(readAdminPending(uid, sid)).toEqual([original]);
    await userEvent.click(
      screen.getByRole("button", { name: "Retry saved visibility change" }),
    );
    await ready();
    expect(api.setLoveVisibility).toHaveBeenLastCalledWith(original);
  });
  it("blocks corrupt saved intent instead of silently discarding it", async () => {
    const { api } = fake();
    localStorage.setItem(
      adminScope(uid, sid) + crypto.randomUUID(),
      "broken JSON",
    );
    mount(api);
    await screen.findByRole("alert");
    expect(api.setLoveVisibility).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "Love similarity" }),
    ).not.toBeInTheDocument();
  });
  it("refreshes after a definitive rejection without resending that request", async () => {
    const { api } = fake();
    api.setLoveVisibility.mockRejectedValueOnce({
      message: "action_payload_conflict",
      code: "P0001",
    });
    mount(api);
    await ready();
    await confirm("Open love similarity");
    await screen.findByRole("button", { name: "Try again" });
    expect(readAdminPending(uid, sid)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
    expect(api.setLoveVisibility).toHaveBeenCalledOnce();
  });
});

describe("account and season isolation", () => {
  it("ignores an old account's in-flight read and reauthorizes the new account", async () => {
    const { api, metadata, notify } = fake();
    const oldRead = deferred<AdminSeason>();
    api.adminSeason
      .mockReturnValueOnce(oldRead.promise)
      .mockRejectedValue({ message: "season_admin_required", code: "42501" });
    mount(api);
    await waitFor(() => expect(api.adminSeason).toHaveBeenCalledWith(sid, uid));
    act(() => notify({ id: otherUid }));
    await screen.findByRole("alert");
    await act(async () => oldRead.resolve(metadata));
    expect(api.adminSeason).toHaveBeenLastCalledWith(sid, otherUid);
    expect(
      screen.queryByRole("heading", { name: "Love similarity" }),
    ).not.toBeInTheDocument();
  });
  it("keeps an uncertain write with its original account, including late responses", async () => {
    const { api, notify } = fake();
    const write = deferred<unknown>();
    api.setLoveVisibility.mockReturnValueOnce(write.promise);
    mount(api);
    await ready();
    await confirm("Open love similarity");
    const original = api.setLoveVisibility.mock.calls[0][0];
    act(() => notify({ id: otherUid }));
    await ready();
    await act(async () => write.reject(new Error("late error")));
    expect(
      screen.queryByRole("button", { name: "Retry saved visibility change" }),
    ).not.toBeInTheDocument();
    expect(readAdminPending(uid, sid)).toEqual([original]);
    expect(readAdminPending(otherUid, sid)).toEqual([]);
    act(() => notify({ id: uid }));
    await ready();
    expect(
      screen.getByRole("button", { name: "Retry saved visibility change" }),
    ).toBeEnabled();
    expect(api.setLoveVisibility).toHaveBeenCalledOnce();
  });
  it("resets confirmation and saved actions on season navigation and ignores late reads", async () => {
    const { api, metadata } = fake();
    const saved = action();
    saveAdminPending(saved);
    const firstRead = deferred<AdminSeason>();
    api.adminSeason.mockReturnValueOnce(firstRead.promise);
    mount(api);
    await waitFor(() => expect(api.adminSeason).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Other season" }));
    await ready();
    await act(async () =>
      firstRead.resolve({ ...metadata, name: "Wrong season name" }),
    );
    expect(screen.queryByText("Wrong season name")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry saved visibility change" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Open love similarity" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "First season" }));
    await ready();
    expect(
      screen.queryByRole("button", { name: "Confirm open love similarity" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry saved visibility change" }),
    ).toBeEnabled();
    expect(readAdminPending(uid, sid)).toEqual([saved]);
    expect(api.setLoveVisibility).not.toHaveBeenCalled();
  });
  it("removes controls on server denial while preserving the saved action", async () => {
    const { api } = fake();
    api.setLoveVisibility.mockRejectedValue({
      message: "season_admin_required",
      code: "42501",
    });
    mount(api);
    await ready();
    await confirm("Open love similarity");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "aren’t available",
    );
    expect(
      screen.queryByRole("heading", { name: "Love similarity" }),
    ).not.toBeInTheDocument();
    expect(readAdminPending(uid, sid)).toHaveLength(1);
  });
  it("preserves multiple per-action records and never consumes another scope", async () => {
    const first = action(),
      second = action(),
      foreign = { ...action(), userId: otherUid, seasonId: otherSid };
    saveAdminPending(first);
    saveAdminPending(second);
    saveAdminPending(foreign);
    const { api } = fake();
    mount(api);
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry saved visibility change" }),
    );
    await ready();
    expect(readAdminPending(uid, sid)).toHaveLength(1);
    expect(readAdminPending(otherUid, otherSid)).toEqual([foreign]);
    expect(
      screen.getByRole("button", { name: "Hide love similarity" }),
    ).toBeDisabled();
  });
});
