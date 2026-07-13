import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.body.className = "";
  vi.useRealTimers();
});
class TestResizeObserver implements ResizeObserver {
  readonly observed = new Set<Element>();
  observe(target: Element): void { this.observed.add(target); }
  unobserve(target: Element): void { this.observed.delete(target); }
  disconnect(): void { this.observed.clear(); }
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: TestResizeObserver,
});

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  value: vi.fn(),
});

Object.defineProperty(window, "requestAnimationFrame", {
  configurable: true,
  writable: true,
  value: (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 0),
});
Object.defineProperty(window, "cancelAnimationFrame", {
  configurable: true,
  writable: true,
  value: (id: number) => window.clearTimeout(id),
});
