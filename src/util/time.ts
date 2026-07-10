/** Resolve after `ms` milliseconds. Shared by the daemon's poll/retry loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
