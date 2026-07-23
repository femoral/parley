import { applyProvenanceEnv } from "@useparley/core";

type Model = { provider: string; id: string };

interface ProvenanceAPI {
  getThinkingLevel(): string;
  on(
    event: "session_start",
    handler: (
      event: unknown,
      ctx: {
        sessionManager: { getSessionId(): string };
        model: Model | undefined;
      },
    ) => void,
  ): void;
  on(event: "model_select", handler: (event: { model: Model }) => void): void;
  on(
    event: "thinking_level_select",
    handler: (event: { level: string }) => void,
  ): void;
}

const HARNESS = "pi";

function modelSlug(model: Model | undefined): string | null {
  return model ? `${model.provider}/${model.id}` : null;
}

function setModel(model: Model | undefined): void {
  if (model) {
    process.env.PARLEY_MODEL = `${model.provider}/${model.id}`;
  } else {
    delete process.env.PARLEY_MODEL;
  }
}

export default function parleyProvenance(pi: ProvenanceAPI): void {
  pi.on("session_start", (_event, ctx) => {
    applyProvenanceEnv({
      harness_session_id: ctx.sessionManager.getSessionId(),
      harness: HARNESS,
      model: modelSlug(ctx.model),
      effort: pi.getThinkingLevel(),
    });
  });

  pi.on("model_select", (event) => {
    setModel(event.model);
  });

  pi.on("thinking_level_select", (event) => {
    process.env.PARLEY_EFFORT = event.level;
  });
}
