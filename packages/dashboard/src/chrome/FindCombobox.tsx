/**
 * Find combobox — task hits local (snapshot), session hits GET /sessions?q=.
 * ARIA combobox pattern: role=combobox, aria-expanded, aria-activedescendant,
 * listbox popup. Honesty states: idle / loading / error / no-match / results.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { OrchestratorSession, ParleyClient, TaskEnvelope } from "@useparley/core";

const DEBOUNCE_MS = 200;
const MAX_TASK_HITS = 12;
const MAX_SESSION_HITS = 8;

export type FindHitKind = "task" | "session";

export interface FindHit {
  kind: FindHitKind;
  id: string;
  label: string;
  meta: string;
}

export type FindStatus = "idle" | "loading" | "error" | "no-match" | "results";

export interface FindComboboxProps {
  client: ParleyClient;
  tasks: readonly TaskEnvelope[];
  onSelectTask: (taskId: string) => void;
  onSelectSession: (sessionId: string) => void;
  /** Imperative focus handle for `/` accelerator. */
  inputRef?: RefObject<HTMLInputElement | null>;
}

function matchTasks(tasks: readonly TaskEnvelope[], q: string): FindHit[] {
  const needle = q.toLowerCase();
  const hits: FindHit[] = [];
  for (const t of tasks) {
    const name = t.name ?? "";
    const branch = t.branch ?? "";
    const id = t.task_id;
    const hay = `${id} ${name} ${branch} ${t.vendor ?? ""} ${t.model ?? ""}`.toLowerCase();
    if (!hay.includes(needle)) continue;
    hits.push({
      kind: "task",
      id,
      label: name || id,
      meta: [id, branch, t.state].filter(Boolean).join(" · "),
    });
    if (hits.length >= MAX_TASK_HITS) break;
  }
  return hits;
}

function sessionHits(sessions: readonly OrchestratorSession[]): FindHit[] {
  return sessions.slice(0, MAX_SESSION_HITS).map((s) => ({
    kind: "session" as const,
    id: s.id,
    label: s.id,
    meta: `${s.task_count} task${s.task_count === 1 ? "" : "s"} · ${s.last_activity_at}`,
  }));
}

export function FindCombobox({
  client,
  tasks,
  onSelectTask,
  onSelectSession,
  inputRef: externalRef,
}: FindComboboxProps) {
  const listId = useId();
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = externalRef ?? internalRef;

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [sessionStatus, setSessionStatus] = useState<"idle" | "loading" | "error" | "ok">(
    "idle",
  );
  const [sessions, setSessions] = useState<OrchestratorSession[]>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  useEffect(() => {
    if (debounced === "") {
      setSessions([]);
      setSessionStatus("idle");
      setSessionError(null);
      return;
    }
    let cancelled = false;
    setSessionStatus("loading");
    setSessionError(null);
    void client
      .listSessions(debounced)
      .then((res) => {
        if (cancelled) return;
        setSessions(res.sessions ?? []);
        setSessionStatus("ok");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSessions([]);
        setSessionStatus("error");
        setSessionError(err instanceof Error ? err.message : "session search failed");
      });
    return () => {
      cancelled = true;
    };
  }, [client, debounced]);

  const taskHits = useMemo(
    () => (debounced === "" ? [] : matchTasks(tasks, debounced)),
    [tasks, debounced],
  );
  const sessHits = useMemo(
    () => (sessionStatus === "ok" ? sessionHits(sessions) : []),
    [sessions, sessionStatus],
  );

  const hits = useMemo(() => [...taskHits, ...sessHits], [taskHits, sessHits]);

  const status: FindStatus = useMemo(() => {
    if (debounced === "") return "idle";
    if (sessionStatus === "loading") return "loading";
    if (sessionStatus === "error" && taskHits.length === 0) return "error";
    if (hits.length === 0) return "no-match";
    return "results";
  }, [debounced, sessionStatus, taskHits.length, hits.length]);

  const optionIds = useMemo(
    () => hits.map((h, i) => `${listId}-opt-${h.kind}-${i}`),
    [hits, listId],
  );

  const activeDescendant =
    expanded && activeIndex >= 0 && activeIndex < optionIds.length
      ? optionIds[activeIndex]
      : undefined;

  const selectHit = useCallback(
    (hit: FindHit) => {
      if (hit.kind === "task") onSelectTask(hit.id);
      else onSelectSession(hit.id);
      setQuery("");
      setDebounced("");
      setExpanded(false);
      setActiveIndex(-1);
      inputRef.current?.blur();
    },
    [onSelectTask, onSelectSession, inputRef],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (expanded || query !== "") {
        e.preventDefault();
        e.stopPropagation();
        setExpanded(false);
        setQuery("");
        setActiveIndex(-1);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setExpanded(true);
      setActiveIndex((i) => {
        if (hits.length === 0) return -1;
        return i < hits.length - 1 ? i + 1 : 0;
      });
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setExpanded(true);
      setActiveIndex((i) => {
        if (hits.length === 0) return -1;
        return i <= 0 ? hits.length - 1 : i - 1;
      });
      return;
    }
    if (e.key === "Enter") {
      if (expanded && activeIndex >= 0 && hits[activeIndex]) {
        e.preventDefault();
        selectHit(hits[activeIndex]!);
      }
    }
  };

  const showPopup = expanded && debounced !== "";

  return (
    <div className="pc-find" data-testid="find-combobox" data-status={status}>
      <label className="pc-sr-only" htmlFor={`${listId}-input`}>
        Find tasks and sessions
      </label>
      <div className="pc-find__field">
        <span className="pc-find__affordance" aria-hidden="true">
          /
        </span>
        <input
          ref={inputRef}
          id={`${listId}-input`}
          className="pc-find__input"
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-expanded={showPopup}
          aria-controls={listId}
          aria-activedescendant={activeDescendant}
          aria-haspopup="listbox"
          placeholder="filter tasks, runs, branches"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setExpanded(true);
            setActiveIndex(-1);
          }}
          onFocus={() => setExpanded(true)}
          onBlur={() => {
            // Delay so option mousedown can fire.
            window.setTimeout(() => setExpanded(false), 120);
          }}
          onKeyDown={onKeyDown}
          data-testid="find-input"
          name="pc-find"
        />
      </div>

      {showPopup ? (
        <div
          className="pc-find__popup"
          id={listId}
          role="listbox"
          aria-label="Find results"
          data-testid="find-popup"
        >
          {status === "loading" ? (
            <div className="pc-find__state" role="status" data-testid="find-loading">
              Searching sessions…
            </div>
          ) : null}
          {status === "error" ? (
            <div className="pc-find__state pc-find__state--error" role="alert" data-testid="find-error">
              {sessionError ?? "Session search failed"}
            </div>
          ) : null}
          {status === "no-match" ? (
            <div className="pc-find__state" role="status" data-testid="find-empty">
              No match for “{debounced}”
            </div>
          ) : null}
          {status === "results" || (sessionStatus === "error" && taskHits.length > 0)
            ? hits.map((hit, i) => (
                <div
                  key={`${hit.kind}-${hit.id}`}
                  id={optionIds[i]}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={
                    i === activeIndex ? "pc-find__option pc-find__option--active" : "pc-find__option"
                  }
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectHit(hit);
                  }}
                  data-testid={`find-option-${hit.kind}`}
                >
                  <span className="pc-find__option-kind">{hit.kind}</span>
                  <span className="pc-find__option-label">{hit.label}</span>
                  <span className="pc-find__option-meta">{hit.meta}</span>
                </div>
              ))
            : null}
          {sessionStatus === "error" && taskHits.length > 0 ? (
            <div className="pc-find__state pc-find__state--error" role="status">
              Sessions unavailable — showing local task hits
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
