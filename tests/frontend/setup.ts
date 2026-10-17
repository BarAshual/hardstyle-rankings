import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
// jsdom lacks PointerEvent/capture; preserve real coordinates and touch identity.
if (!window.PointerEvent) {
  Object.defineProperty(window, "PointerEvent", {
    value: class extends MouseEvent {
      readonly pointerId: number;
      readonly pointerType: string;
      readonly isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? "touch";
        this.isPrimary = init.isPrimary ?? true;
      }
    },
  });
}
Object.defineProperties(HTMLElement.prototype, {
  setPointerCapture: { configurable: true, value: () => {} },
  releasePointerCapture: { configurable: true, value: () => {} },
  hasPointerCapture: { configurable: true, value: () => false },
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
});
