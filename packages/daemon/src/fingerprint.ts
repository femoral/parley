/**
 * Host fingerprinting for runner registration (ADR-0029 / #314).
 *
 * Shared by the remote runner and any daemon-side surfaces that need the same
 * PATH + adapter model-catalog probe. Vendor-bin detection used to live only
 * in the CLI init path — it lives here so runner and daemon cannot fork.
 */
import fs from "node:fs";
import path from "node:path";
import {
  getShippedVendorModels,
  type ModelEntry,
  type ModelProber,
  type ParleyConfig,
  type ProbedModels,
  type RunnerCapabilities,
  type RunnerVendorCapability,
  type VendorModels,
} from "@useparley/core";

/**
 * Built-in vendor ids and default CLI binary names (adapter DEFAULT_*_BIN).
 * Detection walks PATH (or absolute override) for these names.
 */
export const BUILTIN_VENDOR_BINS: Readonly<Record<string, string>> = {
  claude: "claude",
  cline: "cline",
  codex: "codex",
  cursor: "cursor-agent",
  fake: "fake",
  antigravity: "agy",
  goose: "goose",
  grok: "grok",
  hermes: "hermes",
  kilo: "kilo",
  kimi: "kimi",
  openclaw: "openclaw",
  opencode: "opencode",
  openhands: "openhands",
  pi: "pi",
};

export const BUILTIN_VENDOR_IDS = Object.keys(BUILTIN_VENDOR_BINS);

/** True when `bin` is executable on PATH or as an absolute path. */
export function isExecutableOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (bin.includes(path.sep) || path.isAbsolute(bin)) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

/**
 * Detect which built-in vendor CLIs are available.
 * Respects `vendors.<id>.bin` overrides. `fake` only when
 * `PARLEY_FAKE_VENDOR_BIN` or `vendors.fake.bin` is set (and executable).
 */
export function detectHarnesses(
  config: ParleyConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const found: string[] = [];
  for (const id of BUILTIN_VENDOR_IDS) {
    const override = config.vendors?.[id]?.bin;
    if (id === "fake") {
      // Test double: only when explicitly configured. Accept an existing path
      // (script may not be +x; spawn uses node on the script) or a PATH hit.
      const fakeBin = override ?? env.PARLEY_FAKE_VENDOR_BIN;
      if (fakeBin === undefined || fakeBin === "") continue;
      if (path.isAbsolute(fakeBin) || fakeBin.includes(path.sep)) {
        if (fs.existsSync(fakeBin)) found.push(id);
      } else if (isExecutableOnPath(fakeBin, env)) {
        found.push(id);
      }
      continue;
    }
    const bin = override ?? BUILTIN_VENDOR_BINS[id]!;
    if (isExecutableOnPath(bin, env)) found.push(id);
  }
  return found;
}

/** Per-vendor probe budget so a hung CLI never blocks registration. */
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;

async function safeDiscover(
  hook: ((existing: VendorModels | undefined) => Promise<ProbedModels>) | undefined,
  existing: VendorModels | undefined,
  timeoutMs: number,
): Promise<ProbedModels | null> {
  if (!hook) return null;
  try {
    const probed = await Promise.race([
      hook(existing),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeoutMs).unref();
      }),
    ]);
    if (probed === null || probed.models.length === 0) return null;
    return probed;
  } catch {
    return null;
  }
}

function cloneModels(models: ModelEntry[]): ModelEntry[] {
  return models.map((m) => ({
    id: m.id,
    efforts: [...m.efforts],
    default_effort: m.default_effort,
    ...(m.label !== undefined ? { label: m.label } : {}),
    ...(m.notes !== undefined ? { notes: m.notes } : {}),
  }));
}

/**
 * Probe one adapter for an advisory model catalog (disk → optional CLI → shipped).
 * Fail-soft: never throws; empty models when nothing is available.
 *
 * Registration must stay fast on a fully-tooled host: prefer disk + shipped
 * (milliseconds). Only shell out to `listModels` when both are empty so a hung
 * vendor CLI cannot stall the fleet advertisement (ADR-0029 / #314).
 */
export async function probeVendorModels(
  adapter: ModelProber | undefined,
  vendorId: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ModelEntry[]> {
  const existing = getShippedVendorModels(vendorId);
  if (!adapter) {
    return existing !== undefined ? cloneModels(existing.models) : [];
  }
  const disk = await safeDiscover(adapter.readModels?.bind(adapter), existing, timeoutMs);
  if (disk !== null && disk.models.length > 0) {
    // Disk hit: skip the slow CLI probe for registration freshness.
    return cloneModels(disk.models);
  }
  if (existing !== undefined && existing.models.length > 0) {
    // Shipped catalog is good enough for routing; re-fingerprint later can
    // deepen catalogs if a vendor gains a richer disk cache.
    return cloneModels(existing.models);
  }
  // No disk, no shipped — last resort CLI probe with a hard timeout.
  const probe = await safeDiscover(adapter.listModels?.bind(adapter), existing, timeoutMs);
  if (probe !== null && probe.models.length > 0) {
    return cloneModels(probe.models);
  }
  return [];
}

export interface FingerprintOptions {
  /** Adapter registry (builtins + plugins) on this host. */
  adapters: Map<string, ModelProber & { id: string }>;
  config?: ParleyConfig;
  env?: NodeJS.ProcessEnv;
}

/**
 * Fingerprint this host: vendor bins on PATH plus plugin adapters in the
 * registry, each with a model catalog from readModels/listModels/shipped.
 */
export async function fingerprintCapabilities(
  options: FingerprintOptions,
): Promise<RunnerCapabilities> {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const detected = new Set(detectHarnesses(config, env));

  // Plugin / non-builtin adapters load only when configured — advertise them
  // even when no PATH bin exists (the plugin is the capability signal).
  for (const id of options.adapters.keys()) {
    if (!(id in BUILTIN_VENDOR_BINS)) {
      detected.add(id);
    }
  }

  const vendors: RunnerVendorCapability[] = [];
  // Stable order: builtins first (BUILTIN_VENDOR_IDS order), then other ids sorted.
  const ordered: string[] = [];
  for (const id of BUILTIN_VENDOR_IDS) {
    if (detected.has(id) && options.adapters.has(id)) ordered.push(id);
  }
  for (const id of [...detected].sort()) {
    if (!ordered.includes(id) && options.adapters.has(id)) ordered.push(id);
  }

  // Parallel per-vendor probe — host may have many bins on PATH.
  const probed = await Promise.all(
    ordered.map(async (id) => {
      const models = await probeVendorModels(options.adapters.get(id), id);
      return { id, models } satisfies RunnerVendorCapability;
    }),
  );
  vendors.push(...probed);

  return { vendors };
}
