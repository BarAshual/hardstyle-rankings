import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { vi, describe, it, expect } from "vitest";
import { App } from "../../src/App";
import type { API, Home, Identity } from "../../src/api";

const token = "10000000-0000-0000-0000-000000000001";
const sid = "20000000-0000-0000-0000-000000000001";
const user: Identity = { id: "user-1", email: "member@example.invalid" };
const home: Home = {
  season: { id: sid, name: "Hardstyle 2026", year: 2026, state: "VOTING" },
  nickname: "Bar",
  progress: {
    active_tracks: 850,
    rated: 12,
    unrated: 838,
    super_likes_used: 2,
    super_likes_available: 28,
    completion_percent: 1.41,
  },
};
function fake(identity: Identity | null = user) {
  let notify: (user: Identity | null) => void = () => {};
  const api = {
    restore: vi.fn().mockResolvedValue(identity),
    subscribe: vi.fn((callback: typeof notify) => {
      notify = callback;
      return vi.fn();
    }),
    signIn: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(user),
    signOut: vi.fn().mockImplementation(async () => {
      notify(null);
    }),
    memberships: vi
      .fn()
      .mockResolvedValue([{ season_id: sid, nickname: "Bar" }]),
    inspect: vi.fn().mockResolvedValue({
      season_id: sid,
      season_name: "Hardstyle 2026",
      year: 2026,
      nickname: null,
    }),
    accept: vi.fn().mockResolvedValue(sid),
    home: vi.fn().mockResolvedValue(home),
    myPicks: vi.fn().mockResolvedValue([]),
    nextTrack: vi.fn().mockResolvedValue(null),
    castVote: vi.fn(),
  } satisfies API;
  return { api, notify: (identity: Identity | null) => notify(identity) };
}
function mount(api: API, path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App api={api} />
    </MemoryRouter>,
  );
}

describe("authentication and season entry", () => {
  it("shows Google entry without querying private data while signed out", async () => {
    const { api } = fake(null);
    mount(api);
    await userEvent.click(
      await screen.findByRole("button", { name: /Continue with Google/ }),
    );
    expect(api.signIn).toHaveBeenCalledOnce();
    expect(api.memberships).not.toHaveBeenCalled();
    expect(api.home).not.toHaveBeenCalled();
  });
  it("preserves an invitation across the OAuth redirect", async () => {
    const { api } = fake(null);
    mount(api, `/invite/${token}`);
    await userEvent.click(
      await screen.findByRole("button", { name: /Continue with Google/ }),
    );
    expect(sessionStorage.getItem("hardstyle.pending-invitation")).toBe(token);
    expect(api.inspect).not.toHaveBeenCalled();
  });
  it("restores a member session after remount and renders personal progress", async () => {
    const { api } = fake();
    const view = mount(api);
    expect(
      await screen.findByRole("heading", { name: /Welcome, Bar/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("28 Super Likes available")).toBeInTheDocument();
    expect(screen.getByText("2 used this season")).toBeInTheDocument();
    expect(
      screen.getByText("838 tracks waiting for your take"),
    ).toBeInTheDocument();
    expect(screen.getByText("Voting is open")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Tracks rated" }),
    ).toHaveAttribute("max", "850");
    expect(api.home).toHaveBeenCalledWith(sid, user.id);
    view.unmount();
    mount(api, `/seasons/${sid}`);
    expect(
      await screen.findByRole("heading", { name: /Welcome, Bar/ }),
    ).toBeInTheDocument();
    expect(api.accept).not.toHaveBeenCalled();
  });
  it("handles a delayed session restore before deciding to show sign-in", async () => {
    const { api } = fake();
    let resolve!: (user: Identity) => void;
    api.restore.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mount(api);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Continue with Google/ }),
    ).not.toBeInTheDocument();
    await act(async () => resolve(user));
    expect(
      await screen.findByRole("heading", { name: /Welcome, Bar/ }),
    ).toBeInTheDocument();
  });
  it("does not overwrite a newer sign-out event with a stale restore response", async () => {
    const { api, notify } = fake();
    let resolve!: (user: Identity) => void;
    api.restore.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mount(api);
    act(() => notify(null));
    await act(async () => resolve(user));
    expect(
      await screen.findByRole("button", { name: /Continue with Google/ }),
    ).toBeInTheDocument();
    expect(api.home).not.toHaveBeenCalled();
  });
  it("finishes OAuth and returns to the saved invitation", async () => {
    const { api } = fake(null);
    sessionStorage.setItem("hardstyle.pending-invitation", token);
    mount(api, "/auth/callback?code=single-use-code");
    expect(
      await screen.findByRole("heading", { name: /Choose your rave name/ }),
    ).toBeInTheDocument();
    expect(api.complete).toHaveBeenCalledWith("single-use-code");
    expect(api.inspect).toHaveBeenCalledWith(token);
  });
  it("handles OAuth cancellation without displaying provider details", async () => {
    const { api } = fake(null);
    mount(api, "/auth/callback?error=denied&error_description=secret-detail");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Google sign-in was cancelled",
    );
    expect(screen.queryByText(/secret-detail/)).not.toBeInTheDocument();
    expect(api.complete).not.toHaveBeenCalled();
  });
  it("handles failed code exchange and sign-in initiation safely", async () => {
    const { api } = fake(null);
    api.complete.mockRejectedValue(new Error("internal-secret"));
    mount(api, "/auth/callback?code=bad");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn’t finish Google sign-in",
    );
    await userEvent.click(
      screen.getByRole("link", { name: "Back to sign in" }),
    );
    api.signIn.mockRejectedValue(new Error("internal-secret"));
    await userEvent.click(
      await screen.findByRole("button", { name: /Continue with Google/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Google sign-in couldn’t start",
    );
    expect(screen.queryByText(/internal-secret/)).not.toBeInTheDocument();
  });
  it("handles authenticated users with no membership and signs out", async () => {
    const { api } = fake();
    api.memberships.mockResolvedValue([]);
    mount(api);
    expect(
      await screen.findByRole("heading", { name: "Find your crew." }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Sign out/ }));
    expect(
      await screen.findByRole("button", { name: /Continue with Google/ }),
    ).toBeInTheDocument();
  });
});

describe("invitation onboarding", () => {
  it("requires a valid nickname, then accepts through the RPC and opens home", async () => {
    const { api } = fake();
    mount(api, `/invite/${token}`);
    await screen.findByRole("heading", { name: /Choose your rave name/ });
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a rave name");
    expect(api.accept).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Rave name"), "  Bar  ");
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(
      await screen.findByRole("heading", { name: /Welcome, Bar/ }),
    ).toBeInTheDocument();
    expect(api.accept).toHaveBeenCalledWith(token, "Bar");
  });
  it("skips nickname onboarding for an existing member accepting/reopening a link", async () => {
    const { api } = fake();
    api.inspect.mockResolvedValue({
      season_id: sid,
      season_name: "Hardstyle 2026",
      year: 2026,
      nickname: "Bar",
    });
    mount(api, `/invite/${token}`);
    expect(
      await screen.findByRole("heading", { name: /Welcome, Bar/ }),
    ).toBeInTheDocument();
    expect(api.accept).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Rave name")).not.toBeInTheDocument();
  });
  it("rejects wrong-account/unknown invitations without leaking invitation details", async () => {
    const { api } = fake();
    api.inspect.mockRejectedValue({ message: "invitation_not_available" });
    mount(api, `/invite/${token}`);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "different Google account",
    );
    expect(screen.queryByLabelText("Rave name")).not.toBeInTheDocument();
    expect(api.accept).not.toHaveBeenCalled();
  });
  it("rejects malformed links before an RPC", async () => {
    const { api } = fake();
    mount(api, "/invite/not-a-uuid");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "link is invalid",
    );
    expect(api.inspect).not.toHaveBeenCalled();
  });
  it("handles nickname/database rejection and lets the user retry", async () => {
    const { api } = fake();
    api.accept.mockRejectedValueOnce({
      code: "23505",
      message: "private constraint name",
    });
    mount(api, `/invite/${token}`);
    await userEvent.type(await screen.findByLabelText("Rave name"), "Bar");
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "try another name",
    );
    expect(screen.queryByText(/private constraint/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(
      await screen.findByRole("heading", { name: /Welcome, Bar/ }),
    ).toBeInTheDocument();
  });
  it("prevents duplicate submissions while acceptance is pending", async () => {
    const { api } = fake();
    api.accept.mockReturnValue(new Promise(() => {}));
    mount(api, `/invite/${token}`);
    await userEvent.type(await screen.findByLabelText("Rave name"), "Bar");
    await userEvent.dblClick(screen.getByRole("button", { name: /Continue/ }));
    await waitFor(() => expect(api.accept).toHaveBeenCalledOnce());
  });
  it("handles unavailable seasons and transient progress errors", async () => {
    const { api } = fake();
    api.home
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("internal-error"));
    mount(api, `/seasons/${sid}`);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "isn’t available to your account",
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "couldn’t load your progress",
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: /Welcome, Bar/ }),
    ).toBeInTheDocument();
  });
});
