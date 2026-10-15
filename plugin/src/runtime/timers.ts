export type TimerHandle = ReturnType<typeof setTimeout> | number;
interface TimerHost {
  setTimeout(callback: () => void, milliseconds: number): TimerHandle;
  clearTimeout(handle: TimerHandle | undefined): void;
  setInterval(callback: () => void, milliseconds: number): TimerHandle;
  clearInterval(handle: TimerHandle | undefined): void;
}
/** Own browser timers on the host window; retain Worker/Node portability for the shared core and tests. */
export function timerHost(): TimerHost {
  if (typeof window !== "undefined" && typeof window.setTimeout === "function" && typeof window.clearTimeout === "function" && typeof window.setInterval === "function" && typeof window.clearInterval === "function") return window;
  return { setTimeout, clearTimeout, setInterval, clearInterval };
}
