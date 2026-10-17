import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SwipeCard } from "../../src/SwipeCard";
import { releasedChoice, swipeThresholds } from "../../src/swipe";
import type { Choice, Track } from "../../src/api";
const track: Track = {
  id: "track",
  title: "Track",
  artists: [],
  artwork_url: null,
  spotify_url: null,
  apple_music_url: null,
};
const point = (x: number, y: number, pointerId = 1) => ({
  clientX: 150 + x,
  clientY: 200 + y,
  pointerId,
  pointerType: "touch",
  isPrimary: pointerId === 1,
  button: 0,
});
function card(enabled = true, allowUp = true) {
  const onChoice = vi.fn().mockResolvedValue(true);
  const view = render(
    <SwipeCard
      track={track}
      enabled={enabled}
      allowUp={allowUp}
      exit={null}
      entering={false}
      onEntered={() => {}}
      onChoice={onChoice}
    />,
  );
  const surface = screen.getByRole("group", { name: "Swipe to rate Track" });
  vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
    width: 320,
    height: 360,
  } as DOMRect);
  fireEvent.pointerDown(surface, point(0, 0));
  return { surface, onChoice, view };
}
describe("deliberate swipe", () => {
  it.each([
    [0, 0],
    [6, -7],
    [79, 0],
    [0, -89],
    [110, -100],
    [10, 140],
  ])("does not vote at final displacement %j, %j", (x, y) => {
    const { surface, onChoice } = card();
    fireEvent.pointerMove(surface, point(x, y));
    fireEvent.pointerUp(surface, point(x, y));
    expect(onChoice).not.toHaveBeenCalled();
    expect(surface.style.getPropertyValue("--drag-x")).toBe("0px");
  });
  it("lets the finger cross the threshold and return inside before release", () => {
    const { surface, onChoice } = card();
    fireEvent.pointerMove(surface, point(130, 0));
    expect(onChoice).not.toHaveBeenCalled();
    expect(surface.dataset.intent).toBe("LIKE");
    expect(surface.style.getPropertyValue("--intent-strength")).toBe("1");
    fireEvent.pointerMove(surface, point(25, 0));
    fireEvent.pointerUp(surface, point(25, 0));
    expect(onChoice).not.toHaveBeenCalled();
  });
  it.each([
    [0, 140],
    [10, 140],
    [-110, 100],
    [110, 100],
  ])(
    "keeps downward drag %s, %s centered without turning it into a vote",
    (x, y) => {
      const { surface, onChoice } = card();
      fireEvent.pointerMove(surface, point(x, y));
      expect(surface.style.getPropertyValue("--drag-x")).toBe("0px");
      expect(surface.style.getPropertyValue("--drag-y")).toBe("0px");
      expect(surface.style.getPropertyValue("--drag-rotation")).toBe("0deg");
      expect(surface.style.getPropertyValue("--intent-strength")).toBe("0");
      expect(surface.dataset.intent).toBe("");
      fireEvent.pointerUp(surface, point(x, y));
      expect(onChoice).not.toHaveBeenCalled();
    },
  );
  it("cancels an upward swipe even after returning past the center downward", () => {
    const { surface, onChoice } = card();
    fireEvent.pointerMove(surface, point(3, -130));
    expect(surface.dataset.intent).toBe("SUPER_LIKE");
    fireEvent.pointerMove(surface, point(3, 40));
    expect(surface.style.getPropertyValue("--drag-y")).toBe("0px");
    expect(surface.dataset.intent).toBe("");
    fireEvent.pointerUp(surface, point(3, 40));
    expect(onChoice).not.toHaveBeenCalled();
  });
  it.each<[number, number, Choice]>([
    [-100, 5, "PASS"],
    [100, 5, "LIKE"],
    [5, -100, "SUPER_LIKE"],
  ])(
    "allows reversing a downward drag into %s, %s before release",
    (x, y, choice) => {
      const { surface, onChoice } = card();
      fireEvent.pointerMove(surface, point(10, 140));
      expect(onChoice).not.toHaveBeenCalled();
      fireEvent.pointerMove(surface, point(x, y));
      fireEvent.pointerUp(surface, point(x, y));
      expect(onChoice).toHaveBeenCalledExactlyOnceWith(choice);
    },
  );
  it.each<[number, number, Choice]>([
    [-90, 0, "PASS"],
    [100, 5, "LIKE"],
    [3, -100, "SUPER_LIKE"],
  ])("commits once on release at %s, %s", (x, y, choice) => {
    const { surface, onChoice } = card();
    fireEvent.pointerMove(surface, point(x, y));
    expect(onChoice).not.toHaveBeenCalled();
    fireEvent.pointerUp(surface, point(x, y));
    fireEvent.pointerUp(surface, point(x, y));
    expect(onChoice).toHaveBeenCalledExactlyOnceWith(choice);
    expect(surface.style.getPropertyValue("--drag-x")).toBe(`${x}px`);
    expect(surface.style.getPropertyValue("--drag-y")).toBe(
      `${Math.min(y, 0)}px`,
    );
    fireEvent.lostPointerCapture(surface, point(x, y));
    fireEvent.pointerCancel(surface, point(x, y));
    fireEvent(window, new Event("blur"));
    expect(surface.style.getPropertyValue("--drag-x")).toBe(`${x}px`);
    expect(surface.style.getPropertyValue("--drag-y")).toBe(
      `${Math.min(y, 0)}px`,
    );
  });
  it("holds the final release position rather than the last move", () => {
    const { surface } = card();
    fireEvent.pointerMove(surface, point(95, 0));
    fireEvent.pointerUp(surface, point(140, -10));
    expect(surface.style.getPropertyValue("--drag-x")).toBe("140px");
    expect(surface.style.getPropertyValue("--drag-y")).toBe("-10px");
  });
  it("returns to the center when the submission is not confirmed", async () => {
    const { surface, onChoice } = card();
    onChoice.mockResolvedValueOnce(false);
    fireEvent.pointerMove(surface, point(120, 0));
    fireEvent.pointerUp(surface, point(120, 0));
    await waitFor(() =>
      expect(surface.style.getPropertyValue("--drag-x")).toBe("0px"),
    );
    expect(surface.dataset.intent).toBe("");
  });
  it("uses the final release position and direction, not the last move or speed", () => {
    const { surface, onChoice } = card();
    fireEvent.pointerMove(surface, point(120, 0));
    fireEvent.pointerUp(surface, point(30, 0));
    expect(onChoice).not.toHaveBeenCalled();
  });
  it.each([
    "pointerCancel",
    "lostPointerCapture",
    "blur",
    "pagehide",
    "hidden",
    "second-touch",
  ])("cancels on %s before release", (event) => {
    const { surface, onChoice } = card();
    fireEvent.pointerMove(surface, point(110, 0));
    if (event === "blur" || event === "pagehide")
      fireEvent(window, new Event(event));
    else if (event === "hidden") {
      const spy = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("hidden");
      fireEvent(document, new Event("visibilitychange"));
      spy.mockRestore();
    } else if (event === "second-touch")
      fireEvent.pointerDown(document.body, point(0, 0, 2));
    else if (event === "pointerCancel")
      fireEvent.pointerCancel(surface, point(110, 0));
    else fireEvent.lostPointerCapture(surface, point(110, 0));
    fireEvent.pointerUp(surface, point(110, 0));
    expect(onChoice).not.toHaveBeenCalled();
  });
  it("ignores events from a different pointer and stops a multi-touch sequence", () => {
    const { surface, onChoice } = card();
    fireEvent.pointerUp(surface, point(100, 0, 2));
    expect(onChoice).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body, point(0, 0, 2));
    fireEvent.pointerDown(surface, point(0, 0, 3));
    fireEvent.pointerMove(surface, point(120, 0, 3));
    fireEvent.pointerUp(surface, point(120, 0, 3));
    fireEvent.pointerUp(surface, point(120, 0));
    expect(onChoice).not.toHaveBeenCalled();
  });
  it("does not start disabled gestures", () => {
    const { surface, onChoice } = card(false);
    fireEvent.pointerMove(surface, point(120, 0));
    fireEvent.pointerUp(surface, point(120, 0));
    expect(onChoice).not.toHaveBeenCalled();
  });
  it("cancels route departure without a vote", () => {
    const { surface, view, onChoice } = card();
    fireEvent.pointerMove(surface, point(120, 0));
    view.unmount();
    fireEvent.pointerUp(surface, point(120, 0));
    expect(onChoice).not.toHaveBeenCalled();
  });
  it("limits horizontal rotation and keeps upward intent unrotated", () => {
    const { surface } = card();
    fireEvent.pointerMove(surface, point(500, 0));
    expect(surface.style.getPropertyValue("--drag-rotation")).toBe("7deg");
    fireEvent.pointerMove(surface, point(20, -120));
    expect(surface.style.getPropertyValue("--drag-rotation")).toBe("0deg");
  });
  it("clamps thresholds and reserves an ambiguous diagonal band", () => {
    expect(swipeThresholds(100, 100)).toEqual({ horizontal: 72, up: 80 });
    expect(swipeThresholds(1000, 1000)).toEqual({ horizontal: 120, up: 130 });
    expect(releasedChoice(130, -130, 320, 360)).toBeNull();
  });
});

describe("scroll-safe swipe mode", () => {
  it.each([
    [0, -140],
    [0, 140],
    [110, -100],
  ])(
    "yields vertical or ambiguous displacement %s, %s without a vote",
    (x, y) => {
      const { surface, onChoice } = card(true, false);
      fireEvent.pointerMove(surface, point(x, y));
      expect(surface.dataset.intent).toBe("");
      expect(surface.style.getPropertyValue("--drag-y")).toBe("0px");
      // Later sideways drift is still part of the same scroll, never a fresh swipe.
      fireEvent.pointerMove(surface, point(150, 0));
      fireEvent.pointerUp(surface, point(150, 0));
      expect(onChoice).not.toHaveBeenCalled();
    },
  );
  it("rejects upward release even without an intervening move event", () => {
    const { surface, onChoice } = card(true, false);
    fireEvent.pointerUp(surface, point(0, -140));
    expect(onChoice).not.toHaveBeenCalled();
  });
  it.each<[number, Choice]>([
    [-100, "PASS"],
    [100, "LIKE"],
  ])(
    "preserves deliberate horizontal choice %s, %s while allowing scrolling",
    (x, choice) => {
      const { surface, onChoice } = card(true, false);
      fireEvent.pointerMove(surface, point(x, -10));
      fireEvent.pointerUp(surface, point(x, -10));
      expect(onChoice).toHaveBeenCalledExactlyOnceWith(choice);
      expect(surface.style.getPropertyValue("--drag-y")).toBe("0px");
    },
  );
  it("cancels an active swipe when the viewport requires scrolling", () => {
    const { surface, onChoice, view } = card();
    fireEvent.pointerMove(surface, point(0, -140));
    view.rerender(
      <SwipeCard
        track={track}
        enabled
        allowUp={false}
        exit={null}
        entering={false}
        onEntered={() => {}}
        onChoice={onChoice}
      />,
    );
    fireEvent.pointerUp(surface, point(0, -140));
    expect(onChoice).not.toHaveBeenCalled();
    expect(surface.style.getPropertyValue("--drag-y")).toBe("0px");
  });
});
