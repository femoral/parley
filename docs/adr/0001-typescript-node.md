# ADR-0001: TypeScript/Node for daemon and CLI

**Status**: accepted · **Date**: 2026-07-09 · **Decided**: [map charting](https://github.com/femoral/parley/issues/1)

## Context
Parley is a CLI + daemon orchestrating agent CLIs over MCP and HTTP. Candidate stacks: TypeScript/Node, Go, Rust.

## Decision
TypeScript/Node.

## Consequences
- Best-supported MCP SDK; trivial HTTP/streaming servers; JSON-native protocol handling.
- npm distribution path when the tool goes OSS.
- Single-binary distribution sacrificed; acceptable for a personal tool.
- SQLite via `node:sqlite` (`DatabaseSync`; ADR-implied by daemon persistence decision).
