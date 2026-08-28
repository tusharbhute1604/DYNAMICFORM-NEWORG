# Technical Design Document

## `dynamicRecordForm` LWC & `DynamicFormController` Apex

**Version:** 3.1 — Exhaustive Implementation Reference  
**Status:** Production Ready  
**Audience:** Salesforce Developers, Architects, Technical Leads  
**Scope:** Full implementation analysis of `dynamicRecordForm.js`, `dynamicRecordForm.html`, and `DynamicFormController.cls`

**v3.1 revision (2026-08):** Synced with deployed bug fixes / enhancements — lookup search moved from SOQL `LIKE` scan to SOSL (`Search.query()`), 3-char threshold + 300 ms debounce in `handleLookupSearch()`, stale-guard clearing in `handleLookupSelect()`, 300 ms reactive-cycle debounce for text-like fields in `handleFieldChange()` with blur-time flush, `escapeSoslReservedChars()` helper, `saveWithoutSharing` param on `deleteRecord`/`uploadFile`/`rollbackTransaction`, matrix `readonlyLogic` AND/OR support.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Custom Metadata Type (CMDT) Data Model](#3-custom-metadata-type-cmdt-data-model)
4. [Apex Controller — DynamicFormController.cls](#4-apex-controller--dynamicformcontrollercls)
   - 4.1 [Class Structure & Inner Types](#41-class-structure--inner-types)
   - 4.2 [Public AuraEnabled Methods](#42-public-auraenabled-methods)
   - 4.3 [Private Helper Methods](#43-private-helper-methods)
   - 4.4 [SystemModeDML Inner Class](#44-systemmodedml-inner-class)
   - 4.5 [PicklistDependencyHelper.cls](#45-picklistdependencyhelperclss)
5. [LWC Component — dynamicRecordForm](#5-lwc-component--dynamicrecordform)
   - 5.1 [Public API (Properties)](#51-public-api-properties)
   - 5.2 [Internal State](#52-internal-state)
   - 5.3 [Component Lifecycle & Initialization Flow](#53-component-lifecycle--initialization-flow)
   - 5.4 [Form Building Pipeline](#54-form-building-pipeline)
   - 5.4.1 [Field Change Handler & Reactive Debounce](#541-field-change-handler--reactive-debounce)
   - 5.5 [Subsystem: Visibility Engine](#55-subsystem-visibility-engine)
   - 5.6 [Subsystem: Formula Engine](#56-subsystem-formula-engine)
   - 5.7 [Subsystem: Dynamic SOQL Engine](#57-subsystem-dynamic-soql-engine)
   - 5.8 [Subsystem: Matrix Engine](#58-subsystem-matrix-engine)
   - 5.9 [Subsystem: Reactive Context / Dependent Lookup Engine](#59-subsystem-reactive-context--dependent-lookup-engine)
   - 5.10 [Subsystem: Lookup Search & Selection](#510-subsystem-lookup-search--selection)
   - 5.11 [Subsystem: Picklist Dependency Filter](#511-subsystem-picklist-dependency-filter)
   - 5.12 [Validation Engine](#512-validation-engine)
   - 5.13 [Submission & Save Pipeline](#513-submission--save-pipeline)
   - 5.14 [File Upload Handling](#514-file-upload-handling)
   - 5.15 [Wizard Navigation](#515-wizard-navigation)
   - 5.16 [Rollback Mechanism](#516-rollback-mechanism)
6. [HTML Template Analysis](#6-html-template-analysis)
7. [Data Flow Diagrams](#7-data-flow-diagrams)
8. [Unified Execution Order](#8-unified-execution-order)
9. [Security Model](#9-security-model)
10. [Performance & Governor Limits](#10-performance--governor-limits)
11. [Error Handling Strategy](#11-error-handling-strategy)
12. [Known Limitations & Edge Cases](#12-known-limitations--edge-cases)
13. [Wrapper Component Patterns](#13-wrapper-component-patterns)

---

## 1. Executive Summary

`dynamicRecordForm` is a **metadata-driven, single-component form engine** for Salesforce LWC. A single deployed LWC, backed by a single Apex class, can render any intake form — across any combination of standard and custom objects — purely through CMDT configuration. No new Apex or LWC is written per form.

### Core Capabilities

| Capability                      | Implementation                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Multi-object transactional save | `saveMultiObject()` with a generic `SObject` upsert pipeline                                                                         |
| Client-side visibility logic    | `evaluateVisibility()` with AND/OR/includes/excludes operators                                                                       |
| Dependent picklists             | `PicklistDependencyHelper` + base64 `validFor` decoding                                                                              |
| Lookup typeahead                | `searchRecords()` index-backed SOSL search + 3-char threshold + 300 ms debounce in `handleLookupSearch()`                            |
| Input responsiveness            | Text/number/textarea fields debounce the reactive cycle 300 ms in `handleFieldChange()`; non-text changes flush pending timers first |
| Record Type-aware picklists     | `ConnectApi.RecordUi.getPicklistValuesByRecordType()`                                                                                |
| Formula fields                  | `calculateFormulas()` using `new Function()` eval                                                                                    |
| Dynamic SOQL fields             | `executeDynamicQuery()` with bind-variable injection                                                                                 |
| 2D matrix data entry            | `initializeMatrix()` backed by a junction object                                                                                     |
| File uploads                    | `lightning-file-upload` (standard) and base64 `uploadFile()` (Lightning Out)                                                         |
| Wizard mode                     | `currentStepIndex` + `findNextVisibleSectionIndex()`                                                                                 |
| Context-aware pre-population    | Key Prefix matching + `getSourceRecordData()`                                                                                        |
| Rollback on failure             | `rollbackTransaction()` with savepoint-like deletion                                                                                 |
| Save-without-sharing override   | `SystemModeDML` inner `without sharing` class                                                                                        |

---

## 2. Architecture Overview

### 2.1 MVC Pattern

```
┌─────────────────────────────────────────────────────────┐
│                  MODEL (CMDT)                           │
│  Form_Config__mdt → Form_Section__mdt → Form_Field__mdt │
└───────────────────────┬─────────────────────────────────┘
                        │ getFormMetadata() [cacheable wire]
┌───────────────────────▼─────────────────────────────────┐
│               VIEW + CONTROLLER (LWC)                   │
│           dynamicRecordForm.js / .html                  │
│  Owns all state, renders UI, drives all subsystems      │
└───────────────────────┬─────────────────────────────────┘
                        │ Apex imperative calls
┌───────────────────────▼─────────────────────────────────┐
│            SERVICE LAYER (Apex)                         │
│           DynamicFormController.cls                     │
│  Generic SObject engine: query, save, delete, upload    │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Component Topology

```
Wrapper LWC (e.g., caseCreateWrapper)
  └─ c-dynamic-record-form
       ├─ DynamicFormController.getFormMetadata  [wire]
       ├─ DynamicFormController.getExistingRecordData
       ├─ DynamicFormController.saveMultiObject
       ├─ DynamicFormController.searchRecords
       ├─ DynamicFormController.getRecordDetails
       ├─ DynamicFormController.getSourceRecordData
       ├─ DynamicFormController.executeDynamicQuery
       ├─ DynamicFormController.uploadFile
       ├─ DynamicFormController.deleteRecord
       └─ DynamicFormController.rollbackTransaction
```

### 2.3 State Architecture

The LWC maintains three parallel state structures that must stay synchronized:

| Structure            | Type            | Purpose                                                                                                                |
| -------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `this.sections[]`    | `@track` Array  | Drives the template. Contains fully decorated field objects with `currentValue`, `isVisible`, `filteredOptions`, etc.  |
| `this.sectionData{}` | `@track` Object | Keyed by row UUID. Stores the raw field values to be sent to Apex. The "source of truth" for save.                     |
| `this.matrixState{}` | `@track` Object | Keyed by `MATRIX__<sectionDev>__<rowKey>__<colKey>`. Stores matrix cell values for global visibility logic resolution. |

These three structures are **not directly equivalent** — `sections` may display a human-readable label for a Lookup while `sectionData` stores the raw Salesforce ID.

---

## 3. Custom Metadata Type (CMDT) Data Model

### 3.1 Form_Config__mdt

The root object. One record per form configuration.

| Field                     | Type      | Purpose                                                                                                  |
| ------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `DeveloperName`           | Text      | Passed as `formDeveloperName` to the LWC. Used as the form's primary key.                                |
| `Object_API_Name__c`      | Text      | The parent/primary SObject API name (e.g., `Case`). All non-child sections target this object.           |
| `Active__c`               | Checkbox  | If `false`, `getFormMetadata()` throws `AuraHandledException` immediately.                               |
| `Form_Title__c`           | Text      | Title displayed in the Lightning Card header.                                                            |
| `Form_Icon__c`            | Text      | SLDS icon name for the Lightning Card (e.g., `standard:case`).                                           |
| `Display_Mode__c`         | Picklist  | `Single Page` or `Wizard`. Controls step-by-step navigation.                                             |
| `Form_Instructions__c`    | Long Text | Rendered as `lightning-formatted-rich-text` above the sections.                                          |
| `Button_Config_JSON__c`   | Long Text | JSON object overriding default button labels (e.g., `{"submit": "Submit Case"}`).                        |
| `Save_Without_Sharing__c` | Checkbox  | Passes `saveWithoutSharing=true` to all DML operations, routing through the `SystemModeDML` inner class. |

### 3.2 Form_Section__mdt

Defines a logical grouping of fields. Many per `Form_Config__mdt`.

| Field                             | Type            | Purpose                                                                                                                                                   |
| --------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Form_Config__c`                  | MD Relationship | Parent form.                                                                                                                                              |
| `DeveloperName`                   | Text            | Unique identifier used for matrix keys, parent-section linking.                                                                                           |
| `Label` / `Override_Label__c`     | Text            | Display label. Override takes precedence.                                                                                                                 |
| `Order__c`                        | Number          | Sort order; sections rendered ascending.                                                                                                                  |
| `Object_API_Name__c`              | Text            | If different from parent form's object, this section targets a child object.                                                                              |
| `Relationship_Parent_Field__c`    | Text            | API name of the lookup field on the child object pointing to the parent.                                                                                  |
| `Allow_Multiple_Rows__c`          | Checkbox        | Enables Add/Remove row buttons. The LWC renders one row per child record in edit mode.                                                                    |
| `Visibility_Logic__c`             | Long Text       | JSON logic tree (see Section 5.5). Evaluated globally across all section data.                                                                            |
| `Number_of_Columns__c`            | Number          | `1` or `2`. Drives grid size calculation (`12 / numColumns`).                                                                                             |
| `Render_As__c`                    | Picklist        | `Matrix` or blank (standard).                                                                                                                             |
| `Section_Config_JSON__c`          | Long Text       | Required if `Render_As__c = Matrix`. Defines rows, columns, and cell-level readonly logic.                                                                |
| `Show_On__c`                      | Picklist        | `Create`, `Edit`, or `Both`. Filters which sections appear per form mode.                                                                                 |
| `Is_Required__c`                  | Checkbox        | For Matrix sections: validation enforces at least one cell has data.                                                                                      |
| `Collapse_by_Default__c`          | Checkbox        | If `true`, section renders collapsed.                                                                                                                     |
| `Parent_Section_DeveloperName__c` | Text            | Links a dependent Matrix section to its parent. Used to resolve the parent record ID before saving dependent matrix entries in Phase 2 of `handleSubmit`. |
| `Custom_Component_Name__c`        | Text            | Reserved for future custom component injection.                                                                                                           |

### 3.3 Form_Field__mdt

Individual field configuration. Many per `Form_Section__mdt`.

| Field                           | Type            | Purpose                                                                                                                                                                                                               |
| ------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Form_Section__c`               | MD Relationship | Parent section.                                                                                                                                                                                                       |
| `Field_API_Name__c`             | Text            | Salesforce API name. If blank, field is UI-only (gets a synthetic `UI_ONLY_<Id>` key).                                                                                                                                |
| `Field_Type__c`                 | Picklist        | Determines rendering: `Text`, `Number`, `Currency`, `Percent`, `Date`, `DateTime`, `Checkbox`, `Picklist`, `Multi-Select Picklist`, `Lookup`, `Long Text Area`, `File Upload`, `Display Text`, `Rich Text`, `Header`. |
| `Label` / `Override_Label__c`   | Text            | Display label.                                                                                                                                                                                                        |
| `Order__c`                      | Number          | Sort order within section.                                                                                                                                                                                            |
| `Required__c`                   | Checkbox        | Static required flag.                                                                                                                                                                                                 |
| `Required_Logic__c`             | Long Text       | JSON logic tree for dynamic required evaluation.                                                                                                                                                                      |
| `Visibility_Logic__c`           | Long Text       | JSON logic tree for field-level visibility. Evaluated against row-local data.                                                                                                                                         |
| `Read_Only__c`                  | Checkbox        | Disables the input. Also auto-set to `true` if `Formula_Logic__c` is populated.                                                                                                                                       |
| `Default_Value__c`              | Text            | Populates field on create mode. Parsed to correct type (Boolean, Number, etc.).                                                                                                                                       |
| `Controller_Field__c`           | Text            | API name of the controlling picklist field. Enables dependency filtering.                                                                                                                                             |
| `Controlling_Lookup__c`         | Text            | API name of the controlling Lookup field. When that lookup changes, `handleReactiveContextChange` fires.                                                                                                              |
| `Lookup_Target_Object__c`       | Text            | API name of the SObject to search when this is a Lookup field.                                                                                                                                                        |
| `Lookup_Search_Field__c`        | Text            | Comma-separated field API names to query in `searchRecords()`. First field becomes the display label.                                                                                                                 |
| `Prepopulate__c`                | Checkbox        | Marks this field for context-aware pre-population.                                                                                                                                                                    |
| `Key_Prefix__c`                 | Text            | 3-char Salesforce ID prefix (e.g., `001`). The current `recordId` must start with this prefix for pre-population to trigger.                                                                                          |
| `Source_Field_API_Name__c`      | Text            | When pre-populating, the field to read from the context record via `getSourceRecordData()`.                                                                                                                           |
| `Fetch_On_Edit__c`              | Checkbox        | Forces `Dynamic_SOQL__c` to execute on edit mode load (normally skipped).                                                                                                                                             |
| `Override_Picklist_Values__c`   | Long Text       | Comma-separated string. Overrides CMDT-derived or schema-derived picklist options. Also used as `acceptedFormats` for File Upload fields.                                                                             |
| `Override_Dependency_JSON__c`   | Long Text       | JSON map of `{ "controllerValue": [ {label, value} ] }`. Overrides schema dependency resolution.                                                                                                                      |
| `Target_Object_API_Name__c`     | Text            | If set, overrides the section's `Object_API_Name__c` for this field's target.                                                                                                                                         |
| `Target_Object_Parent_Field__c` | Text            | If `Target_Object_API_Name__c` is set, the relationship field on the target object.                                                                                                                                   |
| `Help_Text__c`                  | Text            | Rendered in a `<div>` below the field.                                                                                                                                                                                |
| `HTML_Content__c`               | Long Text       | Content for `Display Text`/`Rich Text` type fields; rendered via `lightning-formatted-rich-text`.                                                                                                                     |
| `Dynamic_SOQL__c`               | Long Text       | SOQL query with `{FieldApiName}` bind variable tokens. Executes reactively when dependencies change.                                                                                                                  |
| `Formula_Logic__c`              | Long Text       | JS expression with `{FieldApiName}` tokens. Evaluated client-side via `new Function()`. Result stored to `sectionData`.                                                                                               |
| `Save_To_Database__c`           | Checkbox        | If `false`, field value is excluded from the save payload.                                                                                                                                                            |

---

## 4. Apex Controller — DynamicFormController.cls

The class is declared `public with sharing`, meaning standard record access rules apply for all read operations. DML override is achieved selectively via the `SystemModeDML` inner class.

### 4.1 Class Structure & Inner Types

```
DynamicFormController (public with sharing)
├── FormWrapper
│   ├── objectApiName, formTitle, formIcon, formInstructions
│   ├── buttonConfig, currentUserId, currentUserName
│   ├── displayMode, saveWithoutSharing
│   └── sections: List<SectionWrapper>
│
├── SectionWrapper
│   ├── id, developerName, label, order, objectApiName
│   ├── relationshipParentField, allowMultipleRows
│   ├── visibilityLogic, numColumns, customComponentName
│   ├── showOn, isRequired, isCollapsed
│   ├── renderAs, sectionConfig, parentSectionDevName
│   └── fields: List<FieldWrapper>
│
├── FieldWrapper
│   ├── label, apiName, type, htmlContent
│   ├── required, requiredLogic, visibilityLogic
│   ├── controllerField, controllingLookup
│   ├── lookupTargetObject, lookupSearchField
│   ├── picklistOptions, dependencyMap, overridePicklistValues
│   ├── prepopulate, readOnly, keyPrefix
│   ├── sourceFieldApiName, excludeFromDb, fetchOnEdit
│   ├── targetObject, parentRelationshipField
│   ├── helpText, defaultValue, formulaLogic, saveToDb
│   └── dynamicSoql
│
├── LookupRecordDetails
│   └── id, label, details
│
└── SystemModeDML (without sharing)
    ├── doUpsert(SObject)
    ├── doUpsert(List<SObject>)
    ├── doDelete(List<SObject>)
    ├── doDelete(List<SObject>, Boolean allOrNone)
    └── doInsert(SObject)
```

### 4.2 Public AuraEnabled Methods

---

#### `getFormMetadata(String formDeveloperName, String recordTypeId)`

**Annotation:** `@AuraEnabled(cacheable=true)` — wired via `@wire` in the LWC.

**Purpose:** The primary metadata loader. Returns the fully assembled `FormWrapper` containing sections and fields.

**Algorithm:**

1. Queries `Form_Config__mdt` by `DeveloperName`. Throws `AuraHandledException` if `Active__c == false`.
2. Builds `FormWrapper` from config fields. Sets `saveWithoutSharing`, `currentUserId`, `currentUserName`.
3. Queries all `Form_Section__mdt` records linked to this config, ordered by `Order__c ASC`.
4. Queries all `Form_Field__mdt` records in a single SOQL call across all sections using a cross-relationship filter on `Form_Section__r.Form_Config__r.DeveloperName`.
5. Performs a **one-time `Schema.getGlobalDescribe()`** for the parent object into `mainDescribeMap`.
6. Maintains a `childDescribeCache` map to avoid repeated `getGlobalDescribe()` calls for child objects.
7. For each section, builds a `SectionWrapper`, then iterates `allFields` filtering by `Form_Section__c == sec.Id`.
8. For each field, runs **type-specific logic:**
   - `Display Text` / `Rich Text` → forces `excludeFromDb = true`, `saveToDb = false`.
   - Null `Field_API_Name__c` → assigns synthetic key `UI_ONLY_<Id>`, forces `excludeFromDb = true`.
   - Picklist/Multi-Select → calls `processPicklistLogic()` with the relevant describe map.

**Critical Nuances:**

- `fw.targetObject` defaults to the parent object's API name unless `Target_Object_API_Name__c` is explicitly set on the field CMDT record.
- `fw.saveToDb = (f.Save_To_Database__c != false)` — note the triple-state: `null` is treated as `true` (save by default).

---

#### `executeDynamicQuery(String soqlQuery, Map<String, Object> bindParams)`

**Annotation:** `@AuraEnabled` (non-cacheable — side-effects possible)

**Purpose:** Executes a dynamic SOQL query with externally supplied bind parameters.

**Algorithm:**

1. Validates that `soqlQuery` is not blank.
2. Appends `LIMIT 1` if not already present.
3. Calls `Database.queryWithBinds(soqlQuery, bindParams, AccessLevel.SYSTEM_MODE)` — this is the secure, injection-safe way to execute SOQL with runtime bind variables at system level.
4. Returns the first result or `null`.
5. All exceptions are swallowed and `null` is returned — intentional; the LWC handles the null case gracefully.

**Security Note:** `AccessLevel.SYSTEM_MODE` is used deliberately. The query is constructed by `DynamicFormController` from a CMDT-configured template, so admin-controlled; the bind params come from user input but are sanitized by the bind mechanism.

---

#### `searchRecords(String searchTerm, String objectApiName, String searchFields)`

**Annotation:** `@AuraEnabled(cacheable=true)`

**Purpose:** Powers the Lookup field search dropdown.

**Algorithm (SOSL — replaced the legacy SOQL `LIKE '%term%'` scan):**

1. Trims each entry in `searchFields` (comma-separated) into `fieldList`.
2. Builds the SOSL search term: `escapeSoslReservedChars(searchTerm) + '*'` (trailing wildcard for prefix matching against the search index).
3. Builds a `WHERE` clause of `<field> LIKE '%term%'` conditions joined by `OR` over `fieldList` — this re-filters the FIND-matched candidate set down to the configured fields (FIND matches on `IN ALL FIELDS`, so a hit in an unconfigured field like `Description` would otherwise leak through). The `LIKE` value is escaped with `String.escapeSingleQuotes()`.
4. If `objectApiName` is `User` (case-insensitive), appends `AND IsActive = true` — SOSL has no built-in active-user filter, so standard-lookup behavior is enforced explicitly.
5. Executes `Search.query('FIND \'term*\' IN ALL FIELDS RETURNING Object(Id, <fields> WHERE <clause> LIMIT 10)')`. Object and field identifiers are escaped with `String.escapeSingleQuotes()`.
6. Returns a `List<Map<String, String>>` with keys: `id`, `label`, `meta`, `details`.
   - `label` = first search field value
   - `meta` = second search field value (for the combobox subtitle)
   - `details` = newline-joined `fieldName: value` for all fields beyond index 0 (rendered in a `lightning-helptext` tooltip)

**Why SOSL:** A leading-wildcard SOQL `LIKE '%term%'` forces a full table scan that degrades on high-volume objects (Account, Contact, Case). SOSL uses the search index for near-constant lookup time. Trade-off: newly created records are not searchable until the async search indexer has processed them (typically seconds), and SOSL counts against a separate governor bucket (20 queries / 2,000 rows per transaction).

---

#### `getRecordDetails(String recordId, String objectApiName, String searchFields)`

**Annotation:** `@AuraEnabled(cacheable=true)`

**Purpose:** Fetches display-ready details for a known record ID. Used both on form load (edit mode Lookup display) and after a Dynamic SOQL resolves a Lookup ID.

**Self-Healing Logic (Critical):**

- If `objectApiName` is blank/null/"null"/"undefined" → derives the object from `recId.getSObjectType()`.
- If `searchFields` is blank/null/"null"/"undefined" → defaults to `Name`.
- Special case: `Case` object has no `Name` field → overrides `searchFields` to `CaseNumber`.

**Return value:** `LookupRecordDetails` with `id`, `label`, and multi-line `details` string.

**Fallback on exception:** Returns the raw `recordId` as both `id` and `label` rather than throwing, preventing UI crashes from stale IDs.

---

#### `getSourceRecordData(String sourceRecordId, List<String> sourceFields)`

**Annotation:** `@AuraEnabled`

**Purpose:** Reads specific fields from a context record for pre-population during create mode. Also used by `handleReactiveContextChange` to fetch dependent field values when a controlling Lookup changes.

**Algorithm:**

1. Resolves `SObjectType` from the record ID.
2. Builds a case-insensitive `lowerFieldMap` of the object's field describe results.
3. For each requested field, if the field is a `REFERENCE` type, also queries the relationship path (`RelationshipName.Name`) to get the display label.
4. Returns a `Map<String, Map<String, Object>>` where the outer key is the original field API name and the inner map has `value` (raw ID for references) and `label` (display name for references, same as value for non-references).

---

#### `getExistingRecordData(String recordId, String objectApiName, String queryConfigJson)`

**Annotation:** `@AuraEnabled`

**Purpose:** Fetches the complete data bundle for a record and its related children in a single method call. Used by `initializeComponent()` for edit mode load and by `fetchDependentData()` for matrix sections.

**Algorithm:**

1. Parses `queryConfigJson` (a JSON object with `parentFields` and `children` arrays).
2. For `parentFields`: builds a dynamic SOQL for the parent object including lookup relationship path traversal.
3. For each child config in `children`: builds a separate SOQL for the child object filtered by the parent ID, `LIMIT 100`.
4. Calls `processRecord()` for each result to inject `fieldApi + '_Label'` values for Lookup fields.
5. Returns `{ parent: {}, children: { ObjectApiName: [{}, ...] } }`.

**Lookup Label Resolution:** The method calls `getRelationshipField()` to convert a field API name to its relationship name (e.g., `AccountId` → `Account`, `My_Custom__c` → `My_Custom__r`), then fetches `RelationshipName.FirstSearchField`. For the polymorphic/standard fields `WhatId`, `WhoId`, and `OwnerId` the first search field is forced to `Name` regardless of the configured `Lookup_Search_Field__c`, because the relationship target may not expose that field.

---

#### `saveMultiObject(String parentObjectApiName, Map<String, Object> payload, Map<String, Object> relationshipMap, List<String> recordsToDelete, Boolean saveWithoutSharing)`

**Annotation:** `@AuraEnabled`

**Purpose:** The core transactional save method. Handles parent upsert + child upserts + deletions in one database transaction.

**Algorithm:**

```
1. Set Savepoint
2. Process recordsToDelete:
   a. Group IDs by SObjectType
   b. Query each group to get real SObject instances
   c. Delete (via SystemModeDML or direct Database.delete)
3. Lowercase-normalize payload keys for case-insensitive access
4. Extract parentData from payload[parentObjectApiName]
5. Create parent SObject via createSObject()
6. If Id present in parentData: set it (UPDATE path); else INSERT path
7. Upsert parent
8. For each non-parent key in payload:
   a. Look up corresponding relationship field from relationshipMap
   b. If data is List: iterate, create each SObject, upsert batch
   c. If data is Map: create single SObject, upsert it
   d. For new records: auto-set lookupField = parentRec.Id
9. Return { parentId, childIds (map), allInsertedChildIds (list) }
10. On any exception: rollback to savepoint, re-throw
```

**Critical Detail:** If a child record already has an `Id` in its payload, it is treated as an UPDATE (not linked to parent again). This preserves existing relationships.

**Return payload structure:**

```json
{
  "parentId": "001...",
  "childIds": { "ChildObject__c": "a01..." },
  "allInsertedChildIds": ["a01...", "a02..."]
}
```

`allInsertedChildIds` is used by the LWC's `_rollbackChildIds` array for potential rollback.

---

#### `deleteRecord(String recordId, Boolean saveWithoutSharing)`

**Annotation:** `@AuraEnabled`

**Purpose:** Standalone record deletion. Used for file (ContentDocument) removal via `handleFileRemove`.

**Algorithm:** Derives `SObjectType` from the ID, creates a shell SObject with only the ID set, calls `Database.delete` or `SystemModeDML.doDelete`.

---

#### `rollbackTransaction(String recordId, List<String> childIds, Boolean saveWithoutSharing)`

**Annotation:** `@AuraEnabled`

**Purpose:** Deletes records created in a failed or cancelled transaction. Called by `handleCancel()` (if save was committed but user cancels before upload) and by `handleSubmit()` catch block.

**Algorithm:**

1. Builds `childRecordsToDelete` list from `childIds` (shell SObjects with only ID).
2. Builds `parentRecordToDelete` list from `recordId`.
3. Deletes children first (allOrNone = false).
4. Deletes parent after (allOrNone = false).
5. Exceptions are caught and logged — rollback itself does not throw, preventing error loops.

**Key safety flag:** `allOrNone = false` ensures that if some records are already deleted (race condition), the rollback still processes the rest rather than failing entirely.

---

#### `uploadFile(String parentId, String fileName, String base64Data, Boolean saveWithoutSharing)`

**Annotation:** `@AuraEnabled`

**Purpose:** Handles file upload for the Lightning Out / Visualforce context where `lightning-file-upload` is unavailable.

**Algorithm:**

1. Creates a `ContentVersion` record with `VersionData` decoded from base64, `Title`, `PathOnClient`, and `FirstPublishLocationId = parentId`.
2. Inserts via `SystemModeDML.doInsert` or direct insert.
3. Re-queries the `ContentVersion` to get `ContentDocumentId`.
4. Returns `ContentDocumentId` for UI tracking.

---

### 4.3 Private Helper Methods

#### `processPicklistLogic(Form_Field__mdt f, FieldWrapper fw, Map<String, SObjectField> describeMap, String recordTypeId, String rootObjectApiName)`

Centralizes all picklist population logic in one pass:

1. **Override values first:** If `Override_Picklist_Values__c` is set, builds options from comma-split and returns.
2. **Override dependency JSON:** If `Override_Dependency_JSON__c` is set, builds the `dependencyMap` from the JSON map.
3. **ConnectAPI path (Record Type-aware):** If `recordTypeId` is provided and the field targets the root object, calls `ConnectApi.RecordUi.getPicklistValuesByRecordType()`. This respects Record Type value filtering (Spring '26+). Wrapped in `!Test.isRunningTest()` guard.
4. **Schema fallback:** If ConnectAPI fails or no RT, falls back to `dfr.getPicklistValues()` filtering for `isActive()` only.
5. **Dependency map filtering:** If a `Controller_Field__c` is set, calls `PicklistDependencyHelper.getSerializedDependencyMap()` and, if ConnectAPI was used, filters the dependency map to only include values present in the RT-filtered options.

---

#### `processRecord(SObject rec, Map<String, String> lookupMap)`

Converts an SObject to a flat `Map<String, Object>` via `getPopulatedFieldsAsMap()`. For each entry in `lookupMap`, traverses the relationship path to extract the display label and stores it under `fieldApi + '_Label'`.

---

#### `getRelationshipField(String apiName)`

Converts an ID-type field API name to its relationship name:

- `AccountId` → `Account` (strips trailing `Id`)
- `My_Custom__c` → `My_Custom__r` (swaps `__c` for `__r`)
- Otherwise returns unchanged.

---

#### `createSObject(String objName, Map<String, Object> data)`

The generic SObject hydration method used by `saveMultiObject`.

1. Gets `SObjectType` from `Schema.getGlobalDescribe()`.
2. Builds a case-insensitive `lowerFieldMap`.
3. Iterates the data map; for each key that maps to a known field:
   - Checks `isCreateable() || isUpdateable()` — respects FLS.
   - If value is blank/null and field is nillable: sets `null`.
   - Otherwise type-casts by `DisplayType`: `DOUBLE`, `CURRENCY`, `PERCENT` → `Double.valueOf()`; `INTEGER` → `Integer.valueOf()`; `DATE` → `Date.valueOf()`; `DATETIME` → JSON deserialization for ISO 8601 strings; `BOOLEAN` → `Boolean.valueOf()`; `REFERENCE` / `ID` → strips non-alphanumeric and casts to `Id`.

---

#### `getCleanErrorMessage(Exception e)`

Normalizes Apex exceptions into human-readable messages:

- `DmlException` → extracts first DML message.
- `FIELD_CUSTOM_VALIDATION_EXCEPTION` → strips to just the validation message.
- `INSUFFICIENT_ACCESS` → generic permission message.
- `DUPLICATE_VALUE` → generic duplicate message.
- `REQUIRED_FIELD_MISSING` → extracts field names.
- Any class stack trace reference (`Class.`) → strips it.

---

#### `escapeSoslReservedChars(String term)`

Backslash-escapes every SOSL reserved character in the raw search term before it is handed to `Search.query()` in `searchRecords()`. Reserved set: `\ ? & | ! { } [ ] ( ) ^ ~ * : " '`. Returns the term unchanged when blank. This is what makes the SOSL `FIND` clause injection-safe (SOSL has no bind-variable equivalent for the `FIND` term inside a dynamically built query string).

---

### 4.4 SystemModeDML Inner Class

```apex
@TestVisible
private without sharing class SystemModeDML {
  public void doUpsert(SObject record) {
    upsert record;
  }
  public void doUpsert(List<SObject> records) {
    upsert records;
  }
  public void doDelete(List<SObject> records) {
    Database.delete(records);
  }
  public void doDelete(List<SObject> records, Boolean allOrNone) {
    Database.delete(records, allOrNone);
  }
  public void doInsert(SObject record) {
    insert record;
  }
}
```

**Pattern:** The outer class is `with sharing`. This inner class is `without sharing`. By instantiating it and delegating DML calls, the DML executes in the inner class's sharing context, bypassing row-level access rules. This is the canonical Salesforce pattern for admin-controlled bypass (e.g., intake forms where the submitting user has no edit rights to the target object).

**Activation:** Controlled by `Form_Config__mdt.Save_Without_Sharing__c` → `saveWithoutSharing = true` → all DML paths in `saveMultiObject`, `deleteRecord`, `rollbackTransaction`, and `uploadFile` route through `SystemModeDML`.

---

### 4.5 PicklistDependencyHelper.cls

A separate class that decodes Salesforce's binary picklist dependency encoding.

**Method:** `getSerializedDependencyMap(Schema.SObjectField dependentField)`

**Algorithm:**

1. Gets the controller field via `depRes.getController()`.
2. Serializes each `PicklistEntry` to JSON to access the hidden `validFor` property (a base64-encoded bitmask).
3. Calls `getBase64Indexes(validFor)` which decodes the base64 string character by character, converting each 6-bit value to a list of integer indices.
4. Each index maps to a position in the controller field's picklist entries array — those are the controlling values for which this dependent option is valid.
5. Returns `Map<String, List<Map<String, String>>>` where keys are controller values and values are lists of `{label, value}` maps.

**Why serialization?** The `validFor` property is not exposed by any public Apex API. The only way to read it is to serialize the `PicklistEntry` object to JSON and parse it back as a generic map. This is a long-standing community pattern.

---

## 5. LWC Component — dynamicRecordForm

### 5.1 Public API (Properties)

| Property            | Type                   | Default  | Description                                                                                    |
| ------------------- | ---------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `formDeveloperName` | `@api String`          | —        | Drives the `@wire` call to `getFormMetadata`.                                                  |
| `formMode`          | `@api String`          | `'auto'` | `'auto'` (ID-based detection), `'create'` (force create, ID = context), `'edit'` (force edit). |
| `recordId`          | `@api String` (setter) | —        | Setter calls `attemptInit()` on change.                                                        |
| `objectApiName`     | `@api String` (setter) | —        | Setter calls `attemptInit()` on change.                                                        |
| `recordTypeId`      | `@api String` (setter) | `''`     | Sanitizes `undefined`/`null` to empty string. Drives `@wire` for RT-aware picklists.           |
| `isLightningOut`    | `@api Boolean`         | `false`  | Switches file upload between `lightning-file-upload` and base64 `uploadFile()`.                |

**Setter Pattern:** `recordId` and `objectApiName` are implemented as getter/setter pairs. The setter calls `attemptInit()`, which fires `initializeComponent()` only once the metadata wire has resolved. This prevents race conditions.

---

### 5.2 Internal State

#### Primary Tracked State

| Property            | Type             | Description                                                                               |
| ------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `sections`          | `@track []`      | Fully decorated section objects driving the template.                                     |
| `sectionData`       | `@track {}`      | `{ [rowUuid]: { [fieldApiName]: value } }` — the save payload source of truth.            |
| `matrixState`       | `@track {}`      | `{ "MATRIX__sectionDev__rowKey__colKey": value }` — global matrix value access for logic. |
| `isLoading`         | `@track Boolean` | Controls the loading spinner and disables all inputs/buttons.                             |
| `savedRecordId`     | `@track String`  | Set after a successful save. Enables File Upload section rendering.                       |
| `isSubmitHidden`    | `@track Boolean` | When `true`, shows only file upload sections (post-save, pre-finish state).               |
| `hasRequiredUpload` | `@track Boolean` | Affects button display logic: `Save & Continue to Upload` vs `Submit`.                    |
| `hasOptionalUpload` | `@track Boolean` | Affects button display: shows both `Save & Finish` and `Save & Attach Files`.             |
| `hasAnyUpload`      | `@track Boolean` | Set from `hasRequiredUpload                                                               |     | hasOptionalUpload`after`buildForm`. Drives `showStepButtons`/`showSubmitButton`. |
| `isEditMode`        | `@track Boolean` | Set during `buildForm`. Affects row initialization and button labels.                     |
| `currentStepIndex`  | `@track Number`  | Active step index in Wizard mode.                                                         |
| `displayMode`       | `@track String`  | `'Single Page'` or `'Wizard'`.                                                            |
| `labels`            | `@track {}`      | All button/toast labels. Overridable via `Button_Config_JSON__c`.                         |

#### Non-Tracked Internal State

| Property              | Type             | Description                                                                                                                                                                                                     |
| --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_formTargetObject`   | String           | API name of the primary object (from metadata).                                                                                                                                                                 |
| `_recordsToDelete`    | Array            | Collects IDs of removed child rows to delete on save.                                                                                                                                                           |
| `_cachedMetadata`     | Object           | Raw `FormWrapper` from the `@wire`.                                                                                                                                                                             |
| `_lastLoadKey`        | String           | Prevents duplicate initialization (`recordId-objectApiName-formMode-recordTypeId`).                                                                                                                             |
| `_serverData`         | Object           | Raw result from `getExistingRecordData`. Used by submit to look up existing child IDs.                                                                                                                          |
| `_cachedSourceData`   | Object           | Raw result from `getSourceRecordData`. Used for prepopulation.                                                                                                                                                  |
| `_activeLookup`       | String           | `rowId-fieldApi` key of the currently focused lookup. Prevents stale dropdown updates. Cleared in `handleFocus`/`handleBlur` and immediately on `handleLookupSelect`.                                           |
| `_activeSearchTerms`  | Object           | Stale-response guard: keyed by `rowId-fieldApi`, stores the last search term sent. Entry deleted on selection.                                                                                                  |
| `_lookupSearchTimers` | Object           | 300 ms debounce timers for `handleLookupSearch()`, keyed by `rowId-fieldApi`. Cleared on new keystroke, on empty input, and on selection.                                                                       |
| `_fieldChangeTimers`  | Object           | 300 ms debounce timers for the `handleFieldChange()` reactive cycle on text-like fields, keyed by `field-<rowId>-<fieldApi>`. Flushed wholesale by `flushAllFieldChangeTimers()` when a non-text field changes. |
| `_activeSoqlQueries`  | Object           | Stale query guard: keyed by `rowId-fieldApi`, stores the serialized bind params of the last query sent.                                                                                                         |
| `_isSaveCommitted`    | Boolean          | `true` once `saveMultiObject` has resolved with a parent ID. Guards rollback eligibility.                                                                                                                       |
| `_rollbackChildIds`   | Array            | Accumulates all inserted child/matrix IDs for rollback.                                                                                                                                                         |
| `saveWithoutSharing`  | `@track Boolean` | Mirrors `Form_Config__mdt.Save_Without_Sharing__c`. Passed to all Apex calls.                                                                                                                                   |

---

### 5.3 Component Lifecycle & Initialization Flow

```
@wire(getFormMetadata) fires
    │
    ▼
wiredMetadata({ data }) resolves
    │── stores to _cachedMetadata
    │── calls attemptInit()
    │
    ▼
attemptInit()
    │── guards: _cachedMetadata must exist
    │── calls initializeComponent()
    │
    ▼
initializeComponent()
    │── guards: formMode='edit' requires recordId
    │── deduplication via _lastLoadKey
    │── builds _formTargetObject, formTitle, displayMode, etc.
    │── parses buttonConfig overrides
    │
    ├─ [edit / auto+ID mode] → getExistingRecordData()
    │       │── on success: buildForm(sections, obj, existingData, null, null)
    │       │── on failure: handleCreateMode()
    │
    └─ [create / auto+no ID] → handleCreateMode()
            │── finds prepopulate fields + context match
            │── calls getRecordDetails() + getSourceRecordData() in parallel
            └── buildForm(sections, obj, null, recordDetails, null)
```

**Key Design:** `attemptInit()` is also called from the `recordId` and `objectApiName` setters. This handles the case where metadata resolves before the record ID is set (common in Aura/Flow contexts).

---

### 5.4 Form Building Pipeline

`buildForm(sectionsData, parentObjectName, existingData, prepopData, prepopFieldName, fullDataBundle)`

This is the central rendering function. It runs once per form load.

```
1. Reset: isEditMode, _recordsToDelete, hasRequiredUpload, hasOptionalUpload,
         currentStepIndex, matrixState

2. Determine currentMode ('edit' or 'create')

3. Filter sections by isSectionAllowed(sec, currentMode)

4. Sort remaining sections by order

5. For each section:
   a. Determine isMatrix vs isStandardSection
   b. Calculate colSize = Math.floor(12 / numColumns)
   c. Determine isChildSection (targetObject !== parentObjectName)

   [MATRIX section]
   → parse sectionConfig JSON
   → call initializeMatrix(parsedConfig, devName, fullDataBundle, matrixObj)

   [STANDARD CHILD section in EDIT MODE with existing records]
   → for each existing child record: create row UUID, call initializeFields()
   → stores record.Id in sectionData[rowUuid]['Id']

   [ALL OTHER STANDARD sections (including when no child records exist)]
   → create one row UUID
   → resolve dataContext (parent data or first child record)
   → call initializeFields()
   → if dataContext has Id and isEdit: store Id in sectionData + savedRecordId

6. Push fully decorated section object to this.sections

7. Store sectionData = initialSectionData

8. setTimeout(300ms):
   a. calculateFormulas(true) — initial formula pass
   b. applyMatrixRules()       — initial readonly rule pass
   c. evaluateVisibility()     — initial visibility pass
   d. fetchDependentData()     — async: load matrix data for dependent (parent-linked) matrix sections;
                                 on resolve it rebuilds matrixRows, then re-runs applyMatrixRules() +
                                 evaluateVisibility() so sections whose visibility depends on a MATRIX__
                                 cell value settle correctly in edit mode
   e. fetchMissingLookupDetails() — async: resolve Lookup display labels
   f. evaluateDynamicQueries() — async: fire initial SOQL evaluations
   g. isLoading = false
```

**The 300ms setTimeout** is intentional. It defers all post-render logic until after LWC has completed its initial DOM rendering cycle, preventing `@track` mutations from colliding with the rendering engine.

---

### 5.4.1 Field Change Handler & Reactive Debounce

`handleFieldChange(event)` is the entry point for every standard input, picklist, multi-select, checkbox, and textarea change. It resolves the new value (checkbox → Boolean, multi-select array → `;`-joined string, `event.detail.value` fallback for combobox), and only proceeds if `sectionData[rowId][fieldApi]` actually changed.

**Split reactive path (typing-latency fix):**

| Field category                                                                                              | Reactive cycle timing                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Text`, `Long Text Area`, `Number`, `Currency`, `Percent` — **and no `soqlDependencies`**                   | Debounced 300 ms. Each keystroke clears and re-arms `_fieldChangeTimers['field-<rowId>-<fieldApi>']`; the timer body runs `calculateFormulas() → applyMatrixRules() → evaluateVisibility()`. Keeps keystroke-to-paint latency low on forms with heavy visibility/formula logic. |
| Everything else (picklist, lookup, checkbox, multi-select) **or** any text field that has SOQL dependencies | Runs `calculateFormulas() → applyMatrixRules() → evaluateVisibility()` synchronously, then `evaluateDynamicQueries()` when the field has `soqlDependencies`.                                                                                                                    |

**Blur-time flush:** Before a non-text field runs its synchronous cycle, `flushAllFieldChangeTimers()` clears every pending `_fieldChangeTimers` entry. This guarantees that if a user types in a text field and then Tabs straight into a picklist, the text field's pending formula/visibility pass is discarded in favor of the immediate full cycle the picklist triggers — the picklist path re-reads `sectionData` (already updated synchronously on every keystroke), so no input is lost, only the redundant deferred pass.

> **Note:** `sectionData` is always written synchronously on every keystroke. Only the _derived_ recomputation (formulas, matrix rules, visibility) is deferred. A submit or step navigation calls `validateCurrentStep()`, which reads the DOM and `sectionData` directly, so a pending debounce never affects save correctness.

---

### 5.5 Subsystem: Visibility Engine

`evaluateVisibility()` — The most complex function in the component. Called after every field change, formula calculation, matrix change, dynamic SOQL result, and lookup selection. For text-like fields the call is debounced 300 ms (see [5.4.1](#541-field-change-handler--reactive-debounce)); all other changes invoke it synchronously.

#### Stabilization Loop

The function runs in a `do...while (!isStabilized)` loop with a maximum of 10 iterations (safety circuit breaker). Each pass checks if any state changed; if so, `isStabilized = false` and the loop runs again. This handles cascading visibility where Field A's visibility depends on Field B which depends on Field C.

#### Per-Section Logic

For each section:

1. Evaluates `visibilityLogic` JSON via `checkLogic()` against global scope (`isGlobal=true`).
2. Special rule: a section containing File Upload fields is hidden until `savedRecordId` is set.
3. Determines `isWizardVisible` based on `currentStepIndex` if in Wizard mode.
4. If `isSubmitHidden = true` (post-save mode): hides all sections except those with file uploads.

#### Per-Field Logic (within each row)

For each field:

1. **Value sync:** If not a Lookup or FileUpload, syncs `f.currentValue` from `sectionData` (source of truth). Multi-select values stored as `;`-joined strings are split back to arrays.
2. **Field visibility:** Evaluates `f.visibilityLogic` against the row-local `sectionData[rowId]` context (`isGlobal=false`).
3. **Hide rule:** If field becomes invisible and its `sectionData` value is non-empty → **wipes the value** to `''`/`false`/`[]`. Stores `isStabilized = false` to re-run the loop.
4. **Restore rule (new field becomes visible):** If `f._restorableValue` is non-empty and `sectionData` is currently empty → **restores** the value from `_restorableValue` and `_restorableDisplayValue`. Pushes to `restoredFieldsForSoql` for SOQL re-evaluation.
5. **Dynamic required:** Evaluates `f.requiredLogic` JSON. `f.required` is set to `false` if the field is hidden (invisible required fields don't block submission).

#### Post-Pass Cascade

After each full pass, if `dataChangedThisPass` is true:

1. Calls `calculateFormulas()` — a wipe/restore may affect formula inputs.
2. Calls `applyMatrixRules()` — returns `true` if matrix data was wiped.
3. If matrix data was wiped, sets `isStabilized = false` to loop again.

#### `checkLogic(logic, dataContext, isGlobal)` — Logic Evaluator

Recursively evaluates a JSON logic tree:

```json
// Single condition
{ "when": "FieldApiName", "operator": "equals", "value": "SomeValue" }

// Compound condition
{ "operator": "AND", "conditions": [ {...}, {...} ] }
{ "operator": "OR",  "conditions": [ {...}, {...} ] }
```

Supported operators: `equals`, `not equals`, `includes` (string contains), `excludes` (string does not contain).

**Scope resolution:** If `dataContext` (row-local data) contains the field → uses that value. Otherwise falls through to `getGlobalValue()` which searches all `sectionData` rows.

**Matrix access:** `getGlobalValue()` handles keys prefixed with `MATRIX__` by looking them up in `this.matrixState`.

---

### 5.6 Subsystem: Formula Engine

`calculateFormulas(isInitialLoad = false)`

Iterates all fields across all rows, evaluating `formulaLogic` expressions.

**Expression format:** `{Field1} + {Field2}` or `({Field1} * 100) / {Field2}`

**Algorithm:**

1. Replaces `{FieldApiName}` tokens with their current values from `sectionData[rowId]` or `getGlobalValue()`.
2. Numeric-looking values are injected as numbers; others as quoted strings.
3. Blank/null/undefined values become `0` (prevents `NaN` in arithmetic).
4. Evaluates via `new Function('return ' + parsedExpression)()`.
5. If the result differs from the current stored value, updates `sectionData[rowId][f.apiName]`.
6. Collects `{ apiName, rowId }` for any field whose formula result changed.
7. After the loop, calls `evaluateDynamicQueries` for any changed formula fields — enabling formulas to trigger SOQL queries.

**Read-only enforcement:** `isReadOnlyEffective = Boolean(f.readOnly || (f.formulaLogic && f.formulaLogic.length > 0))` — any field with a formula is automatically read-only.

**Security note:** `new Function()` executes arbitrary JavaScript. This is an XSS risk if CMDT records are accessible to untrusted users. In practice, CMDT is admin-managed only, making this acceptable in a Salesforce context.

---

### 5.7 Subsystem: Dynamic SOQL Engine

`evaluateDynamicQueries(changedFieldApi, rowId, isInitialLoad = false)`

Scans all fields across all rows for those whose `soqlDependencies` array includes `changedFieldApi`.

**SOQL dependency extraction** happens during `initializeFields()`:

```javascript
const regex = /\{([^}]+)\}/g;
// Parses "{ContactId}" → ["ContactId"] from the Dynamic_SOQL__c template
```

**Edit mode guard:** If `isInitialLoad && isEditMode && !f.fetchOnEdit` → skip (preserves the value already loaded from the server).

Calls `executeSingleDynamicQuery(f, rowId)`.

---

`executeSingleDynamicQuery(field, rowId)`

1. Collects bind param values from `sectionData[rowId]` or `getGlobalValue()`.
2. **All-or-nothing guard:** If any dependency is empty/null → clears the field value and returns. Prevents partial queries.
3. Converts `{FieldApiName}` tokens in the SOQL template to `:FieldApiName` (Apex bind variable syntax).
4. **Stale query guard:** Serializes bind params as JSON, stores to `_activeSoqlQueries[queryKey]`. On resolution, verifies the stored key still matches before applying the result (prevents out-of-order responses).
5. Calls `executeDynamicQuery()` apex method.
6. On result: uses recursive `extractVal()` to find the first non-`attributes`, non-`Id` value from the result SObject.
7. If the extracted value is a Salesforce ID and the field is a Lookup → calls `getRecordDetails()` to resolve the display label.
8. Stores result in `sectionData`, updates `f.currentValue` via `updateFieldState()`.
9. Triggers cascade: `filterDependencies → calculateFormulas → applyMatrixRules → evaluateVisibility → evaluateDynamicQueries` (chained reactive update).

---

### 5.8 Subsystem: Matrix Engine

#### `initializeMatrix(config, sectionDevName, fullDataBundle, matrixObjectName)`

Builds the matrix data structure from a `Section_Config_JSON__c` payload:

```json
{
  "columns": [
    { "key": "col1", "label": "Monday" },
    { "key": "col2", "label": "Tuesday" }
  ],
  "rows": [
    {
      "key": "row1",
      "label": "Morning",
      "cells": {
        "col1": { "type": "checkbox", "readonly": true },
        "col2": {
          "readonlyLogic": {
            "when": "SomeField",
            "operator": "equals",
            "value": "X"
          }
        }
      }
    }
  ]
}
```

For each cell at `(rowKey, colKey)`:

1. Looks up existing data from `fullDataBundle.children[matrixObjectName]` matching `Section_Key__c + Row_Key__c + Column_Key__c`.
2. Sets `value`, `recordId` (for upsert), `isReadOnly`, `staticReadOnly`, `readonlyLogic`, `isCheckbox`, `displayValue`.
3. Initializes `matrixState[MATRIX__<dev>__<row>__<col>]`.

#### `handleMatrixChange(event)`

Captures checkbox or input changes in the matrix DOM. Updates:

- The cell object in `sections[].matrixRows[].cells[]`.
- `matrixState[MATRIX__key]`.

Then triggers the unified execution: `calculateFormulas → applyMatrixRules → evaluateVisibility`.

#### `applyMatrixRules()`

Iterates all matrix cells and evaluates `readonlyLogic` if present. If a cell becomes read-only and has a non-empty value → **wipes the value** and updates `matrixState`. Returns `true` if any data was wiped (signals the visibility loop to re-run).

---

### 5.9 Subsystem: Reactive Context / Dependent Lookup Engine

`handleReactiveContextChange(controllingFieldApi, newRecordId)`

Called when a Lookup field changes (selection, clear, or SOQL-driven update).

**Purpose:** When a "parent" Lookup changes, auto-populate or clear sibling fields that are configured as `controllingLookup = <parentLookupFieldApi>`.

**Algorithm:**

1. Finds all fields with `f.controllingLookup === controllingFieldApi`.
2. If `newRecordId` is null/empty → clears all dependent field values and returns.
3. If dependent fields have `sourceFieldApiName` → calls `getSourceRecordData()` to fetch those field values from the newly selected record.
4. On result: sets each dependent field's `sectionData` value and `currentValue` display.
5. Triggers cascade: `calculateFormulas → applyMatrixRules → evaluateVisibility → fetchMissingLookupDetails`.

---

### 5.10 Subsystem: Lookup Search & Selection

#### `handleLookupSearch(event)`

1. Clears any custom validity on the input.
2. If the field already holds a committed ID → clears `sectionData[rowId][fieldApi]`, calls `handleReactiveContextChange(fieldApi, null)`, and re-fires `evaluateDynamicQueries` / `evaluateVisibility`.
3. Clears (and deletes) any pending `_lookupSearchTimers` entry for this `rowId-fieldApi`.
4. If `searchTerm` is empty → resets the field display, closes the dropdown, and returns.
5. If `searchTerm.length >= 3` → records the term in `_activeSearchTerms[key]` and arms `_lookupSearchTimers[key]` with a **300 ms** debounce. When it fires, `searchRecords()` is called via Apex.
6. On result: discards the response unless `_activeLookup === key` (still the focused lookup) **and** `_activeSearchTerms[key] === searchTerm` (latest term). Otherwise updates `lookupOptions` / `showLookupOptions` / `lookupClass` via `updateFieldState()`.

> The 3-char threshold + 300 ms debounce together suppress roughly half of the Apex/search-index round-trips a fast typist would otherwise generate, and pair with the SOSL rewrite of `searchRecords()` to fix the >20 s production lookup latency on high-volume objects.

#### `handleLookupSelect(event)` (onmousedown, not onclick)

**Critical Detail:** Uses `onmousedown` instead of `onclick` to prevent the `onblur` event from firing first (and closing the dropdown before the selection registers). `event.preventDefault()` stops the default browser behavior.

1. Stores record ID in `sectionData[rowId][fieldApi]`.
2. Updates `currentValue` (display label), `currentDetails`, closes dropdown.
3. **Clears stale-response guards immediately** — sets `_activeLookup = null`, deletes `_activeSearchTerms[key]`, and clears/deletes `_lookupSearchTimers[key]`. This is the race-condition fix: without it, a `searchRecords` call queued just before the click would resolve afterward, pass the guard check, and overwrite the chosen value with stale results.
4. Calls `handleReactiveContextChange(fieldApi, recordId)`.
5. Calls `evaluateDynamicQueries(fieldApi, rowId)`.
6. Calls `evaluateVisibility()`.

#### `handleBlur(event)`

Fires 300ms after focus leaves a lookup input (via `setTimeout`). If no valid ID is stored, clears the display text to prevent orphaned label text with no backing ID.

---

### 5.11 Subsystem: Picklist Dependency Filter

`filterDependencies(rowId, ctrlApi, ctrlVal)`

Called whenever a picklist field changes. Scans all fields in the same row for those with `controllerField === ctrlApi`.

For each dependent field:

1. Looks up `f.dependencyMap[ctrlVal]` for the new filtered options.
2. Prepends `--None--` for single-select picklists.
3. Sets `f.filteredOptions`.
4. **Clears the dependent field's current value** if it had one (a previously selected value is now likely invalid under the new controller selection).

---

### 5.12 Validation Engine

`validateCurrentStep()`

Runs on every step navigation (`handleNext`) and final submit (`handleSubmit`).

**Pass 1 — DOM Validation:**

1. Queries all `lightning-input`, `lightning-combobox`, `lightning-textarea`, `lightning-dual-listbox`.
2. Skips fields in hidden sections or hidden fields.
3. **Lookup custom validation:** If `input.type === 'search'` has a text value but `sectionData[rowId][apiName]` is empty → sets a custom validity message: `'Please select a valid record from the list.'`
4. Calls `input.checkValidity()` for native HTML5 validation.
5. Collects `secId` of all invalid fields.

**Pass 2 — Matrix validation (for visible required sections):**
Checks that at least one matrix cell has a non-empty, non-false value.

**On failure:**

- Expands collapsed sections containing invalid fields.
- Calls `input.reportValidity()` after 100ms (deferred to allow section expand to render).
- Shows toast with error message.

**Returns:** `Boolean` — used by callers to abort submission.

---

### 5.13 Submission & Save Pipeline

`handleSubmit(event)`

The most complex orchestration method. Runs in two phases.

#### Phase 1: Payload Construction

```
For each visible primary section (no parentSectionDevName):

  [MATRIX section]
    → Collect cells with values → add to payload[matrixObjectName][]
    → Collect cells that were cleared (have recordId but now empty) → add to dynamicRecordsToDelete

  [ALLOW_MULTIPLE section]
    → For each row: build rowData from sectionData
    → Skip rows with only prepopulated/file values and no real user data
    → Add to payload[objectApiName][]

  [STANDARD section]
    → For each field: if saveToDb and isVisible and not isFileUpload → add to payload[targetObj]
    → If field.targetObject !== _formTargetObject → add to relationshipMap
    → Lookup existing child record ID from _serverData for update path
```

**RecordType injection:** If `recordTypeId` is set, injects `RecordTypeId` into `payload[parentObject]`.

**Empty payload pruning:** After construction, deletes any non-parent keys where no real data exists (all values blank/false/empty). This prevents saving empty child records.

#### Phase 2: Dependent Section Saves (Matrix with parentSectionDevName)

After the primary `saveMultiObject` resolves:

1. Groups dependent sections by `parentSectionDevName`.
2. For each parent section: resolves the newly created child record's ID from `result.childIds`.
3. Calls a second `saveMultiObject` for the dependent matrix data, injecting the resolved parent ID.
4. Awaits all Phase 2 saves via `Promise.all()`.

#### Post-Save Behavior

- **Edit mode or Quick Finish:** Shows success toast, fires `close` event with `recordId`.
- **Create mode with uploads:** Sets `isSubmitHidden = true`, calls `enterUploadMode()` → hides non-upload sections, shows upload-only sections, shows a "Record saved! Please upload files" toast.

#### Error Handling in Submission

If `saveMultiObject` fails and `_isSaveCommitted = true` (parent was inserted but a child failed):

- Calls `rollbackTransaction()` to delete the orphaned parent and any inserted children.
- Shows a "Submission failed. Record rolled back." error toast.

---

### 5.14 File Upload Handling

Two distinct paths depending on `isLightningOut`:

#### Standard (`lightning-file-upload`)

Used within normal Lightning experience. The `lightning-file-upload` component handles base64 encoding and Apex calls internally. The `handleUploadFinished` event receives `event.detail.files` with `documentId` and `name`.

#### Lightning Out / Visualforce (`handleCustomFileUpload`)

Used when `isLightningOut = true`. Uses the browser's `FileReader` API:

1. Reads each file as a base64 Data URL.
2. Strips the `data:...;base64,` prefix.
3. Calls `uploadFile()` Apex method with `parentId = savedRecordId`.
4. 4MB file size limit enforced client-side.
5. `Promise.all()` handles multiple file uploads.

#### File Tracking

Both paths update `f.uploadedFiles[]` on the field object. Each entry: `{ name, documentId }`. Rendered as `lightning-pill` elements. `handleFileRemove` calls `deleteRecord()` Apex and removes the pill.

---

### 5.15 Wizard Navigation

Controlled by `currentStepIndex` and `displayMode === 'Wizard'`.

#### `findNextVisibleSectionIndex(currentIndex)`

Scans forward from `currentIndex + 1`. A section is skippable if:

- Its `visibilityLogic` evaluates to `false`.
- It contains file upload fields AND `savedRecordId` is not yet set.

#### `findPrevVisibleSectionIndex(currentIndex)`

Same logic scanning backward.

#### Wizard Rendering

`evaluateVisibility()` sets `isWizardVisible = (i === currentStepIndex)` for each section. The final `finalSecVisible = isLogicallyVisible && isWizardVisible`.

#### Navigation Guards

`handleNext()` calls `validateCurrentStep()` before advancing. `handlePrevious()` has no validation guard.

---

### 5.16 Rollback Mechanism

The form implements a client-driven rollback pattern (Salesforce Apex does not support deferred savepoints across HTTP calls).

**Tracking:**

- `_isSaveCommitted` → set to `true` when `saveMultiObject` resolves.
- `_rollbackChildIds` → accumulates all child IDs from `result.allInsertedChildIds` across both Phase 1 and Phase 2 saves.

**Trigger conditions:**

1. `handleSubmit` catch block → if `_isSaveCommitted = true`, calls `rollbackTransaction()` automatically.
2. `handleCancel` → if `!isEditMode && savedRecordId && _isSaveCommitted` → asks Apex to delete the created records.

**Rollback method:** `rollbackTransaction({ recordId, childIds, saveWithoutSharing })` deletes children first, then parent, with `allOrNone = false` to tolerate already-deleted records.

---

## 6. HTML Template Analysis

### Conditional Rendering Strategy

The template uses `if:true` / `if:false` conditionals (LWC Classic API). All conditional flags are computed properties on the section/field objects or component-level getters.

### Template Structure

```
lightning-card
  [isLoading] → lightning-spinner
  [isFormActive]
    [formInstructions] → lightning-formatted-rich-text
    for:each sections
      section div (slds-section, slds-is-open)
        section header (toggle button + add-row button)
        section content
          [isMatrix] → scrollable table
            thead: section.matrixColumns
            tbody: section.matrixRows
              cells: checkbox OR standard input
          [isStandardSection]
            for:each rows
              row div (with optional remove button)
                lightning-layout
                  for:each fields (by type):
                    isHeader    → h3
                    isDisplayText → lightning-formatted-rich-text
                    isCheckbox  → lightning-input[type=checkbox]
                    isStandard  → lightning-input[type=uiType]
                    isPicklist  → lightning-combobox
                    isMultiSelect → lightning-dual-listbox
                    isLookup    → custom SLDS combobox pattern
                    isTextArea  → lightning-textarea
                    isFileUpload → [isLightningOut] lightning-input[type=file]
                                   [else]          lightning-file-upload
    button bar
      Cancel
      [showPrevButton] Previous
      [showNextButton] Next
      [isSubmitHidden] Finish
      [showStepButtons && hasRequiredUpload] Save & Continue to Upload
      [showStepButtons && hasOptionalUpload] Save & Finish + Save & Attach Files
      [showSubmitButton] Submit / Save Changes
```

### Custom Lookup DOM Pattern

The lookup field is rendered as a custom SLDS combobox (not `lightning-lookup`). This is intentional — it provides full control over search behavior and avoids Lightning Data Service dependency issues. The pattern:

1. `lightning-input[type=search]` with `onchange`, `onblur`, `onfocus`.
2. SLDS dropdown `div` with `slds-listbox` containing `li` items.
3. Each `li` uses `onmousedown` (not `onclick`) to handle selection before blur fires.

---

## 7. Data Flow Diagrams

### Create Mode Flow

```
User opens Quick Action
  → recordId = Context record ID (e.g., Account 001...)
  → formMode = 'create'
        ↓
@wire getFormMetadata
        ↓
handleCreateMode()
  → Scans fields for prepopulate=true + keyPrefix matches recordId prefix
  → Calls getRecordDetails(recordId)  [parallel]
  → Calls getSourceRecordData(recordId, sourceFields)  [parallel]
        ↓
buildForm(sections, parentObj, null, recordDetails, null)
  → initializeFields: set contextMatch field to recordId, displayValue = label
  → sectionData[uuid][accountLookupField] = recordId
        ↓
setTimeout(300ms)
  → calculateFormulas(true)
  → applyMatrixRules()
  → evaluateVisibility()
  → fetchDependentData()
  → fetchMissingLookupDetails()
  → evaluateDynamicQueries (for all populated fields)
  → isLoading = false
        ↓
User fills form → handleFieldChange()
  → sectionData updated (always synchronous)
  → filterDependencies → calculateFormulas → applyMatrixRules → evaluateVisibility
      (synchronous for picklist/lookup/checkbox/multi-select; debounced 300 ms for
       Text/Number/Long Text Area/Currency/Percent fields without SOQL dependencies)
  → evaluateDynamicQueries (if field has SOQL dependents)
        ↓
handleSubmit()
  → validateCurrentStep() — abort if invalid
  → Build payload from sectionData
  → saveMultiObject(parentObj, payload, relMap, toDelete, saveWithoutSharing)
        ↓
[no uploads] → closeFormAndNavigate()
[has uploads] → isSubmitHidden=true → enterUploadMode() → user uploads → handleFinish()
```

### Edit Mode Flow

```
User opens Quick Action with existing recordId
  → formMode = 'edit'
        ↓
@wire getFormMetadata
        ↓
initializeComponent()
  → shouldLoadData = true
  → buildQueryConfig(sections)  [derives parent + child field sets]
  → getExistingRecordData(recordId, parentObj, queryConfig)
        ↓
buildForm(sections, parentObj, existingData, null, null)
  → initializeFields: populate from existingData.parent
  → For child sections: iterate existingData.children[childObj]
  → savedRecordId = existingData.parent.Id
        ↓
fetchMissingLookupDetails()
  → Resolves Lookup display labels from IDs stored in sectionData
        ↓
User edits → handleFieldChange() → [same reactive cascade as create]
        ↓
handleSubmit()
  → Payload includes existing record IDs → saveMultiObject performs UPDATE
  → closeFormAndNavigate() immediately (no upload phase in edit mode)
```

---

## 8. Unified Execution Order

After **any** state change event (field change, matrix change, lookup select, SOQL result, row add/remove), the framework always runs in this exact order:

```
1. Update sectionData (raw value store)
2. filterDependencies (sync picklist options)
3. calculateFormulas (sync formula field values)
4. applyMatrixRules (sync matrix cell readonly + wipe locked cells)
5. evaluateVisibility (sync all visibility, required, cssClass; stabilization loop)
   └─ [if data changed in loop] → calculateFormulas + applyMatrixRules again
6. evaluateDynamicQueries (async: fire SOQL calls for changed fields)
```

This order is documented with the comment `// *** EXECUTION ORDER UNIFIED ***` at each call site. The ordering is critical:

- Formulas must run before visibility (formula results may affect visibility conditions).
- Matrix rules must run before visibility (matrix wipes affect matrixState used in visibility).
- Visibility must stabilize before SOQL (avoids firing queries for fields that will be hidden).

**Debounce exception:** When the trigger is a keystroke in a `Text` / `Long Text Area` / `Number` / `Currency` / `Percent` field with no SOQL dependencies, step 1 still runs synchronously but steps 3–5 are deferred behind a 300 ms `_fieldChangeTimers` timer. A subsequent change on any non-text field (or submit / step navigation) flushes those pending timers first (`flushAllFieldChangeTimers()`), so the unified order is preserved — it is only delayed for pure typing. See [5.4.1](#541-field-change-handler--reactive-debounce).

---

## 9. Security Model

### Sharing Rules

| Context                               | Sharing Mode                        | Scope                                                            |
| ------------------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| `DynamicFormController` (outer class) | `with sharing`                      | All SOQL queries and non-override DML.                           |
| `SystemModeDML` (inner class)         | `without sharing`                   | Only when `saveWithoutSharing = true`. Explicit admin opt-in.    |
| `getFormMetadata`                     | `with sharing`                      | CMDT queries only — CMDT is not subject to sharing rules anyway. |
| `saveMultiObject`                     | `with sharing` OR `without sharing` | Controlled by `saveWithoutSharing` parameter.                    |

### FLS Enforcement

`createSObject()` checks `f.getDescribe().isCreateable() || f.getDescribe().isUpdateable()` before setting any field value. Fields the running user cannot create/update are silently skipped.

### SOQL / SOSL Injection Prevention

- `searchRecords()` builds a SOSL string: the `FIND` term is passed through `escapeSoslReservedChars()` (backslash-escapes all SOSL metacharacters), the `LIKE` filter value through `String.escapeSingleQuotes()`, and object / field identifiers through `String.escapeSingleQuotes()`.
- `executeDynamicQuery()` uses `Database.queryWithBinds()` — bind parameters are never interpolated into the query string.
- `getExistingRecordData()` and `getSourceRecordData()` build queries with escaped identifiers and `:recordId` binds.

### Input Sanitization

- ID values are stripped of non-alphanumeric characters: `.replaceAll('[^a-zA-Z0-9]', '')`.
- IDs are validated to be at least 15 characters before `(Id)` cast.

### CMDT Security Consideration

`Formula_Logic__c` content is evaluated via `new Function()` in the browser. This constitutes arbitrary JavaScript execution. While CMDT records require admin access to create/modify, organizations should ensure CMDT edit permissions are tightly controlled.

---

## 10. Performance & Governor Limits

### Apex — SOQL Query Budget

| Method                  | SOQL Queries                        | Notes                                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getFormMetadata`       | 3 SOQL (config + sections + fields) | `cacheable=true` — cached after first call. Also 1 `ConnectApi.RecordUi.getPicklistValuesByRecordType()` call **per root-object picklist field** when `recordTypeId` is supplied (not SOQL, but a callout-class limit). |
| `getExistingRecordData` | 1 (parent) + N (children)           | N = number of distinct child objects in config.                                                                                                                                                                         |
| `saveMultiObject`       | 1 per child object type for delete  | Only when `recordsToDelete` is non-empty.                                                                                                                                                                               |
| `searchRecords`         | 1 **SOSL**                          | `cacheable=true` per unique `searchTerm`; called imperatively behind a 300 ms debounce. SOSL bucket: 20 queries / 2,000 rows per transaction.                                                                           |
| `getRecordDetails`      | 1                                   | `cacheable=true`.                                                                                                                                                                                                       |

### LWC — Reactive Update Cost

`evaluateVisibility()` iterates every section × every row × every field on every state change. For forms with 10 sections, 3 rows, 10 fields each, this is 300 iterations per change event. The stabilization loop can multiply this up to 10×. This is acceptable for typical form sizes (< 50 visible fields) but should be monitored for very large configurations.

### Caching Strategy

- `getFormMetadata` is `cacheable=true` — wired and cached by LDS for the session.
- `_lastLoadKey` prevents `initializeComponent()` from re-running when the same combination of inputs is encountered (e.g., property setters firing multiple times).
- `_activeSoqlQueries` and `_activeSearchTerms` discard stale/out-of-order Apex responses.
- `_lookupSearchTimers` (lookup search) and `_fieldChangeTimers` (text-field reactive cycle) collapse bursts of keystrokes into a single deferred call — 300 ms each.

### Batch DML

`saveMultiObject` collects all child records of the same type into a single list and calls `upsert records` (bulk DML) rather than looping individual upserts. This keeps DML statements within governor limits for multi-row child sections.

---

## 11. Error Handling Strategy

| Layer                        | Strategy                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Apex — controlled errors** | `AuraHandledException` with `getCleanErrorMessage()` normalization. Returns user-friendly message.          |
| **Apex — DML errors**        | `DmlException.getDmlMessage(0)` extracts first row's error. Savepoint rollback in `saveMultiObject`.        |
| **Apex — query errors**      | `executeDynamicQuery` swallows all exceptions and returns `null`.                                           |
| **Apex — getRecordDetails**  | Catches exception and returns raw ID as label — prevents UI crash from stale IDs.                           |
| **LWC — wire error**         | `wiredMetadata` catch: shows error toast, sets `isLoading = false`.                                         |
| **LWC — create mode errors** | `handleCreateMode` catch: falls back to `buildForm(null, null, null)` — renders form without prepopulation. |
| **LWC — submit error**       | Auto-rollback if `_isSaveCommitted`. Cascading error toasts.                                                |
| **LWC — SOQL errors**        | `executeSingleDynamicQuery` catch: logs to console, does not surface to user.                               |
| **LWC — formula errors**     | `try/catch` inside `calculateFormulas` — bad formulas silently fail.                                        |
| **LWC — visibility errors**  | `try/catch` inside `evaluateVisibility` loop — bad logic JSON silently evaluates to `true`.                 |

---

## 12. Known Limitations & Edge Cases

| Limitation                                                          | Detail                                                                                                                                                                                                                      | Workaround                                                                                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Formula engine uses `eval` equivalent                               | `new Function()` executes arbitrary JS. Only CMDT admin controls.                                                                                                                                                           | Restrict CMDT modify permissions to Admins only.                                                                                              |
| Matrix data is limited to a single junction object type per section | Two matrix sections cannot target the same `objectApiName` and `parentField` combination without collisions.                                                                                                                | Use separate junction objects.                                                                                                                |
| `getExistingRecordData` LIMIT 100 on children                       | Edit mode will only load the first 100 child records per child object type.                                                                                                                                                 | Accepted limit for intake form context. Not designed for bulk edit.                                                                           |
| `lightning-file-upload` hidden until `savedRecordId`                | File fields cannot be shown on a create form before first save.                                                                                                                                                             | Designed behavior — requires two-phase save.                                                                                                  |
| No cross-row field references in formula/visibility                 | `{FieldApiName}` in `formulaLogic` or `visibilityLogic` resolves via `getGlobalValue()`, which returns the first matching value across all rows. In multi-row sections, this picks up whichever row's value is found first. | Use child-section formulas only for simple intra-row calculations.                                                                            |
| `Wizard` mode section filtering excludes upload sections until save | Upload sections are invisible in wizard nav until `savedRecordId` is populated.                                                                                                                                             | By design — upload only after parent record created.                                                                                          |
| `Case` object Name field workaround is hardcoded                    | `getRecordDetails` has a special case for the `Case` object.                                                                                                                                                                | Any other object lacking `Name` would need a similar workaround in `Lookup_Search_Field__c`.                                                  |
| Lookup search relies on the SOSL index                              | `searchRecords()` uses SOSL for speed; a just-created record is not returned until the async search indexer processes it (usually a few seconds).                                                                           | Acceptable for intake forms. If a freshly created record must be selectable immediately, paste its ID or reopen the form after a moment.      |
| Text-field reactivity is deferred 300 ms                            | Formula / visibility / matrix recomputation lags a keystroke by up to 300 ms on `Text`/`Number`/`Long Text Area`/`Currency`/`Percent` fields (unless they carry SOQL dependencies).                                         | By design — `sectionData` and validation are always current; only derived UI state is delayed. Non-text changes and submit flush immediately. |
| `connectedCallback` not used                                        | Initialization is fully driven by `@wire` + property setters. No `connectedCallback` hook needed.                                                                                                                           | Normal for wire-driven components.                                                                                                            |
| `new Function()` formula eval fails silently                        | Bad formula expressions (syntax errors, missing fields) are caught and the field retains its previous value.                                                                                                                | No visible error to the admin during testing. Use browser console for debugging.                                                              |

---

## 13. Wrapper Component Patterns

Wrapper components are thin shells that pass context to `c-dynamic-record-form`. They handle framework-specific concerns (closing Quick Actions, navigating after save).

### Create Wrapper Pattern (`caseCreateWrapper`)

```javascript
// Receives 'close' event from dynamicRecordForm
handleClose(event) {
    const savedId = event.detail?.recordId;
    // 1. Bubble close event for Visualforce/LightningOut container
    this.dispatchEvent(new CustomEvent('close', {
        detail: { recordId: savedId },
        bubbles: true,
        composed: true
    }));
    // 2. Navigate to new record (Quick Action context)
    if (savedId) { this[NavigationMixin.Navigate]({ ... }); }
    // 3. Close the Quick Action modal
    this.dispatchEvent(new CloseActionScreenEvent());
}
```

**Why `bubbles: true, composed: true`?** Required to cross Shadow DOM boundaries when the component is hosted inside a Visualforce/Aura container. Without these, the event stops at the LWC shadow root.

### Edit Wrapper Pattern (`caseEditWrapper`, `taskEditWrapper`)

```javascript
// Wire getRecord to resolve RecordTypeId before rendering the form
@wire(getRecord, { recordId: '$recordId', layoutTypes: ['Compact'] })
caseRecord;

get activeRecordTypeId() {
    return this.caseRecord?.data?.recordTypeId || '';
}

get isReady() {
    return this.caseRecord && (this.caseRecord.data || this.caseRecord.error);
}
```

**Why `isReady`?** Prevents `dynamicRecordForm` from initializing with an empty `recordTypeId`, which would cause the wrong picklist values to be fetched. The `isReady` guard holds rendering until LDS returns the record context.

**Note on `taskEditWrapper`:** Uses `this.dispatchEvent(new CustomEvent('closeaction'))` instead of `CloseActionScreenEvent`. This decouples from the Quick Action framework for broader embedding compatibility.

---

_End of Technical Design Document_

_For questions or amendments, contact the Salesforce Architecture team._
