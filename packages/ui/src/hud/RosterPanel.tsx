import {
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type Ref,
} from "react";
import { Plate, PlateHeader, Emblem, Mark, Stat } from "../primitives/index.js";
import { MARK_ANCHOR, MARK_LENS, MARK_SLOOP } from "../tokens/chrome-glyphs.js";
import { stateMetaFor } from "../tokens/state-meta.js";
import {
  notifyHandRolledPopoverOpen,
  subscribeHandRolledPopoverOpen,
} from "./handRolledPopover.js";
import type { RosterGroup, RosterSessionOption, RosterSessionSearchHit } from "./types.js";

/** Scaffold the operator pastes into a shell to start a voyage. */
export function delegateScaffold(): string {
  return 'parley delegate -n <name> "<goal>"';
}

function clipboardAvailable(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
}

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

/**
 * Quiet empty-fleet state: flavor line plus a copyable `parley delegate`
 * starter (mirrors InboxCard / BriefTab scaffold pattern). Read-only —
 * the cove stays watch-only; the operator pastes into their own shell.
 */
function RosterEmptyStarter() {
  const [copied, setCopied] = useState(false);
  const [canCopy, setCanCopy] = useState(true);
  const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scaffoldRef = useRef<HTMLSpanElement>(null);
  const text = delegateScaffold();

  useEffect(() => {
    setCanCopy(clipboardAvailable());
    return () => {
      if (revertTimer.current) clearTimeout(revertTimer.current);
    };
  }, []);

  const markCopied = useCallback(() => {
    setCopied(true);
    if (revertTimer.current) clearTimeout(revertTimer.current);
    revertTimer.current = setTimeout(() => setCopied(false), 1500);
  }, []);

  const handleCopy = useCallback(async () => {
    if (clipboardAvailable()) {
      try {
        await navigator.clipboard.writeText(text);
        markCopied();
        return;
      } catch {
        // Fall through to select-on-click fallback.
      }
    }
    const el = scaffoldRef.current;
    if (el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      markCopied();
    } else {
      setCanCopy(false);
    }
  }, [text, markCopied]);

  return (
    <div className="pc-roster__empty">
      <p className="pc-roster__empty-title">The cove is quiet — no voyages under way.</p>
      <p className="pc-roster__empty-hint">Cast off from your shell:</p>
      <div className="pc-roster__empty-scaffold-row">
        <code className="pc-roster__empty-snippet">{text}</code>
        {/* Hidden scaffold text for select-on-click fallback when clipboard fails. */}
        <span ref={scaffoldRef} className="pc-roster__empty-scaffold" aria-hidden="true">
          {text}
        </span>
        {canCopy && (
          <button
            type="button"
            className="pc-roster__empty-copy"
            onClick={handleCopy}
            aria-label={copied ? "Copied delegate command" : "Copy delegate command"}
          >
            {copied ? "copied ✓" : "copy"}
          </button>
        )}
      </div>
    </div>
  );
}

/** 8-char short ref — same truncation as InboxCard / hooks `shortId`. */
function shortRef(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Split projected meta (`branch · shortId` or branch-alone when the id is
 * already embedded) so the short id can sit outside the ellipsis flex and
 * stay legible at narrow roster widths.
 */
function metaBranchAndId(
  meta: string,
  taskId: string,
): { branch: string | null; idRef: string } {
  const idRef = shortRef(taskId);
  const sep = " · ";
  const idx = meta.lastIndexOf(sep);
  if (idx === -1) {
    // Branch alone (id already a path segment) — no separate id chip.
    return { branch: meta, idRef };
  }
  const right = meta.slice(idx + sep.length);
  // Only treat the right segment as the id when it matches the short ref
  // (projection contract); otherwise keep the whole string as branch.
  if (right === idRef || right === taskId) {
    return { branch: meta.slice(0, idx), idRef };
  }
  return { branch: meta, idRef };
}

/**
 * Compact relative age for attention triage ("4h", "20s"). One unit only so
 * it stays subordinate to the state label.
 */
function formatRelativeAge(iso: string, nowMs: number): string | null {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const sec = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/** Coarse clock for attention-row ages — not the cockpit's 1s tick. */
const AGE_TICK_MS = 30_000;

function useCoarseNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

/** Attention states where "how long" is the triage variable. */
function showAttentionAge(
  state: string,
  freshFailure: boolean | undefined,
): boolean {
  if (state === "awaiting_answer" || state === "stalled") return true;
  if (state === "failed" && freshFailure) return true;
  return false;
}

function Group({
  group,
  selectedTaskId,
  focusedTaskId,
  onSelectTask,
  onFocusTask,
  rowRefs,
  nowMs,
}: {
  group: RosterGroup;
  selectedTaskId: string | null;
  /** The single tab-stop row in the listbox (roving tabindex). */
  focusedTaskId: string | null;
  onSelectTask: (id: string) => void;
  onFocusTask: (id: string) => void;
  rowRefs: MutableRefObject<Map<string, HTMLDivElement | null>>;
  nowMs: number;
}) {
  const meta = stateMetaFor(group.state);
  const dotStyle = { "--dot-color": meta.colorVar } as CSSProperties;
  const labelStyle = { "--group-color": meta.colorVar } as CSSProperties;

  return (
    /* role=group: a listbox may only own option/group children — the bare div
       broke the accessible owns-tree. The label carries what the (aria-hidden)
       visual head shows, so AT hears one group name, not the head twice. */
    <div role="group" aria-label={`${meta.label} (${group.tasks.length})`}>
      {/* Group headers stay non-focusable; state lives on each option's name. */}
      <div className="pc-roster__group-head" aria-hidden="true">
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
        const focused = task.id === focusedTaskId;
        // Fresh failures arrive loud with a coral beacon; archive failures
        // (and other quiet terminals) take STATE_META.quiet token ink steps —
        // not opacity. Per-row, not group-wide — a mixed failed group can
        // hold both treatments.
        const freshFailure = Boolean(task.freshFailure);
        const quiet = freshFailure ? undefined : meta.quiet;
        const quietClass =
          quiet === "soft"
            ? " pc-roster__row--quiet-soft"
            : quiet === "archive"
              ? " pc-roster__row--quiet-archive"
              : "";
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
        const age =
          showAttentionAge(group.state, task.freshFailure) && task.updatedAt
            ? formatRelativeAge(task.updatedAt, nowMs)
            : null;
        const accessibleName = age
          ? `${task.name} — ${meta.label}, ${age}`
          : `${task.name} — ${meta.label}`;
        const { branch, idRef } = metaBranchAndId(task.meta, task.id);
        // When meta is "branch · id", protect the short id from ellipsis; when
        // the branch already embeds the id, show meta as a single ellipsized line.
        const splitId = task.meta.includes(" · ");
        return (
          <div
            role="option"
            className={`pc-roster__row${selected ? " pc-roster__row--selected" : ""}${quietClass}`}
            key={task.id}
            id={`roster-option-${task.id}`}
            aria-label={accessibleName}
            aria-selected={selected}
            tabIndex={focused ? 0 : -1}
            ref={(el) => {
              if (el) rowRefs.current.set(task.id, el);
              else rowRefs.current.delete(task.id);
            }}
            onClick={() => {
              onFocusTask(task.id);
              onSelectTask(task.id);
            }}
            onFocus={() => onFocusTask(task.id)}
          >
            <Emblem coat={task.coat} mark={task.emblem} size={23} label={task.faction} />
            <span className="pc-roster__row-body">
              <span className="pc-roster__name">{task.name}</span>
              {/* title is mouse-only — the visually-hidden span exposes the
                  full task id to keyboard/AT (InboxCard shortRef pattern).
                  Visible meta: branch may ellipsize; 8-char short ref is
                  flex-shrink:0 so rows stay identifiable at rest. Copy lives
                  on the Inspector head — ARIA options must not nest buttons. */}
              <span className="pc-roster__meta" title={task.id}>
                {splitId ? (
                  <span className="pc-roster__meta-parts" aria-hidden="true">
                    <span className="pc-roster__meta-branch">{branch}</span>
                    <span className="pc-roster__meta-sep"> · </span>
                    <span className="pc-roster__meta-id">{idRef}</span>
                  </span>
                ) : (
                  <span aria-hidden="true">{task.meta}</span>
                )}
                <span className="pc-visually-hidden">task id {task.id}</span>
              </span>
            </span>
            {age && (
              <span className="pc-roster__age" title={task.updatedAt ?? undefined} aria-hidden="true">
                {age}
              </span>
            )}
            {showBeacon && (
              <span
                className="pc-roster__beacon pc-dot--beacon"
                style={beaconStyle}
                aria-hidden="true"
              >
                <Mark mark={meta.mark} size={12} />
              </span>
            )}
          </div>
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
  const triggerRef = useRef<HTMLButtonElement>(null);
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

  // Single-open invariant with Chart key (and any future hand-rolled peer).
  useEffect(() => {
    return subscribeHandRolledPopoverOpen("session-find", () => setOpen(false));
  }, []);

  // Announce open so peers close; close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    notifyHandRolledPopoverOpen("session-find");
    const onPointer = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        // Closing unmounts the focused input; without this, focus falls to
        // <body> and keyboard users lose their place (WCAG 2.4.3).
        triggerRef.current?.focus();
      }
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
      // The hit button unmounts with the popover — return focus to the trigger.
      triggerRef.current?.focus();
    },
    [onSelectSession],
  );

  return (
    <div className="pc-roster__search" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`pc-roster__session pc-roster__session--search${open ? " pc-roster__session--active" : ""}`}
        aria-expanded={open}
        aria-controls={listId}
        aria-label="Search sessions"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">
          <Mark mark={MARK_LENS} size={11} />
        </span>{" "}
        Find
      </button>
      {open && (
        <div className="pc-roster__search-pop" role="search" aria-label="Session search">
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
          <span aria-hidden="true">
            <Mark mark={MARK_ANCHOR} size={10} />
          </span>{" "}
          {session.label}
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
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  // Flat task order across groups — the listbox's single navigation axis.
  const taskIds = useMemo(
    () => groups.flatMap((g) => g.tasks.map((t) => t.id)),
    [groups],
  );

  // Coarse clock only while attention rows (awaiting / stalled / fresh-failed)
  // are present — keeps relative ages honest without a 1s re-render.
  const needsAgeClock = useMemo(
    () =>
      groups.some(
        (g) =>
          (g.state === "awaiting_answer" || g.state === "stalled") &&
          g.tasks.some((t) => t.updatedAt) ||
          (g.state === "failed" &&
            g.tasks.some((t) => t.freshFailure && t.updatedAt)),
      ),
    [groups],
  );
  const nowMs = useCoarseNow(needsAgeClock);

  // Roving tabindex: one tab stop among options (APG listbox / Inspector house style).
  // Prefer the selected task when present; else the first row.
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const resolvedFocusId = useMemo(() => {
    if (taskIds.length === 0) return null;
    if (focusedTaskId && taskIds.includes(focusedTaskId)) return focusedTaskId;
    if (selectedTaskId && taskIds.includes(selectedTaskId)) return selectedTaskId;
    return taskIds[0] ?? null;
  }, [taskIds, focusedTaskId, selectedTaskId]);

  // Keep focus index coherent when the fleet reshuffles under us.
  useEffect(() => {
    if (resolvedFocusId && resolvedFocusId !== focusedTaskId) {
      setFocusedTaskId(resolvedFocusId);
    }
    if (taskIds.length === 0 && focusedTaskId !== null) {
      setFocusedTaskId(null);
    }
  }, [resolvedFocusId, focusedTaskId, taskIds.length]);

  const focusTaskAt = useCallback(
    (index: number) => {
      const id = taskIds[index];
      if (!id) return;
      setFocusedTaskId(id);
      // Defer so the tabIndex update lands before focus.
      requestAnimationFrame(() => {
        rowRefs.current.get(id)?.focus();
      });
    },
    [taskIds],
  );

  // Manual-activation listbox (WAI-ARIA APG): arrows/Home/End only move focus;
  // Enter/Space select. Matches the Inspector tab bar's house style.
  const onListKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (taskIds.length === 0) return;
      const current = resolvedFocusId ? taskIds.indexOf(resolvedFocusId) : 0;
      const last = taskIds.length - 1;
      let next: number | null = null;
      switch (event.key) {
        case "ArrowDown":
          next = current < 0 ? 0 : current === last ? 0 : current + 1;
          break;
        case "ArrowUp":
          next = current < 0 ? last : current === 0 ? last : current - 1;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = last;
          break;
        case "Enter":
        case " ": {
          event.preventDefault();
          const id = resolvedFocusId ?? taskIds[0];
          if (id) onSelectTask(id);
          return;
        }
        default:
          return;
      }
      event.preventDefault();
      focusTaskAt(next);
    },
    [taskIds, resolvedFocusId, onSelectTask, focusTaskAt],
  );

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
        icon={<Mark mark={MARK_SLOOP} size={14} />}
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
      <div
        className="pc-roster__scroll"
        role={groups.length > 0 ? "listbox" : undefined}
        aria-label={groups.length > 0 ? "Fleet tasks" : undefined}
        onKeyDown={groups.length > 0 ? onListKeyDown : undefined}
      >
        {groups.length === 0 ? (
          connecting ? (
            <div className="pc-roster__empty" role="status">
              <p className="pc-roster__empty-title">Taking soundings…</p>
              <p className="pc-roster__empty-sub">listening for the fleet</p>
            </div>
          ) : (
            <RosterEmptyStarter />
          )
        ) : (
          groups.map((group) => (
            <Group
              key={group.state}
              group={group}
              selectedTaskId={selectedTaskId}
              focusedTaskId={resolvedFocusId}
              onSelectTask={onSelectTask}
              onFocusTask={setFocusedTaskId}
              rowRefs={rowRefs}
              nowMs={nowMs}
            />
          ))
        )}
      </div>
      <div className="pc-roster__footer">
        <Stat value={String(totalTasks)} label="Total tasks" color="var(--brass)" />
        {/* Active is a metric (running+queued+pending+stalled+awaiting), not
            the running *state* — State-Color Reservation: use brass, not
            --state-running. */}
        <Stat value={String(activeTasks)} label="Active" color="var(--brass)" />
      </div>
    </Plate>
  );
});
