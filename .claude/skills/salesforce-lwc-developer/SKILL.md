---
name: salesforce-lwc-developer
description: Expert Salesforce Lightning Web Components (LWC) developer guidance. Use when building, reviewing, refactoring, or debugging LWC components, templates, wire adapters, Jest tests, SLDS styling, Lightning Experience UI, or component-to-Apex wiring. Current through the Summer '26 release (API v67.0).
---

# Salesforce LWC Developer

You are acting as an expert Lightning Web Components developer with deep, current knowledge of the Lightning platform. Apply the practices below when writing or reviewing any LWC code.

## Release Currency (as of Summer '26)

- Salesforce releases: Winter '26 = API v65.0, Spring '26 = v66.0, **Summer '26 = v67.0**.
- Always check `sfdx-project.json` → `sourceApiVersion` and each component's `*.js-meta.xml` `apiVersion` before assuming a feature is available. LWC also supports **per-component API versioning** — behavior changes gate on the component's own `apiVersion`.

### Summer '26 LWC highlights
- **State Managers (GA)** — centralized, testable state shared across a component tree; prefer over prop-drilling or ad-hoc singleton modules for cross-component state.
- **LWC Component Preview (GA)** — preview a single component in the browser/VS Code without full page refresh; use during iterative UI work (`sf lightning dev`).
- **Dynamic Lists (Developer Preview)** — built-in row virtualization for thousands of rows; consider for long lists instead of hand-rolled pagination (don't ship dev-preview features to production).
- **Wire adapter improvements** — configurable auto-refresh intervals and lazy loading (defer fetch until the component is visible).
- **CSS Container Queries** supported natively — size components to their container, not the viewport.
- **`lightning/accApi`** — headless module to open/drive the Agentforce panel from a component.
- **Styling hooks for Flow screen components** — custom Screen Flow LWCs can expose SLDS styling hooks (color, radius, font weight).
- **Zero-JS accordions** via grouped `<details>` elements on API 67.
- **Salesforce Multi-Framework (Beta)** — React hosted natively; do not recommend for production yet.

## Modern Syntax & Component Patterns

- Use `lwc:if` / `lwc:elseif` / `lwc:else`. `if:true` / `if:false` are deprecated.
- Use `lwc:ref` for element references (not `querySelector` where a ref works), `lwc:spread` for bulk prop passing, and light DOM (`lwc:render-mode="light"` + `static renderMode`) only when global styling/third-party DOM access genuinely requires it.
- Track reactivity correctly: fields are reactive by default; `@track` is only needed for deep mutation of objects/arrays — but **prefer immutable updates** (`this.items = [...this.items]`, object spreads) so re-renders are predictable.
- One component = one job. Extract shared logic into service modules (plain ES modules in an LWC folder without a template) — or a State Manager on API 67+.
- Communicate: parent→child via `@api` props/public methods; child→parent via `CustomEvent` (add `bubbles: true, composed: true` only when the event must cross shadow boundaries); sibling/cross-DOM via Lightning Message Service; modals via `LightningModal` (not custom overlay divs).

## Data Access (in preference order)

1. `lightning-record-form` / `lightning-record-edit-form` / `lightning-record-view-form` — zero-code CRUD with FLS respected.
2. `lightning/ui*Api` wire adapters — `getRecord`, `getRecords`, `getRelatedListRecords`, `getObjectInfo`, `getPicklistValues`; `createRecord`/`updateRecord` from `lightning/uiRecordApi`.
3. `lightning-record-picker` for lookups (GA; replaces custom lookup components in most cases).
4. Imperative or `@wire`d Apex (`@AuraEnabled(cacheable=true)` for reads) — only when UI API can't do it (aggregates, cross-object logic, DML with side effects).

- The **GraphQL wire adapter (`lightning/uiGraphQLApi`) was deprecated in 2025** — do not use it for new work; migrate existing usage to UI API adapters or Apex.
- After imperative DML, refresh caches with `notifyRecordUpdateAvailable()` (preferred) or `refreshApex()`; inside record pages dispatch `RefreshEvent` from `lightning/refresh`.
- Wire handlers must handle `{ data, error }` both ways; never assume data arrives before first render.

## Styling

- Use **SLDS styling hooks** (`--slds-g-*` global hooks, component-level hooks) — never hard-code hex colors or copy SLDS internals; this keeps components compatible with SLDS 2 themes and dark mode.
- Use SLDS utility classes before writing custom CSS. Custom CSS is scoped per component (shadow DOM) — no leaking selectors.
- Design responsive with container queries (API 67+) or SLDS grid; never fixed pixel widths for layout.

## Security & Performance

- **Lightning Web Security (LWS)** is the default sandbox (Locker is retired) — third-party libs generally work, but still load them via static resources + `loadScript` and never `eval`.
- Never build HTML strings from user input; use `lwc:dom="manual"` only with sanitized content.
- Performance: avoid getters doing heavy work (they run every render); debounce input handlers; use `connectedCallback` for setup and clean up listeners in `disconnectedCallback`; key iterated lists with stable `key={item.id}` (never `index` when rows reorder).
- Guard against race conditions in async handlers (stale responses overwriting newer state) — track a request token or use AbortController patterns.

## Testing (sfdx-lwc-jest)

- Every component change gets/updates a Jest test. Pattern: create element via `createElement`, append to `document.body`, flush with `await Promise.resolve()` (or `flushPromises` helper), assert DOM.
- Mock Apex with `jest.mock('@salesforce/apex/...', () => ({ default: jest.fn() }), { virtual: true })`; mock wires with `@salesforce/sfdx-lwc-jest` adapters (`emit()` from registered test wire adapters).
- Test behavior (rendered DOM, dispatched events, Apex call args), not implementation details.

## Review Checklist

When reviewing LWC code, check: deprecated directives (`if:true`), mutation without reassignment (silent non-render), missing error paths on wires/imperative calls, hard-coded labels (use Custom Labels), hard-coded colors (use styling hooks), missing `key` in iterations, events not documented in the component's contract, missing Jest coverage, FLS/CRUD assumptions (UI API respects it; Apex must enforce it — see the salesforce-apex-developer skill).
