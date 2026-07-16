import {
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";
import { Plate, PlateHeader, Emblem, Mark, Stat } from "../primitives/index.js";
import { stateMetaFor } from "../tokens/state-meta.js";
import type { RosterGroup, RosterSessionOption, RosterSessionSearchHit } from "./types.js";

/**
 * Imperative surface the roster exposes for the `/` cockpit accelerator
 * (wired in `useCockpitKeys`). Lives in the hud layer so app hooks depend on
 * hud types, never the reverse.
 */
export interface RosterSearchHandle {
  /** Open the session-search well and focus its input. */
  openSearch: () => void;
  /** Whether the session-search popover is currently open. */
  isSearchOpen: () => boolean;
}

export interface RosterPanelProps {
  /** State groups, already ordered by attention rank (hooks layer). */
  groups: RosterGroup[];
  /** Recent orchestrator sessions among the roster's tasks (capped; #88). */
  sessions: RosterSessionOption[];
  /** The active session (`null` = "All hands" / every session). Filters the
   * roster groups the hooks layer projects (#76) and is the future scene's
   * camera-focus target. Single-select only. */
  selectedSessionId: string | null;
  onSelectSession: (id: string | null) => void;
  /**
   * Look up historical sessions by id substring (#88). Results drive the
   * search popover; selecting a hit calls {@link onSelectSession}.
   */
  searchSessions: (query: string) => Promise<RosterSessionSearchHit[]>;
  /** The selected task (feeds the inspector/scene, built in later tickets). */
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  totalTasks: number;
  activeTasks: number;
  /**
   * True before the first snapshot has resolved. Distinguishes "taking
   * soundings" from a genuinely empty fleet (PRODUCT.md honesty).
   */
  connecting?: boolean;
  /**
   * Imperative handle for the `/` accelerator: open/focus session search.
   * Optional so existing call sites and tests stay prop-only.
   */
  searchRef?: Ref<RosterSearchHandle | null>;
}

function Group({
  group,
  selectedTaskId,
  onSelectTask,
}: {
  group: RosterGroup;
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
}) {
  const meta = stateMetaFor(group.state);
  const dotStyle = { "--dot-color": meta.colorVar } as CSSProperties;
  const labelStyle = { "--group-color": meta.colorVar } as CSSProperties;

  return (
    <div>
      <div className="pc-roster__group-head">
        {/* Decorative: the group label next to the dot carries the state for
            AT; title still gives mouse users a hover hint without duplicating
            the label in the accessibility tree. */}
        <span className="pc-state-dot" style={dotStyle} aria-hidden="true" title={meta.label}>
          <Mark mark={meta.mark} size={10} />
        </span>
        <span className="pc-roster__group-label" style={labelStyle}>
          {meta.label}
        </span>
        <span className="pc-roster__count">{group.tasks.length}</span>
      </div>
      {group.tasks.map((task) => {
        const selected = task.id === selectedTaskId;
        // Fresh failures arrive undimmed with a coral beacon; archive failures
        // (and other quiet terminals) keep STATE_META.dim. Per-row, not group-
        // wide — a mixed failed group can hold both treatments.
        const freshFailure = Boolean(task.freshFailure);
        const dim = freshFailure ? undefined : meta.dim;
        const rowStyle = dim !== undefined ? { opacity: dim } : undefined;
        const showBeacon = Boolean(meta.beacon) || freshFailure;
        const beaconStyle = freshFailure
          ? ({
              "--beacon-color": "var(--state-failed)",
              "--beacon-glow-color": "var(--beacon-glow-failed)",
            } as CSSProperties)
          : undefined;
        // Group headers are skipped by Tab-through; put the state in each
        // row's accessible name so a screen-reader user hears which task is
        // failed / awaiting / … without leaving the row list.
        const accessibleName = `${task.name} — ${meta.label}`;
        return (
          <button
            type="button"
            className={`pc-roster__row${selected ? " pc-roster__row--selected" : ""}`}
            style={rowStyle}
            key={task.id}
            aria-label={accessibleName}
            aria-pressed={selected}
            onClick={() => onSelectTask(task.id)}
          >
            <Emblem coat={task.coat} mark={task.emblem} size={23} label={task.faction} />
            <span className="pc-roster__row-body">
              <span className="pc-roster__name">{task.name}</span>
              <span className="pc-roster__meta">{task.meta}</span>
            </span>
            {showBeacon && (
              <span
                className="pc-roster__beacon pc-dot--beacon"
                style={beaconStyle}
                aria-hidden="true"
              >
                <Mark mark={meta.mark} size={12} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const SEARCH_DEBOUNCE_MS = 180;

/** Imperative surface SessionSearch exposes to the roster (and thus `/`). */
interface SessionSearchHandle {
  open: () => void;
  isOpen: () => boolean;
}

function SessionSearch({
  searchSessions,
  onSelectSession,
  searchHandleRef,
}: {
  searchSessions: (query: string) => Promise<RosterSessionSearchHit[]>;
  onSelectSession: (id: string | null) => void;
  searchHandleRef?: Ref<SessionSearchHandle | null>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RosterSessionSearchHit[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  // Keep a live open flag for the imperative isOpen() without forcing
  // useImperativeHandle to rebuild every toggle (ref-stable identity).
  const openRef = useRef(open);
  openRef.current = open;

  useImperativeHandle(
    searchHandleRef,
    () => ({
      open: () => setOpen(true),
      isOpen: () => openRef.current,
    }),
    [],
  );

  // Focus the field when the search well opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Debounced lookup — read-only, never mutates the fleet.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q === "") {
      setHits([]);
      setStatus("idle");
      return;
    }
    setStatus("loading");
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchSessions(q)
        .then((results) => {
          if (cancelled) return;
          setHits(results);
          setStatus("ready");
        })
        .catch(() => {
          if (cancelled) return;
          setHits([]);
          setStatus("error");
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open, searchSessions]);

  const pick = useCallback(
    (id: string) => {
      onSelectSession(id);
      setOpen(false);
      setQuery("");
      setHits([]);
      setStatus("idle");
    },
    [onSelectSession],
  );

  return (
    <div className="pc-roster__search" ref={rootRef}>
      <button
        type="button"
        className={`pc-roster__session pc-roster__session--search${open ? " pc-roster__session--active" : ""}`}
        aria-expanded={open}
        aria-controls={listId}
        aria-label="Search sessions"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">⌕</span> Find
      </button>
      {open && (
        <div className="pc-roster__search-pop" role="search">
          <label className="pc-roster__search-label" htmlFor={listId + "-input"}>
            Session id
          </label>
          <input
            id={listId + "-input"}
            ref={inputRef}
            type="search"
            className="pc-roster__search-input"
            placeholder="substring of session id…"
            value={query}
            autoComplete="off"
            spellCheck={false}
            aria-controls={listId}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div id={listId} className="pc-roster__search-results" role="list" aria-label="Matching sessions">
            {status === "loading" && (
              <p className="pc-roster__search-status">Sounding the deep…</p>
            )}
            {status === "error" && (
              <p className="pc-roster__search-status">Could not reach the daemon.</p>
            )}
            {status === "idle" && query.trim() === "" && (
              <p className="pc-roster__search-status">Type part of a session id.</p>
            )}
            {status === "ready" && hits.length === 0 && (
              <p className="pc-roster__search-status">No sessions match.</p>
            )}
            {hits.map((hit) => (
              <div key={hit.id} role="listitem">
                <button
                  type="button"
                  className="pc-roster__search-hit"
                  onClick={() => pick(hit.id)}
                >
                  <span className="pc-roster__search-hit-id" title={hit.id}>
                    {hit.label}
                  </span>
                  <span className="pc-roster__search-hit-meta">{hit.taskCount}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SessionSelector({
  sessions,
  selectedSessionId,
  onSelectSession,
  searchSessions,
  searchHandleRef,
}: {
  sessions: RosterSessionOption[];
  selectedSessionId: string | null;
  onSelectSession: (id: string | null) => void;
  searchSessions: (query: string) => Promise<RosterSessionSearchHit[]>;
  searchHandleRef?: Ref<SessionSearchHandle | null>;
}) {
  // Always mount SessionSearch so `/` can open Find even when there are no
  // recent chips (historical sessions are reached via search, #88).
  return (
    <div className="pc-roster__sessions" role="group" aria-label="Orchestrator sessions">
      <button
        type="button"
        className={`pc-roster__session${selectedSessionId === null ? " pc-roster__session--active" : ""}`}
        aria-pressed={selectedSessionId === null}
        onClick={() => onSelectSession(null)}
      >
        All hands
      </button>
      {sessions.map((session) => (
        <button
          key={session.id}
          type="button"
          className={`pc-roster__session${
            selectedSessionId === session.id ? " pc-roster__session--active" : ""
          }`}
          aria-pressed={selectedSessionId === session.id}
          onClick={() => onSelectSession(session.id)}
        >
          <span aria-hidden="true">⚓</span> {session.label}
          <span className="pc-roster__session-count">{session.count}</span>
        </button>
      ))}
      <SessionSearch
        searchSessions={searchSessions}
        onSelectSession={onSelectSession}
        searchHandleRef={searchHandleRef}
      />
    </div>
  );
}

/**
 * Layer 2 — the fleet roster (design-manifest §4.5/§4.6). Tasks grouped by state
 * in attention order, with a session selector that both filters the groups
 * below (#76) and marks the future scene's camera-focus target, plus row
 * selection (feeds the inspector/scene). Recent chips are capped; older
 * sessions are reached via the Find search (#88). Plain props throughout: the
 * hooks layer does the grouping/ordering/filtering via `@useparley/core`'s
 * attention constants and owns the selection state. Memoized — the cockpit
 * shell re-renders every second for its clock, and all roster props are
 * identity-stable between snapshot updates.
 */
export const RosterPanel = memo(function RosterPanel({
  groups,
  sessions,
  selectedSessionId,
  onSelectSession,
  searchSessions,
  selectedTaskId,
  onSelectTask,
  totalTasks,
  activeTasks,
  connecting = false,
  searchRef,
}: RosterPanelProps) {
  const sessionSearchRef = useRef<SessionSearchHandle | null>(null);

  useImperativeHandle(
    searchRef,
    () => ({
      openSearch: () => sessionSearchRef.current?.open(),
      isSearchOpen: () => sessionSearchRef.current?.isOpen() ?? false,
    }),
    [],
  );

  return (
    <Plate padded={false} className="pc-roster">
      <PlateHeader
        icon="⚑"
        iconDark
        title="FLEET ROSTER"
        subtitle="every soul at sea"
        divider
      />
      <SessionSelector
        sessions={sessions}
        selectedSessionId={selectedSessionId}
        onSelectSession={onSelectSession}
        searchSessions={searchSessions}
        searchHandleRef={sessionSearchRef}
      />
      <div className="pc-roster__scroll">
        {groups.length === 0 ? (
          connecting ? (
            <div className="pc-roster__empty" role="status">
              <p className="pc-roster__empty-title">Taking soundings…</p>
              <p className="pc-roster__empty-sub">listening for the fleet</p>
            </div>
          ) : (
            <p className="pc-roster__empty">The cove is quiet — no voyages under way.</p>
          )
        ) : (
          groups.map((group) => (
            <Group
              key={group.state}
              group={group}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
            />
          ))
        )}
      </div>
      <div className="pc-roster__footer">
        <Stat value={String(totalTasks)} label="Total tasks" color="var(--brass)" />
        <Stat value={String(activeTasks)} label="Active" color="var(--state-running)" />
      </div>
    </Plate>
  );
});
