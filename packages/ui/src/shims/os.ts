/** Browser shim for `node:os` when core modules leak into the client bundle. */
export function homedir(): string {
  return "/";
}

const os = { homedir };
export default os;
