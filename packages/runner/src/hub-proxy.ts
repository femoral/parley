import http from "node:http";
import { TASK_HEADER } from "@useparley/core";

/**
 * Local hub proxy: children on the runner host talk to `127.0.0.1:<port>`;
 * the proxy forwards `/child/*`, `/mcp`, and `/xai/*` to the daemon with the
 * right correlation headers and bearer token (ADR-0012 / #327).
 *
 * Auth channels (#327):
 * - `/child/*` + `/mcp`: runner token in `Authorization` (child channel has no
 *   third-party credential to preserve).
 * - `/xai/*`: child's `Authorization` (xAI API key) is forwarded untouched;
 *   runner credential rides in `Proxy-Authorization` so the daemon lease gate
 *   can authenticate without overwriting the key that api.x.ai needs, and so
 *   the hop-by-hop runner token never reaches the third-party origin.
 */
export interface HubProxy {
  /** Base URL children should use (no path), e.g. `http://127.0.0.1:12345`. */
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface StartHubProxyOptions {
  daemonUrl: string;
  /**
   * Runner bearer token (`runners.<name>.token`). Attached on every upstream
   * hop so non-loopback daemons accept child-contract traffic (#323 /
   * ADR-0030). Harmless on loopback (tokenless trust still applies).
   *
   * Placement depends on the route: `Authorization` for `/child/*` + `/mcp`;
   * `Proxy-Authorization` for `/xai/*` (see module docs).
   */
  token: string;
  taskId: string;
}

function denyAllowlist(res: http.ServerResponse): void {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      error: "hub proxy only forwards /child/*, /mcp, and /xai/*",
    }),
  );
}

export async function startHubProxy(options: StartHubProxyOptions): Promise<HubProxy> {
  const { daemonUrl, taskId, token } = options;

  const server = http.createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const targetPath = url.pathname + url.search;
      const isXai = url.pathname.startsWith("/xai/");

      // Only forward child contract, MCP, and xAI usage proxy — never the
      // full daemon surface (#327: /xai/* was previously denied, which made
      // grok usage capture silently dead on runner-hosted children).
      const allowed =
        url.pathname === "/mcp" ||
        url.pathname.startsWith("/child/") ||
        isXai;
      if (!allowed) {
        denyAllowlist(res);
        return;
      }

      // Pin path task id to this proxy's lease so a child cannot attribute
      // usage to a sibling task on the same runner (#327 defect 2).
      if (isXai) {
        const segments = url.pathname.split("/").filter((s) => s !== "");
        const pathTaskId = segments[1];
        if (pathTaskId === undefined || pathTaskId === "" || pathTaskId !== taskId) {
          denyAllowlist(res);
          return;
        }
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      const headers: Record<string, string> = {
        "content-type":
          typeof req.headers["content-type"] === "string"
            ? req.headers["content-type"]
            : "application/json",
        [TASK_HEADER]: taskId,
      };

      if (isXai) {
        // Preserve the child's xAI API key; put the runner credential on a
        // hop-by-hop header the daemon gate reads and xai-proxy strips.
        if (typeof req.headers.authorization === "string") {
          headers.authorization = req.headers.authorization;
        }
        if (token !== "") {
          headers["proxy-authorization"] = `Bearer ${token}`;
        }
      } else {
        // Child channel / MCP: runner token is the sole auth credential.
        if (token !== "") {
          headers.authorization = `Bearer ${token}`;
        }
      }
      // Preserve accept for MCP streamable HTTP.
      if (typeof req.headers.accept === "string") {
        headers.accept = req.headers.accept;
      }

      const upstream = await fetch(`${daemonUrl}${targetPath}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
      });

      const outHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        // Hop-by-hop headers must not be forwarded.
        if (key === "transfer-encoding" || key === "connection") return;
        outHeaders[key] = value;
      });
      res.writeHead(upstream.status, outHeaders);

      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) res.write(Buffer.from(value));
          }
        } finally {
          res.end();
        }
      } else {
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.end(buf);
      }
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: `hub proxy upstream failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
      } else {
        res.end();
      }
    });
  });

  return new Promise<HubProxy>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("hub proxy did not bind a TCP port"));
        return;
      }
      const port = address.port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => {
              if (err) rejectClose(err);
              else resolveClose();
            });
            server.closeAllConnections();
          }),
      });
    });
  });
}
