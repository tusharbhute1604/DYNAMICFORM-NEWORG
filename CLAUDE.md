# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
```bash
npm run lint                        # ESLint on all Aura/LWC JS files
npm run test                        # Run all Jest unit tests
npm run test:unit:watch             # Watch mode for Jest tests
npm run test:unit:coverage          # Coverage report
npm run prettier                    # Format all source files
```

### Salesforce CLI
```bash
sf project deploy start --source-dir force-app   # Deploy to default org
sf project deploy start -m LightningComponentBundle:dynamicRecordForm  # Deploy single component
sf project deploy start -m ApexClass:DynamicFormController             # Deploy Apex class
sf project deploy start -m CustomMetadata                              # Deploy all CMDT records
sf org open                         # Open default org in browser
```

### Running a single test file
```bash
npx sfdx-lwc-jest -- force-app/main/default/lwc/dynamicRecordForm/__tests__/dynamicRecordForm.test.js
```

## Architecture

### Core Pattern: Metadata-Driven Form Engine

The entire system is a **single LWC + single Apex controller** that renders any form entirely from CMDT configuration. No new Apex or LWC is written per form.

**CMDT Hierarchy:**
```
Form_Config__mdt (one per form)
  └── Form_Section__mdt (N sections per config)
        └── Form_Field__mdt (N fields per section)
```

### Three Custom Metadata Types

**`Form_Config__mdt`** — top-level form definition
- `Object_API_Name__c` — the primary SObject being saved
- `Display_Mode__c` — `Single Page` or `Wizard`
- `Save_Without_Sharing__c` — bypasses sharing rules via `SystemModeDML` inner class
- `Button_Config_JSON__c` — JSON override for button labels

**`Form_Section__mdt`** — one section/step in the form
- `Render_As__c` — blank (standard) or `Matrix` for 2D grid entry
- `Allow_Multiple_Rows__c` — enables add/remove row behavior
- `Object_API_Name__c` — if set, section fields map to a child object (not the form's parent object)
- `Relationship_Parent_Field__c` — the lookup field on the child object pointing to parent
- `Visibility_Logic__c` — JSON logic tree evaluated client-side (see Logic Format below)
- `Show_On__c` — `Both`, `Create`, or `Edit`
- `Parent_Section_DeveloperName__c` — links a Matrix section to a parent section (for two-phase save)
- `Section_Config_JSON__c` — columns/rows definition for Matrix sections

**`Form_Field__mdt`** — one field in a section
- `Field_Type__c` — `Text`, `Number`, `Checkbox`, `Date`, `DateTime`, `Picklist`, `Multi-Select Picklist`, `Lookup`, `Long Text Area`, `File Upload`, `Header`, `Display Text`, `Rich Text`, `Currency`, `Percent`
- `Visibility_Logic__c`, `Required_Logic__c` — JSON logic trees
- `Formula_Logic__c` — JS expression string, e.g. `{Quantity__c} * {Cost__c}`; fields referencing it become read-only
- `Dynamic_SOQL__c` — SOQL with `{FieldApi}` bind placeholders; auto-executes when dependencies change
- `Controlling_Lookup__c` — when this lookup changes, fields with a matching name fetch source data
- `Source_Field_API_Name__c` — field to pull from the controlling lookup's record
- `Prepopulate__c` + `Key_Prefix__c` — pre-fills the field when the component's `recordId` matches the prefix
- `Target_Object_API_Name__c` — override the save target to a different object than the section default
- `Save_To_Database__c` = false → field is UI-only, excluded from save payload

### LWC Component: `dynamicRecordForm`

**Public API:**
- `formDeveloperName` — CMDT `Form_Config__mdt.DeveloperName`
- `recordId` — context record (for pre-population or edit mode)
- `objectApiName` — informs edit vs. create mode detection
- `recordTypeId` — passed to picklist value resolution
- `formMode` — `auto` (default), `create`, or `edit`
- `isLightningOut` — switches file upload from `lightning-file-upload` to base64 upload (for Visualforce/Console)

**Core reactive loop** — after every field change (`handleFieldChange`, `handleMatrixChange`, `handleLookupSelect`), the engine always runs in this fixed order:
1. `calculateFormulas()` — recomputes formula fields
2. `applyMatrixRules()` — sets matrix cell readonly state, wipes locked cells
3. `evaluateVisibility()` — shows/hides sections and fields, wipes hidden values, restores values that re-appear

`evaluateVisibility()` runs in a stabilization loop (max 10 iterations) because wipes can cascade into further visibility changes.

**State management:**
- `sectionData` (keyed by row UUID) — flat store of all field values; the source of truth for save/formula/visibility
- `matrixState` (keyed `MATRIX__<sectionDevName>__<rowKey>__<colKey>`) — matrix cell values; accessible in visibility/formula logic via the same key string
- `sections` array — reactive tree of section/row/field objects; only mutated via spread (`[...this.sections]`) to trigger LWC re-render

### Apex Controller: `DynamicFormController.cls`

Key methods:
- `getFormMetadata(formDeveloperName, recordTypeId)` — cacheable; returns full form config + picklist options + dependency maps
- `getExistingRecordData(recordId, objectApiName, queryConfigJson)` — generic multi-object query builder for edit mode; builds SOQL from a JSON config describing parent + child objects and fields
- `saveMultiObject(parentObjectApiName, payload, relationshipMap, recordsToDelete, saveWithoutSharing)` — transactional upsert: parent first, then children; uses `Database.setSavepoint()` for rollback on error
- `executeDynamicQuery(soqlQuery, bindParams)` — executes the Dynamic SOQL queries defined in `Form_Field__mdt.Dynamic_SOQL__c`; uses `Database.queryWithBinds` in SYSTEM_MODE
- `rollbackTransaction(recordId, childIds, saveWithoutSharing)` — soft rollback by deleting inserted records if phase 2 fails

**`SystemModeDML`** inner class (`without sharing`) is used when `Save_Without_Sharing__c = true` — it provides upsert/delete/insert methods that bypass sharing rules.

**`PicklistDependencyHelper.cls`** — decodes the Salesforce `validFor` base64 bit-mask on picklist entries to build dependent picklist maps.

### Wrapper Components

Thin wrappers that host `dynamicRecordForm` for specific use cases. Each wrapper sets `formDeveloperName` and handles the `close` event for navigation:
- `caseCreateWrapper` / `caseEditWrapper` — Case forms
- `taskCreateWrapper` / `taskEditWrapper` — Task forms
- `calculateQcScore` — QC scoring form

Wrappers dispatch `close` (with `bubbles: true, composed: true`) to cross Shadow DOM into Visualforce containers, then also fire `CloseActionScreenEvent` for Quick Actions.

### Logic Format

Visibility, required, and matrix readonly logic all use the same JSON structure:

```json
{ "when": "FieldApiName", "operator": "equals|not_equals|includes|excludes", "value": "someValue" }

{ "operator": "AND", "conditions": [ ...nested conditions... ] }

{ "operator": "OR", "conditions": [ ...nested conditions... ] }
```

Matrix cell `readonlyLogic` uses the same format; the `when` field can reference any field in `sectionData` or a `MATRIX__<sectionDevName>__<rowKey>__<colKey>` key from `matrixState`.

### Two-Phase Matrix Save

Matrix sections with `Parent_Section_DeveloperName__c` set are "dependent" sections. They require the parent section's child record to be saved first (Phase 1), then the matrix records are saved against that new child record ID in Phase 2. This is why `handleSubmit` splits sections into `primarySections` and `dependentSections` and uses chained `saveMultiObject` calls.

### File Uploads

- Standard mode: uses `lightning-file-upload` component (reads `savedRecordId` from `FirstPublishLocationId`)
- Lightning Out mode (`isLightningOut = true`): uses native `<input type="file">` with base64 encoding via `FileReader`, then calls `uploadFile()` Apex method; max 4MB per file

### Deployment Notes

- API version: `65.0` (set in `sfdx-project.json`)
- Connected org is stored in `.sf/config.json`
- Husky pre-commit runs prettier + ESLint + Jest `--findRelatedTests` on staged files

## Known Issues & Performance Fixes

### Lookup Search Latency (FIXED)
**Issue:** Users reported >20 second delays when populating lookup fields in production, especially on high-volume objects (Account, Contact, Case).

**Root cause:** `searchRecords()` method used `WHERE Field LIKE '%term%'` — a full table scan that gets slower as data grows, plus one Apex call per keystroke.

**Fix applied (v1.1):**
- Replaced SOQL LIKE scan with SOSL (`Search.query()`) in `searchRecords()` — uses Salesforce's search index for consistent O(1) performance
- Added 300ms debounce in `handleLookupSearch()` — queues only one Apex call after user pauses typing, reducing server round-trips by ~70%
- Added `escapeSoslReservedChars()` helper to safely escape SOSL reserved characters (`* ? & | ! { } [ ] ( ) ^ ~ : \ " '`)

**Status:** Ready to deploy. Test on high-volume objects before release.

### Lookup Selection Race Condition (FIXED)
**Issue:** After selecting a record from lookup search results, previously queued Apex calls would finish and overwrite the selected value with stale search results.

**Root cause:** Stale-response guards (`_activeLookup`, `_activeSearchTerms`) were cleared only in `handleBlur`, not in `handleLookupSelect`, so pending `searchRecords` results would still pass the guard check and corrupt the UI.

**Fix applied (v1.1):** In `handleLookupSelect()`, immediately clear all stale-response guards and debounce timers after selection, ensuring pending calls can't overwrite the choice.

**Status:** Ready to deploy with search latency fix.

### Text Field Typing Delay (DEFERRED)
**Issue:** Users report typing latency (delay between keystroke and character appearance) in text and textarea fields, especially on forms with complex visibility logic or many fields.

**Root cause:** `handleFieldChange()` runs the full reactive cycle (`calculateFormulas()`, `applyMatrixRules()`, `evaluateVisibility()`) on every keystroke — synchronous work that blocks the main thread and delays input rendering.

**Why not fixed:** Debouncing the reactive cycle (300ms like lookup search) is riskier than debouncing Apex calls, because:
- A user typing then immediately moving to another field might see stale state if the debounce hasn't fired yet
- Visibility/formula logic could behave unexpectedly
- No safe way to "flush pending eval on blur" without introducing race conditions

**Deferred pending:** Business decision needed. If typing delay is acceptable, leave as-is. If it's a blocker, implement debounce with shorter delay (200ms) and add blur-time flush logic.

**To revisit:** Check with business users early next week; if they need this fixed, implement 200ms debounce on reactive cycle with blur-time flush.
