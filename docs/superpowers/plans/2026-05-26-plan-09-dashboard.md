# Plan 9: Dashboard — Live Activity View

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-file HTML dashboard served by a lightweight Bun HTTP server. The dashboard shows project stats, recent observations, and session history. It reads the DB directly (separate process from the worker).

**Architecture:** A Bun HTTP server (`src/dashboard/serve.ts`) opens the DB read-only and exposes JSON API endpoints. It also serves `src/dashboard/index.html` — a self-contained vanilla JS/CSS page that fetches from the API and renders a live view. A `deja dashboard` CLI subcommand starts the server.

**Tech Stack:** Bun's built-in `Bun.serve()` for HTTP, vanilla JS + CSS in a single HTML file, `bun:sqlite` for DB reads.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/dashboard/api.ts` | Pure functions: query DB, return JSON-serializable objects |
| `src/dashboard/serve.ts` | Bun HTTP server: routes API requests + serves index.html |
| `src/dashboard/index.html` | Single-file dashboard UI (vanilla JS, embedded CSS) |
| `tests/dashboard/api.test.ts` | Tests for API query functions |

---

## Task 1: Dashboard API functions

Pure query functions that return data for the dashboard.

## Task 2: HTTP server + HTML dashboard

Wire up Bun.serve with API routes and the HTML page.

## Task 3: Wire into CLI

Add `deja dashboard` subcommand.
