import { DaemonTransportError, sleep } from "@useparley/core";

/** Three retries after the initial read; never retry HTTP or usage errors. */
export async function watchRead<T>(read: () => Promise<T>, note: (text: string) => void): Promise<T> {
  for (let retry = 0; ; retry++) {
    try { return await read(); }
    catch (err) {
      if (!(err instanceof DaemonTransportError)) throw err;
      if (retry === 3) {
        throw new Error(`watch transport failed after 3 retries: ${err.message}. Re-running watch is safe; unacknowledged events remain available.`, { cause: err });
      }
      const delay = 250 * 2 ** retry;
      note(`watch: transport retry ${retry + 1}/3 in ${delay}ms: ${err.message}\n`);
      await sleep(delay);
    }
  }
}
