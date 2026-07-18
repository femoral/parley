import type { ModelCatalog, ModelEntry } from "./models.js";

export const SHIPPED_CATALOG_RETRIEVED_AT = "2026-07-18";

const entry = (
  id: string,
  efforts: string[] = [],
  default_effort: string | null = null,
): ModelEntry => ({ id, efforts, default_effort });

const claudeEfforts = ["low", "medium", "high", "xhigh", "max"];
const clineEfforts = ["none", "low", "medium", "high", "xhigh"];
const openclawEfforts = ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"];
const piEfforts = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const SHIPPED_MODEL_CATALOG: ModelCatalog = {
  claude: {
    fetched_at: SHIPPED_CATALOG_RETRIEVED_AT,
    source: "claude --help 2026-07-18 + docs/research/claude-code-cli-automation.md",
    models: ["sonnet", "opus", "haiku", "fable", "best", "default", "opusplan", "sonnet[1m]", "opus[1m]", "fable[1m]"].map((id) => entry(id, [...claudeEfforts])),
  },
  cline: {
    fetched_at: SHIPPED_CATALOG_RETRIEVED_AT,
    source: "docs/research/cline-cli-automation.md",
    effort_levels: [...clineEfforts],
    notes: "Observed default verified; no CLI model list.",
    models: [entry("kwaipilot/kat-coder-air-v2.5", [...clineEfforts])],
  },
  codex: {
    fetched_at: SHIPPED_CATALOG_RETRIEVED_AT,
    source: "packages/cli/tests/fixtures/codex/debug-models.json + research",
    models: [
      entry("gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"], "medium"),
      entry("gpt-5.4-mini", ["low", "medium", "high", "xhigh"], "medium"),
    ],
  },
  fake: {
    fetched_at: SHIPPED_CATALOG_RETRIEVED_AT,
    source: "stub",
    models: [entry("fake-model", ["low", "medium", "high"], "medium")],
  },
  gemini: {
    fetched_at: SHIPPED_CATALOG_RETRIEVED_AT,
    source: "docs/research/gemini-cli-cli-automation.md",
    notes: "No CLI effort flag.",
    models: ["auto", "pro", "flash", "flash-lite", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3-pro-preview", "gemini-3-flash-preview", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite"].map((id) => entry(id)),
  },
  goose: {
    fetched_at: SHIPPED_CATALOG_RETRIEVED_AT,
    source: "docs/research/goose-cli-automation.md",
    notes: "No cloud catalog.",
    effort_levels: ["adaptive", "enabled", "disabled", "low", "high"],
    models: [],
  },
  grok: {
    fetched_at: SHIPPED_CATALOG_RETRIEVED_AT,
    source: "grok models + docs/research/grok-build-cli-automation.md (live 2026-07-18)",
    models: [entry("grok-4.5", ["low", "medium", "high"], "high")],
  },
  hermes: {
    fetched_at: SHIPPED_CATALOG_RETRIEVED_AT,
    source: "docs/research/hermes-cli-automation.md",
    notes: "Interactive picker only.",
    effort_levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
    models: [],
  },
  kilo: {
    fetched_at: SHIPPED_CATALOG_RETRIEVED_AT,
    source: "docs/research/kilo-cli-automation.md (sample verified)",
    models: ["kilo/~anthropic/claude-fable-latest", "kilo/~anthropic/claude-haiku-latest", "kilo/anthropic/claude-sonnet-4.6", "kilo/anthropic/claude-opus-4.8"].map((id) => entry(id)),
  },
  kimi: {
    fetched_at: SHIPPED_CATALOG_RETRIEVED_AT,
    source: "docs/research/kimi-code-cli.md",
    models: [entry("kimi-for-coding")],
  },
  openclaw: {
    fetched_at: SHIPPED_CATALOG_RETRIEVED_AT,
    source: "packages/daemon/tests/fixtures/openclaw/models-list.json + research",
    effort_levels: [...openclawEfforts],
    models: [entry("openai/gpt-5.5", [...openclawEfforts])],
  },
  opencode: {
    fetched_at: SHIPPED_CATALOG_RETRIEVED_AT,
    source: "live opencode models 2026-07-18",
    models: [
      "opencode/big-pickle", "opencode/deepseek-v4-flash-free", "opencode/hy3-free", "opencode/mimo-v2.5-free", "opencode/nemotron-3-ultra-free", "opencode/north-mini-code-free",
      "opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro", "opencode-go/glm-5.1", "opencode-go/glm-5.2", "opencode-go/grok-4.5", "opencode-go/kimi-k2.6", "opencode-go/kimi-k2.7-code", "opencode-go/kimi-k3", "opencode-go/mimo-v2.5", "opencode-go/mimo-v2.5-pro", "opencode-go/minimax-m2.7", "opencode-go/minimax-m3", "opencode-go/qwen3.6-plus", "opencode-go/qwen3.7-max", "opencode-go/qwen3.7-plus",
      "github-copilot/claude-haiku-4.5", "github-copilot/claude-opus-4.5", "github-copilot/claude-opus-4.6", "github-copilot/claude-opus-4.6-fast", "github-copilot/claude-opus-4.7", "github-copilot/claude-opus-4.7-fast", "github-copilot/claude-sonnet-4.5", "github-copilot/claude-sonnet-4.6", "github-copilot/gemini-2.5-pro", "github-copilot/gpt-5-mini", "github-copilot/gpt-5.3-codex", "github-copilot/gpt-5.4", "github-copilot/gpt-5.4-mini", "github-copilot/gpt-5.5",
      "local/qwen3.6-35b-a3b",
    ].map((id) => entry(id)),
  },
  openhands: {
    fetched_at: SHIPPED_CATALOG_RETRIEVED_AT,
    source: "docs/research/openhands-cli-automation.md",
    effort_levels: ["none", "low", "medium", "high", "xhigh"],
    models: [],
  },
  pi: {
    fetched_at: SHIPPED_CATALOG_RETRIEVED_AT,
    source: "live pi --list-models 2026-07-18",
    effort_levels: [...piEfforts],
    models: [
      "openai-codex/gpt-5.3-codex-spark", "openai-codex/gpt-5.4", "openai-codex/gpt-5.4-mini", "openai-codex/gpt-5.5", "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-terra",
      "xai-oauth/grok-4.20-0309-non-reasoning", "xai-oauth/grok-4.20-0309-reasoning", "xai-oauth/grok-4.20-multi-agent-0309", "xai-oauth/grok-4.3", "xai-oauth/grok-4.5", "xai-oauth/grok-build", "xai-oauth/grok-build-0.1", "xai-oauth/grok-composer-2.5-fast",
    ].map((id) => entry(id, [...piEfforts])),
  },
};

export const SHIPPED_CATALOG_VENDOR_IDS = Object.freeze(Object.keys(SHIPPED_MODEL_CATALOG));
