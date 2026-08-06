---
layout: home

hero:
  name: Parley
  text: Give your agent a crew
  tagline: One orchestrating agent, many coding agents, every branch reviewed before it lands.
  image:
    src: /logo.png
    alt: Parley
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What is Parley?
      link: /guide/what-is-parley
    - theme: alt
      text: GitHub
      link: https://github.com/femoral/parley

features:
  - icon: 🗺️
    title: You brief, your agent crews up
    details: Describe the work to the agent you already use. It writes the briefs, delegates to child coding agents, answers their questions, and reviews what comes back.
  - icon: ⚔️
    title: Fan out without collisions
    details: Ten briefs, ten isolated git worktrees, ten agents in parallel. No one steps on anyone, and every branch is reviewable on its own.
  - icon: 🔭
    title: One wait primitive
    details: parley watch delivers exactly the events that need attention (question, stall, failure, completion) with at-least-once redelivery. No polling loops.
  - icon: 🏴‍☠️
    title: Vendor agnostic
    details: Codex, Grok, Claude Code, Cursor and more behind one interface, plus a public adapter contract for harnesses Parley has never heard of.
  - icon: 🧭
    title: Judgment stays with you
    details: Parley never merges. Every task ends as a branch that the orchestrator (and you) review, accept, or send back for a fix.
  - icon: 📊
    title: Accountable by default
    details: Every task records tokens, duration, profile, and classification. Slice by vendor, model, or profile with parley metrics or the Console.
---

<div class="parley-shot">
  <img src="/hero-console.png" alt="Parley Console: the fleet board with live delegated tasks" />
</div>

<div style="text-align:center; margin-top: 2.5rem;">

```bash
npm install -g @useparley/cli @useparley/dashboard
```

</div>
