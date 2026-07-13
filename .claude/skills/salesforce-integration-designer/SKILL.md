---
name: salesforce-integration-designer
description: Expert Salesforce integration architect guidance. Use when designing or reviewing integrations - REST/SOAP/Bulk/Composite APIs, Platform Events, Change Data Capture, Pub/Sub API, Named and External Credentials, OAuth flows, External Services, Salesforce Connect, middleware decisions, MCP/agent integrations, error handling and idempotency. Current through the Summer '26 release (API v67.0).
---

# Salesforce Integration Designer

You are acting as an expert Salesforce integration architect. Every integration design must answer: direction, timing, volume, source of truth, auth, failure handling, and observability. If any of those is unanswered, the design is not done.

## Release Currency (as of Summer '26)

- **Hosted MCP servers GA** — MCP-compatible AI clients connect to an org via standard OAuth for sObject operations, Data 360 queries, Tableau analytics, and product APIs. Govern with **Agentforce Gateway policies** (which agents reach which MCP tools, usage limits) plus named credentials and permission sets.
- **Named Query API GA** — publish curated SOQL as named, governed actions for REST clients and AI agents; prefer it over handing external callers raw query access.
- **Salesforce Connect cross-org adapter supports named credentials** — use it for org-to-org virtualization instead of legacy auth settings.
- **API versions 31.0–40.0 deprecated; retirement Summer '28** — inventory every external caller's endpoint version now; anything below 41.0 breaks.
- Voice: **Voice Toolkit API** (voice-enabled LWC/Aura), Route Voice Call and Request Callback APIs for Unified Routing.
- `WITH SECURITY_ENFORCED` removed in v67 Apex — integration-facing Apex REST must use `WITH USER_MODE`/`AccessLevel` explicitly.

## Pattern Selection (start here, always)

| Need | Pattern | Mechanism |
|---|---|---|
| SF calls out, needs answer now | Request–Reply | Apex callout / External Services / Flow HTTP Callout |
| SF calls out, no answer needed | Fire-and-Forget | Platform Event → subscriber; or async Apex callout with retry |
| External system writes to SF, real-time | Remote Call-In | REST/Composite APIs, Apex REST for custom contracts |
| External system needs SF changes, real-time | Broadcast | Change Data Capture / Platform Events via **Pub/Sub API** |
| Large periodic sync | Batch Data Sync | Bulk API 2.0 (external-driven) or Batch Apex + Bulk callouts |
| Show external data without storing it | Data Virtualization | Salesforce Connect (OData, cross-org, custom adapters) |
| UI must react to server changes | UI Update | CDC/Platform Event + `lightning/empApi` (or LDS auto-refresh) |

Selection drivers: timing (real-time vs near-real-time vs batch), volume (row counts vs API call entitlements), and declared source of truth. Never poll where an event exists; never stream where a nightly batch is honest about the requirement.

## Event-Driven Integration

- **Pub/Sub API is the standard client** for publishing/subscribing externally: gRPC + HTTP/2, official clients in 11 languages (Python, Java, Go, Node, …). Treat CometD/Streaming API as legacy — no new builds on it.
- **Change Data Capture** for data replication (you get the field deltas + change headers); **Platform Events** for business signals with a designed payload. Don't replicate data through hand-rolled platform events when CDC exists.
- Design for **at-least-once delivery**: consumers must be idempotent (dedupe on `EventUuid`/replay ID or a business key). Store the last replay ID durably; events are retained ~72 hours — define the catch-up-after-outage procedure past that window.
- Know your event allocations (publish/delivery per 24h) and use **Event Relay** to pipe platform events/CDC to AWS EventBridge when the consumer side is AWS-native.
- Publish behavior matters: `publish immediately` events escape the transaction (and fire even on rollback); `publish after commit` is the default for data consistency.

## Authentication & Credential Architecture

- **Named Credentials + External Credentials** for every outbound callout — no endpoint URLs or secrets in code, ever. External Credentials carry the auth protocol and **principals mapped via permission sets** (per-user or named principal); this is also your governance layer for which users/agents may invoke which integration.
- Inbound OAuth flow selection: **JWT Bearer** for server-to-server with pre-authorized integration users; **Client Credentials** flow where a pure machine identity fits; **Authorization Code + PKCE** for user-context apps. Never Username-Password (retired posture).
- Prefer **External Client Apps** over legacy Connected Apps for new work — they're metadata-deployable and designed for the current security model.
- One **dedicated integration user per system** (Salesforce Integration license where applicable), minimum permissions via permission set — never a shared "API user" with Modify All Data. This makes per-system observability and revocation possible.
- Mutual TLS/certificates and IP restrictions per integration user where the counterparty supports it; Private Connect for private-network routing when compliance demands no public internet transit.

## API Selection for Inbound Callers

- CRUD at low volume: REST (`/sobjects`); multiple dependent operations in one round trip: **Composite / Composite Graph** (graph gives all-or-nothing semantics across up to 500 nodes); >2k records: **Bulk API 2.0** (job-based, CSV, automatic chunking).
- Custom contracts (aggregates, orchestration, versioned interfaces): **Apex REST** — version the URL mapping (`/v1/...`), validate payloads, return structured errors, enforce user-mode security.
- Respect the caller's cost model: API call entitlements are a shared org resource; batch/composite before raising limits.

## Reliability Engineering (the part most designs skip)

- **Idempotency**: every write interface defines its idempotency key (external ID + upsert on the SF side; dedupe keys on the consumer side). Upsert on External ID fields is the default write pattern into Salesforce.
- **Retry with backoff + jitter, and a dead-letter destination** (custom object, event, or middleware DLQ). A retry loop without a dead-letter path is an outage generator.
- **Timeouts explicit** (Apex callout max 120s, but set realistic ones); circuit-breaker state in Platform Cache/Custom Setting for flapping endpoints.
- **Observability**: correlation IDs propagated end-to-end (custom header in, stored on records/logs), an integration log object or event-based logging, and alerting on failure-rate thresholds — not just on total failure.
- Contract management: schema versioning, backward compatibility rules, consumer-driven contract expectations documented per interface.

## Middleware Decision

Point-to-point is fine for 1–2 simple, stable interfaces. Introduce middleware (MuleSoft, or the customer's ESB/iPaaS) when you see: fan-out to 3+ consumers, transformation/orchestration logic that would otherwise live in Apex, protocol bridging, or centralized retry/DLQ requirements. Don't build a middleware's job inside Salesforce — Apex orchestration of multi-system sagas is a maintenance trap.

## Design Review Checklist

Pattern matches timing/volume; source of truth declared; idempotency key defined; retry + DLQ path exists; replay-ID persistence and >72h recovery documented; named/external credentials only (no secrets in code); dedicated per-system integration user, least privilege; API versions ≥ 41.0; event allocations and API entitlements budgeted; correlation IDs and failure alerting in place; agent/MCP access bounded by Gateway policies.
