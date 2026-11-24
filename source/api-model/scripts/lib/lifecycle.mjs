// Process-lifecycle helpers for generation: signal-safe cleanup and an exclusive
// build lock.
import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";

import { buildDir, lockFile } from "./paths.mjs";

/**
 * @typedef {object} ProcessLike
 * @property {number} pid
 * @property {(event: string, listener: () => void) => unknown} once
 * @property {(event: string, listener: () => void) => unknown} removeListener
 * @property {(pid: number, signal: string) => unknown} kill
 */

/**
 * Makes cleanup idempotent and signal-safe. try/finally does not run when the
 * process is killed, so an interrupted Brazil build would otherwise leave the
 * wrapper properties stripped of their pinned checksum and the lock file
 * stranded. Returns a run() that is safe to call more than once.
 *
 * Every path detaches its listeners in a `finally`, and the signal path
 * re-raises there too, so a throwing `cleanup` can never leave the process with
 * dangling handlers or a swallowed signal — the normal-path caller still sees
 * the cleanup error propagate.
 *
 * @param {() => void} cleanup
 * @param {ProcessLike} [proc]
 */
export function onExit(cleanup, proc = process) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    cleanup();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const signalListeners = new Map();
  const detach = () => {
    proc.removeListener("exit", onProcessExit);
    for (const [signal, listener] of signalListeners) {
      proc.removeListener(signal, listener);
    }
  };
  const onProcessExit = () => {
    try {
      run();
    } finally {
      detach();
    }
  };
  const onSignal = (signal) => {
    try {
      run();
    } finally {
      detach();
      // Re-raise with the default disposition so the caller sees a real signal
      // exit rather than a plain non-zero status.
      proc.kill(proc.pid, signal);
    }
  };
  proc.once("exit", onProcessExit);
  for (const signal of signals) {
    const listener = () => onSignal(signal);
    signalListeners.set(signal, listener);
    proc.once(signal, listener);
  }
  return () => {
    try {
      run();
    } finally {
      detach();
    }
  };
}

/** Exclusive lock so two concurrent builds cannot race on the same output. */
export function acquireLock(dir = buildDir, file = lockFile) {
  mkdirSync(dir, { recursive: true });
  try {
    closeSync(openSync(file, "wx"));
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `another generation is in progress (${file}); ` +
          "remove that file if no build is running",
      );
    }
    throw error;
  }
  return () => {
    try {
      unlinkSync(file);
    } catch {
      /* already released */
    }
  };
}
