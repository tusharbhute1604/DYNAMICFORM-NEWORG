---
name: salesforce-apex-developer
description: Expert Salesforce Apex developer guidance. Use when writing, reviewing, or debugging Apex classes, triggers, SOQL/SOSL, asynchronous Apex (Queueable/Batch/Schedulable), Apex tests, or CRUD/FLS/sharing enforcement. Current through the Summer '26 release (API v67.0).
---

# Salesforce Apex Developer

You are acting as an expert Apex developer. Apply these practices to all Apex work.

## Release Currency (as of Summer '26)

- **`WITH SECURITY_ENFORCED` is REMOVED in API v67.0+.** Use `WITH USER_MODE` instead — it also covers polymorphic fields and reports the full set of access errors. On classes pinned to older API versions it still compiles, but treat any new usage as a defect.
- **Triggers always run in system mode (all API versions, enforced Summer '26)** — sharing/access-mode declarations on triggers are no longer permitted. Put sharing-sensitive logic in `with sharing` handler classes, not the trigger body.
- Platform API versions **31.0–40.0 are deprecated and retire in Summer '28** — flag any class/integration metadata pinned that low.
- Recent language features you should actually use: null coalescing `??`, safe navigation `?.`, the `Assert` class (not `System.assert*`), `UUID` class, `Compression` namespace (zip), `FormulaEval` namespace (evaluate formulas dynamically), `Database.queryWithBinds`, user-mode DML (`as user` / `as system`, `AccessLevel` params on `Database` methods), Queueable `AsyncOptions` (delay, duplicate-signature detection) and transaction Finalizers.

## Security Model — the default posture

1. Entry points callable from UI (`@AuraEnabled`) run in system mode by default. **Explicitly choose** the mode:
   - Reads: `WITH USER_MODE` in SOQL, or `Database.query(soql, AccessLevel.USER_MODE)`.
   - Writes: `insert as user records;` or `Database.insert(records, AccessLevel.USER_MODE)`.
   - When system mode is genuinely required (deliberate elevation), isolate it in a clearly named `without sharing` inner class and document why.
2. `Security.stripInaccessible()` for payloads returned to the client when you must query in system mode.
3. Never concatenate user input into SOQL — use bind variables or `Database.queryWithBinds` with a bind map; `String.escapeSingleQuotes` is a last resort, not a strategy.
4. Class-level sharing: default every class `with sharing`; `inherited sharing` for shared utilities; `without sharing` only for the isolated elevation case above.

## Bulkification & Governor Limits — non-negotiable

- No SOQL/DML inside loops, ever. Query into maps, mutate collections, DML once.
- Design every code path for 200 records (trigger batch size). Test with `Test.loadData` or 200-record inserts.
- Key limits to design around (per synchronous transaction): 100 SOQL queries / 50k rows, 150 DML statements / 10k rows, 6 MB heap (12 MB async), 10 s CPU (60 s async), 100 callouts.
- Cache describes/metadata in static variables; use `Limits.*` methods when approaching boundaries in framework code.

## Triggers & Architecture

- **One trigger per object**, logic-free — delegate to a handler class. Use a bypass mechanism (static flag, Custom Permission, or Custom Setting) for data-migration scenarios.
- Guard against recursion with static state that tracks processed record IDs (not a boolean that silently drops the second legitimate batch).
- Separation of concerns: trigger → handler → service (business logic) → selector (SOQL) → domain. Don't over-layer small orgs, but never put SOQL in the trigger.

## Asynchronous Apex — selection guide

- **Queueable** — the default async choice: chaining, non-primitive state, `AsyncOptions` for delayed execution and `QueueableDuplicateSignature` to prevent duplicate enqueues. Attach a **Finalizer** for guaranteed post-processing/retry on failure.
- **Batchable** — millions of rows; use `Database.QueryLocator` (50M rows), keep `execute` idempotent and re-runnable.
- **Schedulable** — cron scheduling; keep it a thin shell that enqueues a Queueable/Batch.
- **`@future`** — legacy; only for simple fire-and-forget callouts from triggers where Queueable is overkill. Prefer Queueable.
- **Platform Events** — decoupling and cross-system signals (see salesforce-integration-designer skill).
- **Apex Cursors** (beta) — cursor-based paging over large query results across transactions; consider where Batch is too heavyweight, but verify current GA status before production use.

## Transactions & Error Handling

- Use `Database.setSavepoint()` / `Database.rollback()` around multi-object writes that must be atomic.
- `Database.insert(records, false)` for partial success only when the business process tolerates it — then inspect `SaveResult`s and surface failures; never swallow them.
- Throw `AuraHandledException` with a user-safe message from `@AuraEnabled` methods; log the real exception (custom logging object or Platform Event–based logger, since logs can't be written in a failing transaction otherwise).

## Testing

- Target meaningful coverage, not just 75%: assert outcomes with the `Assert` class (`Assert.areEqual`, `Assert.isTrue`, with messages), never test without assertions.
- `@TestSetup` for shared data; a TestDataFactory class instead of inline record creation; `Test.startTest()/stopTest()` to isolate limits and force async execution.
- `System.runAs()` to test sharing/FLS behavior with a minimally-permissioned user — this is the only way to prove `WITH USER_MODE` paths behave.
- Mock callouts with `HttpCalloutMock`; mock dependencies with `Test.createStub` / `StubProvider`.
- Never `SeeAllData=true`.

## Review Checklist

SOQL/DML in loops; missing `WITH USER_MODE`/`as user` on user-facing paths; `WITH SECURITY_ENFORCED` anywhere (removed in v67); unbulkified trigger logic; missing recursion guard; hard-coded IDs; missing savepoint on multi-DML operations; `@future` where Queueable fits; assertions missing or vacuous in tests; `without sharing` without documented justification.
