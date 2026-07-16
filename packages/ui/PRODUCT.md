# Product

## Register

product

## Platform

web

## Users

The primary user is a developer who has spawned a fan-out of delegated agent tasks with parley and keeps the cockpit open to watch them work. Their job here is observation: seeing at a glance how the fleet is progressing, which agents are running, which are blocked, stalled, or done. Answering an agent's questions or resuming it is not this user's job in this surface — they are watching, not driving the conversation. Today the cockpit runs on localhost; the design should not assume local-only forever, since a remote deployment is a plausible future.

This is deliberately one of several possible front-ends. The daemon discovers and serves whichever UI is installed (the `parley.ui` marker), so this cockpit is a pluggable view, not the product itself. Its reason to exist over a plainer view is to be both useful and genuinely fun to keep open.

## Product Purpose

Parley Cove is the web cockpit for parley — the tool that delegates coding tasks to child agent CLIs, each in its own isolated worktree. Headless agent work is normally invisible: logs scrolling in a terminal, or nothing at all. The cockpit's purpose is to make that work into something a person can watch and enjoy watching — a living scene where the fleet's state is legible at a glance. Success is the developer choosing to leave it open all day, trusting it to show the true state of every agent without them having to dig.

## Positioning

Agent work you want to watch. Every screen turns invisible, headless delegated work into a living, legible scene worth leaving open.

## Brand Personality

Cozy, gamified, weathered. The voice is a warm strategy-game HUD you settle into — an aged nautical chart crossed with a cozy fleet-command board, brass and parchment floating on a deep teal sea. Delight-forward but trustworthy: the charm is the point and part of why you keep it open, yet the data never lies and the state is always honest. Flavor is allowed to be decorative; status is never allowed to be decorative.

## Anti-references

- **Generic SaaS dashboard** — flat slate-gray surfaces, a single blurple accent, identical card grids, hero-metric tiles. The default this cockpit is a reaction against.
- **Cold terminal / ops console** — monospace-everything, pure black, green-on-black hacker aesthetic with no warmth or delight. The cockpit shows logs, but it is not a log viewer.
- **Skeuomorphic clutter** — gaudy fake-wood-on-everything, heavy bevels and drop shadows on every element, ornament with no restraint. The nautical materials must feel crafted and deliberate, never a costume.

## Design Principles

- **Attention hierarchy is law.** State legibility is the whole point of watching: a blocked, stalled, or failed agent must read louder than a calmly-running one, so a single glance answers "is anything wrong?" without reading anything.
- **Delight is a feature, not a coat of paint.** The gamified, atmospheric quality is what earns the "leave it open" goal, so it gets real design investment — but it is always subordinate to honesty. Charm never misrepresents what an agent is actually doing.
- **Observation-first, calm by default.** This surface is for watching a fan-out, not commanding it. The resting state is quiet and readable; motion and loudness are reserved for things that changed or need notice.
- **Pluggable and vendor-agnostic.** The cockpit is one front-end among possible others, and every vendor is a "faction" expressed as data (label, color, emblem, tagline), never as bespoke layout. Adding a vendor or swapping the view must never mean rewriting the design.

## Accessibility & Inclusion

Target **WCAG 2.1 AA**: body text at ≥4.5:1 contrast against its background, large text at ≥3:1. Task-state must never be carried by hue alone — every state that a color distinguishes is also backed by an icon, shape, label, or position, so the fleet stays legible to colorblind users. `prefers-reduced-motion` is already honored: a single global rule stills every ambient loop (sea drift, compass spin, beacon pulse, ship bob) to its legible resting frame, and any future motion must ship with the same reduced-motion fallback.
