import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Choice, Track } from "./api";
import { Artwork } from "./Artwork";
import {
  releasedChoice,
  swipeIntent,
  swipeThresholds,
  SWIPE_ACTIVATION,
} from "./swipe";

type Drag = { id: number; x: number; y: number; width: number; height: number };
export function SwipeCard({
  track,
  enabled,
  saving,
  exit,
  entering,
  onEntered,
  onChoice,
}: {
  track: Track;
  enabled: boolean;
  saving: boolean;
  exit: Choice | null;
  entering: boolean;
  onEntered: () => void;
  onChoice: (choice: Choice) => Promise<boolean>;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const touches = useRef(new Set<number>());
  const stopDrag = useCallback(() => {
    const active = drag.current;
    drag.current = null; // Clear before releasing capture; lostcapture must never commit.
    const el = surface.current;
    if (!el) return;
    el.dataset.dragging = "false";
    if (active && el.hasPointerCapture?.(active.id))
      el.releasePointerCapture(active.id);
  }, []);
  const reset = useCallback(() => {
    stopDrag();
    const el = surface.current;
    if (!el) return;
    el.dataset.intent = "";
    el.style.setProperty("--drag-x", "0px");
    el.style.setProperty("--drag-y", "0px");
    el.style.setProperty("--drag-rotation", "0deg");
    el.style.setProperty("--intent-strength", "0");
  }, [stopDrag]);
  const cancelDrag = useCallback(() => {
    // After release, capture loss/blur cannot rewind an already submitted card.
    if (drag.current) reset();
  }, [reset]);
  useEffect(() => {
    // A second finger anywhere on the document cancels, including outside this surface.
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      touches.current.add(e.pointerId);
      if (touches.current.size > 1) cancelDrag();
    };
    const end = (e: PointerEvent) => {
      touches.current.delete(e.pointerId);
    };
    const cancel = () => {
      touches.current.clear();
      cancelDrag();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") cancel();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", end, true);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("blur", cancel);
    window.addEventListener("pagehide", cancel);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", end, true);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pagehide", cancel);
      reset();
    };
  }, [cancelDrag, reset]);
  useEffect(() => {
    if (!enabled) cancelDrag();
  }, [enabled, cancelDrag]);

  function start(e: ReactPointerEvent<HTMLDivElement>) {
    if (!enabled || e.button !== 0 || touches.current.size > 1 || !e.isPrimary)
      return;
    if (drag.current) {
      reset();
      return;
    }
    if (entering) onEntered();
    const rect = e.currentTarget.getBoundingClientRect();
    drag.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      width: rect.width,
      height: rect.height,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      reset();
    }
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!enabled || !active || active.id !== e.pointerId) return;
    const x = e.clientX - active.x,
      y = e.clientY - active.y;
    const intent = swipeIntent(x, y);
    const threshold = swipeThresholds(active.width, active.height);
    const el = e.currentTarget;
    el.dataset.dragging = "true";
    el.dataset.intent = intent ?? "";
    const activated = Math.hypot(x, y) >= SWIPE_ACTIVATION;
    // Clamp only the presentation; raw displacement keeps downward diagonals neutral.
    const downward = y > 0 && intent !== "PASS" && intent !== "LIKE";
    el.style.setProperty("--drag-x", `${activated && !downward ? x : 0}px`);
    el.style.setProperty("--drag-y", `${activated ? Math.min(y, 0) : 0}px`);
    el.style.setProperty(
      "--drag-rotation",
      `${intent === "PASS" || intent === "LIKE" ? Math.max(-7, Math.min(7, (x / active.width) * 12)) : 0}deg`,
    );
    el.style.setProperty(
      "--intent-strength",
      String(
        intent
          ? Math.min(
              1,
              intent === "SUPER_LIKE"
                ? -y / threshold.up
                : Math.abs(x) / threshold.horizontal,
            )
          : 0,
      ),
    );
  }
  function release(e: ReactPointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.id !== e.pointerId) return;
    const choice = enabled
      ? releasedChoice(
          e.clientX - active.x,
          e.clientY - active.y,
          active.width,
          active.height,
        )
      : null;
    if (!choice) {
      reset();
      return;
    }
    // Use the final release position, even when it differs from the last move.
    // Hold it through saving; the confirmed exit continues from these offsets.
    move(e);
    stopDrag();
    void onChoice(choice).then((confirmed) => {
      if (!confirmed) reset();
    }, reset);
  }
  return (
    <div
      ref={surface}
      className="swipe-card"
      role="group"
      aria-label={`Swipe to rate ${track.title}`}
      aria-describedby="swipe-hint"
      data-enabled={enabled}
      data-exit={exit ?? ""}
      data-entering={entering}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={cancelDrag}
      onLostPointerCapture={cancelDrag}
      onDragStart={(e) => e.preventDefault()}
      onAnimationEnd={onEntered}
    >
      <div className="swipe-feedback" aria-hidden="true">
        <span className="intent-pass">← PASS</span>
        <span className="intent-like">LIKE →</span>
        <span className="intent-super">↑ SUPER LIKE</span>
      </div>
      <Artwork key={track.id} track={track} />
      <p className="card-caption" aria-hidden="true">
        {saving
          ? "Saving your choice…"
          : exit
            ? "Confirmed"
            : "Drag the card · release to choose"}
      </p>
    </div>
  );
}
