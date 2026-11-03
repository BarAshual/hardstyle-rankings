import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "./auth";
import {
  uuidPattern,
  type AdminSeason,
  type Season,
  type VisibilityAction,
} from "./api";
import { SeasonNavigation } from "./SeasonNavigation";
import {
  adminDenied,
  adminScope,
  nextSeasonState,
  readAdminPending,
  removeAdminPending,
  saveAdminPending,
  seasonStates,
  validateAdminSeason,
  validateVisibilityReceipt,
  visibilityRejected,
  type PendingAdmin,
} from "./pendingAdmin";
import type { AdminInvitation, AdminMember } from "./api";

type Confirmation =
  | { kind: "lifecycle"; from: Season["state"]; to: Season["state"] }
  | { kind: "visibility"; visible: boolean };
const transitionLabels = {
  VOTING: "Open voting",
  LOCKED: "Close voting",
  REVEAL: "Enter reveal",
  SETUP: "",
};

export function SeasonAdmin() {
  const { seasonId = "" } = useParams();
  const { identity } = useAuth();
  return (
    <AdminSession key={`${identity!.id}:${seasonId}`} seasonId={seasonId} />
  );
}

function AdminSession({ seasonId }: { seasonId: string }) {
  const { api, identity } = useAuth();
  const user = identity!.id;
  const [data, setData] = useState<AdminSeason | null>(null);
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [invitations, setInvitations] = useState<AdminInvitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [memberMessage, setMemberMessage] = useState("");
  const [memberBusy, setMemberBusy] = useState(false);
  const [status, setStatus] = useState<
    "loading" | "ready" | "error" | "denied"
  >("loading");
  const [pending, setPending] = useState<PendingAdmin | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const working = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setStatus("loading");
    setData(null);
    setConfirmation(null);
    async function load() {
      if (!uuidPattern.test(seasonId)) {
        if (active) setStatus("denied");
        return;
      }
      const saved = readAdminPending(user, seasonId);
      const latest = validateAdminSeason(await api.adminSeason(seasonId, user), seasonId);
      const [memberResult, invitationResult] = await Promise.allSettled([
        api.adminMembers?.(seasonId, user) ?? Promise.resolve([]),
        api.adminInvitations?.(seasonId, user) ?? Promise.resolve([]),
      ]);
      // Optional operational metadata must never prevent the authoritative
      // lifecycle/visibility panel from loading. A missing or denied optional
      // RPC is represented as an empty section and can be retried explicitly.
      const memberRows = memberResult.status === "fulfilled" ? memberResult.value : [];
      const invitationRows = invitationResult.status === "fulfilled" ? invitationResult.value : [];
      if (!active) return;
      // Lifecycle has no replay contract. A successful authoritative read is
      // its only recovery path, including after reload. Never resend it here.
      for (const action of saved) {
        if (action.kind === "lifecycle") removeAdminPending(action);
      }
      setPending(readAdminPending(user, seasonId)[0] ?? null);
      setData(latest);
      setMembers(memberRows);
      setInvitations(invitationRows);
      setMessage("");
      setStatus("ready");
    }
    load().catch((error) => {
      if (active) setStatus(adminDenied(error) ? "denied" : "error");
    });
    return () => {
      active = false;
    };
  }, [api, user, seasonId, attempt]);

  // A different tab may leave intent behind. Recheck our scope without sending
  // mutations; unrelated account/season storage events have no effect.
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (
        (event.key === null ||
          event.key.startsWith(adminScope(user, seasonId))) &&
        !working.current
      ) {
        setStatus("loading");
        setAttempt((n) => n + 1);
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [user, seasonId]);

  function refresh() {
    if (working.current) return;
    setStatus("loading");
    setConfirmation(null);
    setAttempt((n) => n + 1);
  }
  function choose(next: Confirmation) {
    if (working.current || status !== "ready" || pending) return;
    setMessage("");
    setConfirmation(next);
  }
  function reloadAfterWrite() {
    if (!mounted.current) return;
    setStatus("loading");
    setAttempt((n) => n + 1);
  }
  async function sendVisibility(action: VisibilityAction) {
    try {
      const receipt = await api.setLoveVisibility(action);
      validateVisibilityReceipt(receipt, action);
      // Remove only after validating every receipt binding. Never use its
      // historical visibility as current state, even on an ordinary success.
      removeAdminPending(action);
      reloadAfterWrite();
    } catch (error) {
      if (!mounted.current) return;
      if (adminDenied(error)) {
        setData(null);
        setStatus("denied");
      } else if (visibilityRejected(error)) {
        try {
          removeAdminPending(action);
          setPending(null);
          setStatus("error");
        } catch {
          setMessage(
            "Browser storage is unavailable. Restore it, then retry the saved change.",
          );
        }
      } else {
        setMessage(
          "We couldn’t confirm that visibility change. Retry the saved change before continuing.",
        );
      }
    }
  }
  async function submit() {
    if (
      working.current ||
      status !== "ready" ||
      !data ||
      pending ||
      !confirmation
    )
      return;
    const selected = confirmation;
    if (selected.kind === "visibility" && !data.canChange) return;
    if (
      selected.kind === "lifecycle" &&
      (selected.from !== data.state ||
        selected.to !== nextSeasonState(data.state))
    )
      return;
    working.current = true;
    setBusy(true);
    setMessage("");
    setConfirmation(null);
    let action: PendingAdmin;
    try {
      // Check again at confirmation so a saved action from another tab cannot
      // be silently overwritten or replaced with a new UUID.
      const saved = readAdminPending(user, seasonId)[0];
      if (saved) {
        setPending(saved);
        return;
      }
      action = {
        ...selected,
        userId: user,
        seasonId,
        actionId: crypto.randomUUID(),
      };
      saveAdminPending(action); // Failure here must prevent any server write.
      setPending(action);
      if (action.kind === "visibility") {
        await sendVisibility(action);
      } else {
        try {
          const receipt = await api.transitionSeason(seasonId, user, action.to);
          if (receipt !== action.to)
            throw new Error("Invalid transition receipt");
          reloadAfterWrite();
        } catch (error) {
          if (!mounted.current) return;
          if (adminDenied(error)) {
            setData(null);
            setStatus("denied");
          } else {
            setMessage(
              "We couldn’t confirm the season change. Refresh the season state before choosing another action.",
            );
          }
        }
      }
    } catch {
      if (mounted.current) {
        setMessage(
          "We couldn’t save recovery information. Check browser storage, then refresh before trying again.",
        );
        setStatus("error");
      }
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function retryVisibility() {
    if (
      working.current ||
      status !== "ready" ||
      !data?.canChange ||
      pending?.kind !== "visibility"
    )
      return;
    working.current = true;
    setBusy(true);
    await sendVisibility(pending);
    working.current = false;
    if (mounted.current) setBusy(false);
  }

  const next = data && nextSeasonState(data.state);
  const disabled = busy || !!pending || !!confirmation;
  const confirmLabel =
    confirmation?.kind === "lifecycle"
      ? transitionLabels[confirmation.to].toLowerCase()
      : confirmation?.visible
        ? "open love similarity"
        : "hide love similarity";
  async function invite() {
    const email = inviteEmail.trim();
    if (!email || !api.inviteMember) return;
    setMemberBusy(true); setMemberMessage("");
    try {
      await api.inviteMember(seasonId, user, email);
      setInviteEmail("");
      setMemberMessage("Invitation recorded.");
      refresh();
    } catch { setMemberMessage("Could not record that invitation."); }
    finally { setMemberBusy(false); }
  }
  async function changeRole(member: AdminMember) {
    if (!api.setMemberRole) return;
    setMemberBusy(true); setMemberMessage("");
    try {
      await api.setMemberRole(seasonId, user, member.user_id, member.role === "admin" ? "member" : "admin");
      setMemberMessage("Role updated.");
      refresh();
    } catch (error) {
      setMemberMessage(error instanceof Error && /last_admin/i.test(error.message) ? "A season must keep at least one admin." : "Could not update that role.");
    } finally { setMemberBusy(false); }
  }
  return (
    <section className="season-admin">
      <SeasonNavigation
        seasonId={seasonId}
        current="admin"
        seasonName={data?.name}
      />
      <p className="eyebrow">For this season’s admins</p>
      <h1>Season admin</h1>
      {status === "loading" && <p role="status">Loading season settings…</p>}
      {status === "denied" && (
        <p role="alert" className="notice">
          Admin controls aren’t available to this account for this season.
          Return Home or switch accounts.
        </p>
      )}
      {status === "error" && (
        <div className="notice" role="alert">
          <p>
            {message ||
              "We couldn’t load or verify the current settings. Check your connection and browser storage, then try again."}
          </p>
          <button onClick={refresh} disabled={busy}>
            Try again
          </button>
        </div>
      )}
      {status === "denied" && (
        <button onClick={refresh} disabled={busy}>
          Check access again
        </button>
      )}
      {status === "ready" && data && (
        <>
          <div className="admin-heading-row">
            <p>Manage the season stage and love-similarity visibility.</p>
            <button onClick={refresh} disabled={busy || !!confirmation}>
              Refresh settings
            </button>
          </div>
          {pending && (
            <div className="notice" role="alert">
              <p>
                {message ||
                  (pending.kind === "visibility"
                    ? !data.canChange
                      ? "A visibility change is saved for this season. It cannot be retried before REVEAL. Refresh settings to check the season state."
                      : `An unconfirmed change to ${pending.visible ? "open" : "hide"} love similarity is saved for this account and season. Retry it before making another change.`
                    : "Check the current season state before making another change.")}
              </p>
              <button
                onClick={
                  pending.kind === "visibility" ? retryVisibility : refresh
                }
                disabled={
                  busy || (pending.kind === "visibility" && !data.canChange)
                }
              >
                {pending.kind === "visibility"
                  ? "Retry saved visibility change"
                  : "Refresh season state"}
              </button>
            </div>
          )}
          <section className="admin-card" aria-labelledby="lifecycle-heading">
            <h2 id="lifecycle-heading">Season lifecycle</h2>
            <p>
              Current state: <strong>{data.state}</strong>
            </p>
            <ol className="admin-states" aria-label="Season stages">
              {seasonStates.map((state) => (
                <li
                  key={state}
                  aria-current={state === data.state ? "step" : undefined}
                >
                  {state}
                </li>
              ))}
            </ol>
            <p className="fine">
              Move forward one step at a time. Voting cannot be reopened after
              it closes.
            </p>
            {next ? (
              <button
                className="primary"
                disabled={disabled}
                onClick={() =>
                  choose({ kind: "lifecycle", from: data.state, to: next })
                }
              >
                {transitionLabels[next]}
              </button>
            ) : (
              <p>The season has reached REVEAL. Voting stays closed.</p>
            )}
          </section>
          <section className="admin-card" aria-labelledby="visibility-heading">
            <h2 id="visibility-heading">Love similarity</h2>
            <p>
              Category visibility:{" "}
              <strong>{data.visible ? "Open" : "Hidden"}</strong>
            </p>
            <p>
              {data.canChange
                ? "Open this category deliberately for members of this season."
                : "Changes are available only after REVEAL. Entering REVEAL does not open this category."}
            </p>
            {data.visible && (
              <p className="fine">
                Hiding stops future reads. It cannot take back information
                members have already seen.
              </p>
            )}
            <button
              disabled={disabled || !data.canChange}
              onClick={() =>
                choose({ kind: "visibility", visible: !data.visible })
              }
            >
              {data.visible ? "Hide love similarity" : "Open love similarity"}
            </button>
          </section>
          <section className="admin-card" aria-labelledby="members-heading">
            <h2 id="members-heading">Members</h2>
            <p className="fine">Lightweight progress only; votes and preferences stay private.</p>
            {members.length === 0 ? <p>No members found.</p> : (
              <ul className="admin-member-list">
                {members.map((member) => (
                  <li key={member.user_id}>
                    <strong>{member.nickname}</strong> <span className="fine">({member.role})</span>
                    <span className="fine">{member.rated}/{member.active_tracks} rated · {member.super_likes_available} Super Likes left</span>
                    <button className="member-role-button" disabled={memberBusy || member.user_id === user} onClick={() => changeRole(member)}>
                      {member.role === "admin" ? "Demote" : "Make admin"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="fine">{invitations.filter((item) => !item.accepted_by).length} pending invitation(s).</p>
            <div className="admin-member-invite">
              <label htmlFor="invite-email">Invite by verified Google email</label>
              <div className="admin-heading-row">
                <input id="invite-email" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="name@example.com" />
                <button onClick={invite} disabled={memberBusy || !inviteEmail.trim()}>Invite</button>
              </div>
            </div>
            {memberMessage && <p className="fine" role="status">{memberMessage}</p>}
          </section>
          {confirmation && (
            <div
              className="admin-confirm"
              role="group"
              aria-labelledby="admin-confirm-title"
            >
              <h2 id="admin-confirm-title">Confirm {confirmLabel}?</h2>
              <p>
                {confirmation.kind === "visibility"
                  ? confirmation.visible
                    ? "Members of this season will be able to access love-similarity summaries."
                    : "Future reads will be blocked. Information already delivered cannot be withdrawn."
                  : confirmation.to === "LOCKED"
                    ? "This closes voting for every member. It cannot be reopened. Results remain secret."
                    : confirmation.to === "REVEAL"
                      ? "This enters the final season stage. Love similarity stays hidden until you open it separately."
                      : "Members of this season will be able to submit and edit their votes."}
              </p>
              <div className="admin-confirm-actions">
                <button
                  autoFocus
                  onClick={() => setConfirmation(null)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button className="primary" onClick={submit} disabled={busy}>
                  Confirm {confirmLabel}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
