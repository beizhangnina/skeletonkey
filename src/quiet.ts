/**
 * `node:sqlite` is still flagged experimental in Node 22 and prints a warning on
 * first use. Swallow just that one so CLI output stays clean; everything else is
 * re-emitted as usual.
 */
export function silenceSqliteExperimentalWarning(): void {
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
    if (listeners.length > 0) {
      for (const listener of listeners) listener(warning);
      return;
    }
    console.error(`${warning.name}: ${warning.message}`);
  });
}
