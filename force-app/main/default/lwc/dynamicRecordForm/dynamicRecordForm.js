import { LightningElement, api, wire, track } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import getFormMetadata from '@salesforce/apex/DynamicFormController.getFormMetadata';
import saveMultiObject from '@salesforce/apex/DynamicFormController.saveMultiObject';
import deleteRecord from '@salesforce/apex/DynamicFormController.deleteRecord';
import searchRecords from '@salesforce/apex/DynamicFormController.searchRecords';
import getRecordDetails from '@salesforce/apex/DynamicFormController.getRecordDetails';
import getExistingRecordData from '@salesforce/apex/DynamicFormController.getExistingRecordData';
import getSourceRecordData from '@salesforce/apex/DynamicFormController.getSourceRecordData';
import uploadFile from '@salesforce/apex/DynamicFormController.uploadFile';
import executeDynamicQuery from '@salesforce/apex/DynamicFormController.executeDynamicQuery';
import rollbackTransaction from '@salesforce/apex/DynamicFormController.rollbackTransaction';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { notifyRecordUpdateAvailable } from 'lightning/uiRecordApi';

function generateUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export default class DynamicForm extends NavigationMixin(LightningElement) {
    @api formDeveloperName;
    @api formMode = 'auto';
    @api isLightningOut = false;

    _recordTypeId = '';
    @api
    get recordTypeId() { return this._recordTypeId; }
    set recordTypeId(value) {
        this._recordTypeId = (value === undefined || value === null) ? '' : value;
    }

    _recordId;
    @api
    get recordId() { return this._recordId; }
    set recordId(value) {
        this._recordId = value;
        this.attemptInit();
    }

    _objectApiName;
    @api
    get objectApiName() { return this._objectApiName; }
    set objectApiName(value) {
        this._objectApiName = value;
        this.attemptInit();
    }

    @track sections = [];
    @track sectionData = {};
    @track matrixState = {};

    @track isLoading = true;
    _formTargetObject;
    @track formTitle = 'Dynamic Form';
    @track formIcon = 'standard:record';
    @track formInstructions = '';
    @track isFormActive = true;
    @track savedRecordId;
    @track isSubmitHidden = false;
    @track hasRequiredUpload = false;
    @track hasOptionalUpload = false;
    @track hasAnyUpload = false;
    @track isEditMode = false;
    @track saveWithoutSharing = false;
    @track _recordsToDelete = [];
    @track _cachedSourceData = {};
    _serverData = {};
    _cachedMetadata;
    _lastLoadKey = '';

    _activeLookup = null;
    _activeSearchTerms = {};
    _activeSoqlQueries = {};
    _isSaveCommitted = false;
    _rollbackChildIds = [];

    @track labels = {
        cancel: 'Cancel', next: 'Next', previous: 'Previous', finish: 'Finish',
        submit: 'Submit Form', save: 'Save Changes',
        saveAndUpload: 'Save & Continue to Upload',
        saveAndFinish: 'Save & Finish',
        saveAndAttach: 'Save & Attach Files',
        msgRecordSaved: 'Record saved successfully!',
        msgRecordSavedUpload: 'Record saved! Please upload your files.',
        msgUploadSuccess: 'file(s) uploaded successfully.'
    };

    @track currentStepIndex = 0;
    @track displayMode = 'Single Page';

    get isWizardMode() { return this.displayMode === 'Wizard'; }
    get isFirstStep() { if (!this.isWizardMode) return true; return this.currentStepIndex === 0; }
    get isLastStep() {
        if (!this.isWizardMode) return true;
        if (!this.sections || this.sections.length === 0) return false;
        const nextIndex = this.findNextVisibleSectionIndex(this.currentStepIndex);
        return (nextIndex === -1);
    }
    get showStepButtons() {
        if (this.isEditMode) return false;
        if (this.isWizardMode && !this.isLastStep) return false;
        return !this.savedRecordId && this.hasAnyUpload;
    }
    get showSubmitButton() {
        if (!this.isEditMode && this.savedRecordId) return true;
        if (this.isWizardMode && !this.isLastStep) return false;
        if (this.isEditMode) return true;
        return !this.hasAnyUpload;
    }
    get showNextButton() { return this.isWizardMode && !this.isLastStep && (this.isEditMode || !this.savedRecordId); }
    get showPrevButton() { return this.isWizardMode && !this.isFirstStep && (this.isEditMode || !this.savedRecordId); }
    get submitButtonLabel() { return this.savedRecordId ? this.labels.save : this.labels.submit; }

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
        this.dispatchEvent(new CustomEvent('notification', {
            detail: { title, message, variant },
            bubbles: true,
            composed: true
        }));
    }

    mapType(t) {
        const m = { 'Number': 'number', 'Checkbox': 'checkbox', 'Date': 'date', 'DateTime': 'datetime' };
        return m[t] || 'text';
    }

    findField(apiName, rowId) {
        for (let sec of this.sections) {
            if (!sec.rows) continue;
            let row = sec.rows.find(r => r.id === rowId);
            if (row) return row.fields.find(f => f.apiName === apiName);
        }
        return null;
    }

    @wire(getFormMetadata, { formDeveloperName: '$formDeveloperName', recordTypeId: '$_recordTypeId' })
    wiredMetadata({ error, data }) {
        if (data) {
            this._cachedMetadata = data;
            this.attemptInit();
        } else if (error) {
            this.isLoading = false;
            let msg = error.body ? error.body.message : 'Metadata Load Failed';
            this.showToast('Error', msg, 'error');
        }
    }

    attemptInit() {
        if (this._cachedMetadata) {
            this.initializeComponent();
        }
    }

    initializeComponent() {
        if (!this._cachedMetadata) return;

        const mode = this.formMode ? this.formMode.toLowerCase() : 'auto';
        if (mode === 'edit' && !this.recordId) {
            return;
        }

        const currentKey = `${this.recordId}-${this.objectApiName}-${this.formMode}-${this.recordTypeId}`;
        if (this._lastLoadKey === currentKey) return;
        this._lastLoadKey = currentKey;

        const data = this._cachedMetadata;
        this._formTargetObject = data.objectApiName;
        this.formTitle = data.formTitle || 'Dynamic Form';
        this.formIcon = data.formIcon || 'standard:record';
        this.displayMode = data.displayMode || 'Single Page';
        this.formInstructions = data.formInstructions;
        this.saveWithoutSharing = data.saveWithoutSharing === true;

        if (data.buttonConfig) {
            try {
                const overrides = JSON.parse(data.buttonConfig);
                this.labels = { ...this.labels, ...overrides };
            } catch (e) { }
        }

        let shouldLoadData = false;

        if (mode === 'create') shouldLoadData = false;
        else if (mode === 'edit') shouldLoadData = true;
        else shouldLoadData = (this.recordId && this.recordId.length >= 15);

        if (shouldLoadData) {
            const queryConfig = this.buildQueryConfig(data.sections, this._formTargetObject);
            getExistingRecordData({
                recordId: this.recordId,
                objectApiName: this._formTargetObject,
                queryConfigJson: JSON.stringify(queryConfig)
            })
                .then(existingData => {
                    if (existingData) {
                        this._serverData = existingData;
                        this.buildForm(data.sections, this._formTargetObject, existingData, null, null);
                    } else {
                        this.handleCreateMode(data);
                    }
                })
                .catch(err => {
                    this.handleCreateMode(data);
                });
        } else {
            this.handleCreateMode(data);
        }
    }

    isSectionAllowed(section, mode) {
        const showOn = section.showOn || 'Both';
        if (showOn === 'Both') return true;
        if (mode === 'create' && showOn === 'Create') return true;
        if (mode === 'edit' && showOn === 'Edit') return true;
        return false;
    }

    buildQueryConfig(sections, parentObjName) {
        let parentFields = new Set();
        let childObjectMap = {};

        if (sections) {
            sections.forEach(sec => {
                const isSectionVisible = this.isSectionAllowed(sec, 'edit');
                if (sec.fields) {
                    sec.fields.forEach(f => {
                        const typeLower = f.type ? f.type.toLowerCase() : '';
                        const isFileUpload = (typeLower.includes('file') && typeLower.includes('upload'));
                        const fetchTrigger = (isSectionVisible || f.fetchOnEdit);

                        if (f.apiName && !isFileUpload && !f.excludeFromDb && fetchTrigger) {
                            const targetObj = f.targetObject || parentObjName;
                            if (targetObj === parentObjName) {
                                parentFields.add(JSON.stringify({ api: f.apiName, type: f.type, search: f.lookupSearchField }));
                            } else {
                                if (!childObjectMap[targetObj]) {
                                    childObjectMap[targetObj] = {
                                        objectApiName: targetObj,
                                        parentField: f.parentRelationshipField || sec.relationshipParentField,
                                        fields: new Set()
                                    };
                                }
                                childObjectMap[targetObj].fields.add(JSON.stringify({ api: f.apiName, type: f.type, search: f.lookupSearchField }));
                            }
                        }
                    });
                }
                if (sec.renderAs === 'Matrix') {
                    if (sec.parentSectionDevName) return;
                    const matrixObj = sec.objectApiName || 'Form_Matrix_Entry__c';
                    if (!childObjectMap[matrixObj]) {
                        childObjectMap[matrixObj] = {
                            objectApiName: matrixObj,
                            parentField: sec.relationshipParentField,
                            fields: new Set()
                        };
                    }
                    childObjectMap[matrixObj].fields.add(JSON.stringify({ api: 'Section_Key__c', type: 'Text' }));
                    childObjectMap[matrixObj].fields.add(JSON.stringify({ api: 'Row_Key__c', type: 'Text' }));
                    childObjectMap[matrixObj].fields.add(JSON.stringify({ api: 'Column_Key__c', type: 'Text' }));
                    childObjectMap[matrixObj].fields.add(JSON.stringify({ api: 'Value__c', type: 'Text' }));
                }
            });
        }
        const children = Object.values(childObjectMap).map(child => ({
            objectApiName: child.objectApiName,
            parentField: child.parentField,
            fields: Array.from(child.fields).map(str => JSON.parse(str))
        }));
        const finalParentFields = Array.from(parentFields).map(str => JSON.parse(str));
        return { parentFields: finalParentFields, children: children };
    }

    handleCreateMode(data) {
        let currentPrefix = '';
        if (this.recordId && this.recordId.length >= 3) {
            currentPrefix = this.recordId.substring(0, 3);
        }
        let representativeField = null;
        let sourceFieldsToQuery = new Set();
        let contextMatchField = null;

        if (data.sections && currentPrefix) {
            for (const sec of data.sections) {
                if (!this.isSectionAllowed(sec, 'create')) continue;
                for (const f of sec.fields) {
                    if (f.prepopulate && f.keyPrefix === currentPrefix) {
                        if (!contextMatchField) { contextMatchField = f; }
                        if (!representativeField) {
                            if (!f.excludeFromDb || f.lookupTargetObject) { representativeField = f; }
                        }
                        if (f.sourceFieldApiName) { sourceFieldsToQuery.add(f.sourceFieldApiName); }
                    }
                }
            }
        }

        const promises = [];
        if (contextMatchField) {
            const fullSearchFields = contextMatchField.lookupSearchField || 'Name';
            promises.push(getRecordDetails({ recordId: this.recordId, objectApiName: contextMatchField.lookupTargetObject, searchFields: fullSearchFields }));
        } else { promises.push(Promise.resolve(null)); }

        if (this.recordId && sourceFieldsToQuery.size > 0) {
            promises.push(getSourceRecordData({ sourceRecordId: this.recordId, sourceFields: Array.from(sourceFieldsToQuery) }));
        } else { promises.push(Promise.resolve({})); }

        Promise.all(promises).then(results => {
            const recordDetails = results[0];
            const sourceData = results[1];
            this._cachedSourceData = sourceData || {};
            this.buildForm(data.sections, data.objectApiName, null, recordDetails, null);
        })
            .catch(error => {
                this.buildForm(data.sections, data.objectApiName, null, null, null);
            });
    }

    buildForm(sectionsData, parentObjectName, existingData, prepopData, prepopFieldName, fullDataBundle) {
        try {
            let initialSectionData = {};
            if (!sectionsData) {
                this.isLoading = false;
                return;
            }

            const cleanSections = JSON.parse(JSON.stringify(sectionsData));
            this.isEditMode = Boolean(existingData != null);
            this._recordsToDelete = [];
            this._rollbackChildIds = [];
            this.hasRequiredUpload = false;
            this.hasOptionalUpload = false;
            this.hasAnyUpload = false;
            this.currentStepIndex = 0;
            this.matrixState = {};

            const currentMode = this.isEditMode ? 'edit' : 'create';
            const filteredSections = cleanSections.filter(sec => this.isSectionAllowed(sec, currentMode));

            this.sections = filteredSections.sort((a, b) => (a.order || 0) - (b.order || 0)).map(sec => {
                const isMatrix = (sec.renderAs === 'Matrix');
                const isStandardSection = !isMatrix;
                const sectionTargetObject = sec.objectApiName || parentObjectName;
                const colSize = Math.floor(12 / (sec.numColumns || 2));
                const isChildSection = (sectionTargetObject !== parentObjectName);
                let rows = [];
                let matrixConfig = null;

                if (isMatrix) {
                    try {
                        const parsedConfig = JSON.parse(sec.sectionConfig);
                        const matrixObj = sec.objectApiName || 'Form_Matrix_Entry__c';
                        matrixConfig = this.initializeMatrix(parsedConfig, sec.developerName, fullDataBundle, matrixObj);
                    } catch (e) { }
                }
                else if (isStandardSection) {
                    if (isChildSection && existingData && existingData.children && existingData.children[sectionTargetObject]) {
                        const childRecords = existingData.children[sectionTargetObject];
                        rows = childRecords.map((record, index) => {
                            const rowUuid = generateUuid();
                            initialSectionData[rowUuid] = {};
                            const processedFields = this.initializeFields(sec.fields, rowUuid, initialSectionData, colSize, record, true, prepopData, fullDataBundle);
                            if (record.Id) initialSectionData[rowUuid]['Id'] = record.Id;
                            return { id: rowUuid, label: `Item #${index + 1}`, fields: processedFields, isRemovable: Boolean(sec.allowMultipleRows) };
                        });
                    }
                    if (rows.length === 0) {
                        const rowUuid = generateUuid();
                        initialSectionData[rowUuid] = {};

                        let dataContext = null;
                        if (isChildSection) {
                            if (existingData && existingData.children && existingData.children[sectionTargetObject] && existingData.children[sectionTargetObject].length > 0) {
                                dataContext = existingData.children[sectionTargetObject][0];
                            }
                        } else {
                            dataContext = (existingData ? existingData.parent : null);
                        }

                        const rowIsEdit = Boolean(this.isEditMode && dataContext != null);

                        if (rowIsEdit && dataContext && dataContext.Id) {
                            initialSectionData[rowUuid]['Id'] = dataContext.Id;
                            if (!isChildSection) {
                                this.savedRecordId = dataContext.Id;
                            }
                        }

                        const processedFields = this.initializeFields(sec.fields, rowUuid, initialSectionData, colSize, dataContext, rowIsEdit, prepopData, existingData);
                        rows.push({ id: rowUuid, label: `Item #1`, fields: processedFields, isRemovable: false });
                    }
                }

                const startExpanded = sec.isCollapsed ? false : true;
                const baseClass = startExpanded ? 'slds-section slds-is-open slds-m-bottom_medium' : 'slds-section slds-m-bottom_medium';

                return {
                    ...sec, id: sec.id || generateUuid(), targetObject: sectionTargetObject,
                    relationshipParentField: sec.relationshipParentField, allowMultiple: Boolean(sec.allowMultipleRows),
                    visibilityLogic: sec.visibilityLogic, colSize: colSize, isVisible: true, rows: rows,
                    isStandardSection: isStandardSection, isMatrix: isMatrix,
                    isRequired: Boolean(sec.isRequired),
                    isExpanded: startExpanded,
                    isLogicallyVisible: true,
                    sectionClass: baseClass,
                    matrixColumns: matrixConfig ? matrixConfig.columns : [],
                    matrixRows: matrixConfig ? matrixConfig.rows : [],
                    parentSectionDevName: sec.parentSectionDevName
                };
            });

            this.sectionData = initialSectionData;
            if (this.hasRequiredUpload) this.hasAnyUpload = true;
            if (this.hasOptionalUpload) this.hasAnyUpload = true;

            setTimeout(() => {
                try {
                    // *** EXECUTION ORDER UNIFIED ***
                    this.calculateFormulas(true);
                    this.applyMatrixRules();
                    this.evaluateVisibility();

                    this.fetchDependentData();
                    this.fetchMissingLookupDetails();

                    for (let uuid in this.sectionData) {
                        for (let fieldApi in this.sectionData[uuid]) {
                            if (this.sectionData[uuid][fieldApi]) {
                                this.evaluateDynamicQueries(fieldApi, uuid, true);
                            }
                        }
                    }
                } catch (error) {
                    console.error(error);
                } finally {
                    this.isLoading = false;
                }
            }, 300);

        } catch (error) {
            this.isLoading = false;
            this.showToast('Error', 'Form failed to load. Please check console.', 'error');
        }
    }

    handleToggleSection(event) {
        const sectionId = event.currentTarget.dataset.id;
        const sec = this.sections.find(s => s.id === sectionId);
        if (sec) {
            sec.isExpanded = !sec.isExpanded;
            let baseClass = sec.isExpanded ? 'slds-section slds-is-open slds-m-bottom_medium' : 'slds-section slds-m-bottom_medium';
            if (!sec.isVisible) baseClass += ' slds-hide';
            sec.sectionClass = baseClass;
            this.sections = [...this.sections];
        }
    }

    fetchMissingLookupDetails() {
        for (let sec of this.sections) {
            if (!sec.isStandardSection || !sec.rows) continue;
            for (let row of sec.rows) {
                for (let field of row.fields) {
                    const recId = this.sectionData[row.id] ? this.sectionData[row.id][field.apiName] : null;

                    if (field.isLookup && recId) {
                        const needsLabel = (field.currentValue === recId);
                        const needsDetails = (!field.currentDetails && field.lookupSearchField && field.lookupSearchField.includes(','));

                        if (needsLabel || needsDetails) {
                            if (needsLabel) {
                                this.updateFieldState(row.id, field.apiName, { currentValue: 'Resolving...' });
                            }

                            getRecordDetails({
                                recordId: recId,
                                objectApiName: field.lookupTargetObject,
                                searchFields: field.lookupSearchField || 'Name'
                            })
                                .then(res => {
                                    if (res) {
                                        let updates = {};
                                        if (needsLabel && res.label) updates.currentValue = res.label;
                                        else if (needsLabel && !res.label) updates.currentValue = recId;

                                        if (res.details) updates.currentDetails = res.details;
                                        this.updateFieldState(row.id, field.apiName, updates);
                                    }
                                })
                                .catch(err => {
                                    if (needsLabel) {
                                        this.updateFieldState(row.id, field.apiName, { currentValue: recId });
                                    }
                                });
                        }
                    }
                }
            }
        }
    }

    fetchDependentData() {
        if (!this.sections) return;
        this.sections.forEach(sec => {
            if (sec.parentSectionDevName && sec.isMatrix) {
                const parentSec = this.sections.find(s => s.developerName === sec.parentSectionDevName);
                if (parentSec && parentSec.rows && parentSec.rows.length > 0) {

                    let effectiveTargetObj = parentSec.targetObject || parentSec.objectApiName;
                    let targetRecordId = null;

                    if (effectiveTargetObj === this._formTargetObject) {
                        const childField = parentSec.rows[0].fields.find(f => f.targetObject && f.targetObject !== this._formTargetObject);
                        if (childField) {
                            effectiveTargetObj = childField.targetObject;
                        }
                    }

                    if (effectiveTargetObj === this._formTargetObject) {
                        targetRecordId = this.recordId;
                    } else {
                        if (this._serverData && this._serverData.children && this._serverData.children[effectiveTargetObj] && this._serverData.children[effectiveTargetObj].length > 0) {
                            targetRecordId = this._serverData.children[effectiveTargetObj][0].Id;
                        } else {
                            const parentRowId = parentSec.rows[0].id;
                            const parentData = this.sectionData[parentRowId];
                            if (parentData && parentData.Id) {
                                targetRecordId = parentData.Id;
                            }
                        }
                    }

                    if (targetRecordId) {
                        const matrixObj = sec.objectApiName || 'Form_Matrix_Entry__c';
                        const childConfig = {
                            objectApiName: matrixObj, parentField: sec.relationshipParentField,
                            fields: [
                                { api: 'Section_Key__c', type: 'Text' }, { api: 'Row_Key__c', type: 'Text' },
                                { api: 'Column_Key__c', type: 'Text' }, { api: 'Value__c', type: 'Text' }
                            ]
                        };
                        const queryConfig = { parentFields: [{ api: 'Id', type: 'String' }], children: [childConfig] };
                        getExistingRecordData({
                            recordId: targetRecordId,
                            objectApiName: effectiveTargetObj,
                            queryConfigJson: JSON.stringify(queryConfig)
                        })
                            .then(data => {
                                if (data && data.children) {
                                    try {
                                        const parsedConfig = JSON.parse(sec.sectionConfig);
                                        const matrixConfig = this.initializeMatrix(parsedConfig, sec.developerName, data, matrixObj);
                                        const targetSec = this.sections.find(s => s.id === sec.id);
                                        if (targetSec) targetSec.matrixRows = matrixConfig.rows;
                                        this.applyMatrixRules();
                                        this.evaluateVisibility();
                                    } catch (e) { }
                                }
                            }).catch(err => { });
                    }
                }
            }
        });
    }

    // *** UPGRADED: Returns boolean so the loop knows if data was destroyed ***
    applyMatrixRules() {
        let forceRepaint = false;
        let dataWipedThisPass = false;

        for (let sec of this.sections) {
            if (!sec.isMatrix || !sec.matrixRows) continue;
            for (let row of sec.matrixRows) {
                for (let cell of row.cells) {
                    let shouldBeReadOnly = cell.isReadOnly;

                    if (cell.readonlyLogic) {
                        shouldBeReadOnly = Boolean(this.checkLogic(cell.readonlyLogic, null, true));
                    } else if (cell.staticReadOnly === true) {
                        shouldBeReadOnly = true;
                    }

                    if (cell.isReadOnly !== shouldBeReadOnly) {
                        cell.isReadOnly = shouldBeReadOnly;
                        forceRepaint = true;
                    }

                    if (shouldBeReadOnly) {
                        const emptyVal = cell.isCheckbox ? 'false' : '';
                        const emptyDisplay = cell.isCheckbox ? false : '';

                        if (cell.value !== emptyVal) {
                            cell.value = emptyVal;
                            cell.displayValue = emptyDisplay;

                            if (!this.matrixState) this.matrixState = {};
                            this.matrixState[`MATRIX__${sec.developerName}__${cell.rowKey}__${cell.colKey}`] = emptyDisplay;
                            forceRepaint = true;
                            dataWipedThisPass = true;
                        }
                    }
                }
            }
        }

        if (forceRepaint) {
            this.sections = [...this.sections];
        }

        return dataWipedThisPass;
    }

    initializeMatrix(config, sectionDevName, fullDataBundle, matrixObjectName) {
        let existingEntries = [];
        if (fullDataBundle && fullDataBundle.children && fullDataBundle.children[matrixObjectName]) {
            existingEntries = fullDataBundle.children[matrixObjectName];
        }

        const safeColumns = config.columns.map(c => {
            return { ...c, safeColKey: String(c.key).replace(/[^a-zA-Z0-9]/g, '_') };
        });

        const rows = config.rows.map(r => {
            let safeRowKey = String(r.key).replace(/[^a-zA-Z0-9]/g, '_');

            const processedCells = config.columns.map(col => {
                const rowKey = r.key;
                const colKey = col.key;
                const match = existingEntries.find(e => e.Section_Key__c === sectionDevName && e.Row_Key__c === rowKey && e.Column_Key__c === colKey);
                const val = match ? match.Value__c : '';
                const recId = match ? match.Id : null;

                let isReadOnly = false;
                let staticReadOnly = false;
                let readonlyLogic = null;
                let cellType = col.type || 'text';

                if (r.cells && r.cells[colKey]) {
                    if (r.cells[colKey].readonly === true) {
                        isReadOnly = true;
                        staticReadOnly = true;
                    }
                    if (r.cells[colKey].readonlyLogic) {
                        readonlyLogic = r.cells[colKey].readonlyLogic;
                    }
                    if (r.cells[colKey].type) cellType = r.cells[colKey].type;
                }
                const isCheckbox = (cellType === 'checkbox');
                let displayVal = val;
                if (isCheckbox) { displayVal = (val === 'true'); }

                if (!this.matrixState) this.matrixState = {};
                this.matrixState[`MATRIX__${sectionDevName}__${rowKey}__${colKey}`] = isCheckbox ? displayVal : val;

                let stepVal = (cellType === 'number') ? 'any' : null;

                let safeDomId = `matrix_${safeRowKey}_${String(colKey).replace(/[^a-zA-Z0-9]/g, '_')}`;

                return {
                    key: `${rowKey}__${colKey}`,
                    domId: safeDomId,
                    rowKey: rowKey, colKey: colKey,
                    value: val, displayValue: displayVal, recordId: recId,
                    isReadOnly: Boolean(isReadOnly), staticReadOnly: Boolean(staticReadOnly), readonlyLogic: readonlyLogic,
                    isCheckbox: Boolean(isCheckbox), isStandard: !Boolean(isCheckbox),
                    step: stepVal,
                    inputType: isCheckbox ? 'checkbox' : (cellType === 'number' ? 'number' : 'text')
                };
            });
            return { key: r.key, safeRowKey: safeRowKey, label: r.label, cells: processedCells };
        });
        return { columns: safeColumns, rows: rows };
    }

    handleMatrixChange(event) {
        const sectionId = event.target.dataset.section;
        const rowKey = event.target.dataset.row;
        const colKey = event.target.dataset.col;
        let newVal;
        let isChecked = false;
        if (event.target.type === 'checkbox') {
            isChecked = event.target.checked;
            newVal = isChecked ? 'true' : 'false';
        } else { newVal = event.target.value; }

        const sec = this.sections.find(s => s.id === sectionId);
        if (sec && sec.matrixRows) {
            for (let row of sec.matrixRows) {
                if (row.key === rowKey) {
                    for (let cell of row.cells) {
                        if (cell.colKey === colKey) {
                            if (cell.value !== newVal) {
                                cell.value = newVal;
                                if (event.target.type === 'checkbox') {
                                    cell.displayValue = isChecked;
                                }
                                if (!this.matrixState) this.matrixState = {};
                                this.matrixState[`MATRIX__${sec.developerName}__${rowKey}__${colKey}`] = isChecked ? isChecked : newVal;
                            }
                            break;
                        }
                    }
                    break;
                }
            }
        }

        // *** EXECUTION ORDER UNIFIED ***
        this.calculateFormulas();
        this.applyMatrixRules();
        this.evaluateVisibility();
    }

    initializeFields(fields, rowUuid, dataStore, colSize, primaryData, isEditMode, prepopData, fullDataBundle) {
        if (!fields) return [];

        return fields.sort((a, b) => (a.order || 0) - (b.order || 0)).map(f => {
            let initialValue = '';
            let displayValue = '';
            let currentDetails = '';

            const typeLower = f.type ? f.type.toLowerCase() : '';
            const isHeader = (typeLower === 'header');
            const isDisplayText = (typeLower === 'display text' || typeLower === 'rich text');
            const isCheckbox = (typeLower === 'checkbox');
            const isMultiSelect = (typeLower.includes('multi') && typeLower.includes('picklist'));
            const isPicklist = (!isMultiSelect && typeLower.includes('picklist'));
            const isLookup = (typeLower === 'lookup');
            const isFileUploadType = (typeLower.includes('file') && typeLower.includes('upload'));
            const isLongTextAreaType = (typeLower.includes('long') && typeLower.includes('text'));

            if (isEditMode) {
                let foundValue = undefined;
                let foundLabel = undefined;
                if (primaryData && primaryData.hasOwnProperty(f.apiName)) {
                    foundValue = primaryData[f.apiName];
                    if (isLookup) foundLabel = primaryData[f.apiName + '_Label'];
                } else if (fullDataBundle && f.targetObject && fullDataBundle.children && fullDataBundle.children[f.targetObject]) {
                    const childRecs = fullDataBundle.children[f.targetObject];
                    if (childRecs.length > 0) {
                        const child = childRecs[0];
                        if (child.hasOwnProperty(f.apiName)) {
                            foundValue = child[f.apiName];
                            if (isLookup) foundLabel = child[f.apiName + '_Label'];
                        }
                    }
                }
                if (foundValue !== undefined) {
                    initialValue = foundValue;
                    dataStore[rowUuid][f.apiName] = initialValue;
                    if (isLookup && foundLabel) { displayValue = foundLabel; }
                    else if (isMultiSelect && initialValue) { displayValue = initialValue.split(';'); }
                    else { displayValue = initialValue; }
                } else {
                    initialValue = (isCheckbox) ? false : '';
                    dataStore[rowUuid][f.apiName] = initialValue;
                    displayValue = isMultiSelect ? [] : initialValue;
                }
            } else {
                let isContextMatch = false;
                if (this.recordId && f.keyPrefix && this.recordId.indexOf(f.keyPrefix) === 0) {
                    isContextMatch = true;
                }
                const isUserPrepop = Boolean(f.prepopulate && f.lookupTargetObject === 'User' && !f.keyPrefix);

                if (isContextMatch && f.sourceFieldApiName && this._cachedSourceData && this._cachedSourceData[f.sourceFieldApiName]) {
                    const sourceInfo = this._cachedSourceData[f.sourceFieldApiName];
                    dataStore[rowUuid][f.apiName] = sourceInfo.value;
                    initialValue = sourceInfo.value;
                    displayValue = sourceInfo.label;
                }
                else if (isContextMatch) {
                    dataStore[rowUuid][f.apiName] = this.recordId;
                    initialValue = this.recordId;
                    if (prepopData) { displayValue = prepopData.label || ''; currentDetails = prepopData.details || ''; }
                }
                else if (isUserPrepop && this._cachedMetadata) {
                    dataStore[rowUuid][f.apiName] = this._cachedMetadata.currentUserId;
                    initialValue = this._cachedMetadata.currentUserId;
                    displayValue = this._cachedMetadata.currentUserName;
                }
                else {
                    if (f.defaultValue) {
                        if (isCheckbox) { initialValue = (f.defaultValue.toLowerCase() === 'true'); }
                        else if (typeLower === 'number' || typeLower === 'currency' || typeLower === 'percent') { initialValue = Number(f.defaultValue); }
                        else { initialValue = f.defaultValue; }
                    } else { initialValue = (isCheckbox) ? false : ''; }
                    dataStore[rowUuid][f.apiName] = initialValue;
                    displayValue = isMultiSelect ? [] : initialValue;
                }
            }

            if (isFileUploadType) {
                if (f.required) this.hasRequiredUpload = true;
                else this.hasOptionalUpload = true;
            }

            let currentOptions = [];
            if (f.picklistOptions) {
                currentOptions = f.picklistOptions.map(opt => ({ label: String(opt.label), value: String(opt.value) }));
            }
            if (f.controllerField && f.dependencyMap) {
                const ctrlVal = dataStore[rowUuid][f.controllerField];
                if (ctrlVal && f.dependencyMap[ctrlVal]) {
                    currentOptions = f.dependencyMap[ctrlVal].map(opt => ({ label: String(opt.label), value: String(opt.value) }));
                }
            }

            if (isPicklist && !isMultiSelect) {
                currentOptions = [{ label: '--None--', value: '' }, ...currentOptions];
            }

            let isReadOnlyEffective = Boolean(f.readOnly || (f.formulaLogic && f.formulaLogic.length > 0));
            let isStaticRequired = Boolean(f.required);
            const calculatedGridSize = isHeader ? 12 : ((isLongTextAreaType || isFileUploadType || isMultiSelect || isDisplayText) ? 12 : colSize);

            let finalValue = displayValue;
            if (finalValue === undefined || finalValue === null) {
                finalValue = isMultiSelect ? [] : (isCheckbox ? false : '');
            }

            let mappedUiType = String(this.mapType(f.type));
            let stepVal = (mappedUiType === 'number') ? 'any' : null;

            let dynamicSoqlStr = f.dynamicSoql ? String(f.dynamicSoql) : null;
            let soqlDependenciesArr = [];
            if (dynamicSoqlStr) {
                const regex = /\{([^}]+)\}/g;
                let match;
                while ((match = regex.exec(dynamicSoqlStr)) !== null) {
                    if (!soqlDependenciesArr.includes(match[1])) {
                        soqlDependenciesArr.push(match[1]);
                    }
                }
            }

            return {
                ...f,
                isStaticRequired: isStaticRequired,
                required: isStaticRequired,
                controllingLookup: f.controllingLookup ? String(f.controllingLookup) : null,

                isHeader: Boolean(isHeader),
                isDisplayText: Boolean(isDisplayText),
                htmlContent: f.htmlContent ? String(f.htmlContent) : '',

                isPicklist: Boolean(isPicklist),
                isMultiSelect: Boolean(isMultiSelect),
                isLookup: Boolean(isLookup),
                isTextArea: Boolean(isLongTextAreaType),
                isFileUpload: Boolean(isFileUploadType),
                isCheckbox: Boolean(isCheckbox),
                isReadOnly: isReadOnlyEffective,
                uploadedFiles: [],
                acceptedFormats: f.overridePicklistValues ? String(f.overridePicklistValues).replace(/\s/g, '') : '.pdf,.png,.jpg',

                isStandard: Boolean(!isHeader && !isDisplayText && !isLookup && !isPicklist && !isMultiSelect && !isLongTextAreaType && !isFileUploadType && !isCheckbox),

                uiType: mappedUiType,
                step: stepVal,
                dynamicSoql: dynamicSoqlStr,
                soqlDependencies: soqlDependenciesArr,
                currentValue: finalValue,
                currentDetails: currentDetails ? String(currentDetails) : '',

                _restorableValue: initialValue,
                _restorableDisplayValue: displayValue,
                _restorableDetails: currentDetails ? String(currentDetails) : '',

                isVisible: true,
                cssDisplayClass: '',
                filteredOptions: currentOptions,
                lookupOptions: [],
                showLookupOptions: false,
                lookupClass: 'slds-combobox slds-dropdown-trigger slds-dropdown-trigger_click',
                gridSize: Number(calculatedGridSize)
            };
        });
    }

    handleFieldChange(event) {
        const fieldApi = event.currentTarget.dataset.api;
        const rowId = event.currentTarget.dataset.row;

        let value = event.target.type === 'checkbox' ? Boolean(event.target.checked) : event.target.value;
        if (event.detail && event.detail.value !== undefined && event.target.type !== 'checkbox') {
            value = event.detail.value;
        }
        if (Array.isArray(value)) value = value.join(';');
        if (value === undefined || value === null) value = '';

        if (this.sectionData[rowId] && this.sectionData[rowId][fieldApi] !== value) {
            this.sectionData[rowId][fieldApi] = value;

            this.filterDependencies(rowId, fieldApi, value);

            const field = this.findField(fieldApi, rowId);
            const textLikeTypes = ['Text', 'Long Text Area', 'Number', 'Currency', 'Percent'];
            const isTextLike = field && textLikeTypes.includes(field.type);
            const hasSoqlDependency = field && field.soqlDependencies && field.soqlDependencies.length > 0;

            // If this is a non-text field, flush any pending text field debounces first (blur-time flush).
            // Ensures if a user Tabs from a text field to a picklist, text field's reactive cycle runs first.
            if (!isTextLike) {
                this.flushAllFieldChangeTimers();
            }

            // Debounce reactive cycle for text-like fields to keep typing responsive.
            // Picklists, lookups, checkboxes still run immediately for cascading logic.
            if (isTextLike && !hasSoqlDependency) {
                const debounceKey = `field-${rowId}-${fieldApi}`;
                if (!this._fieldChangeTimers) this._fieldChangeTimers = {};
                if (this._fieldChangeTimers[debounceKey]) {
                    clearTimeout(this._fieldChangeTimers[debounceKey]);
                }

                this._fieldChangeTimers[debounceKey] = setTimeout(() => {
                    this.calculateFormulas();
                    this.applyMatrixRules();
                    this.evaluateVisibility();
                    delete this._fieldChangeTimers[debounceKey];
                }, 300);
            } else {
                // Non-text fields and fields with SOQL dependencies run reactivity immediately
                this.calculateFormulas();
                this.applyMatrixRules();
                this.evaluateVisibility();

                if (hasSoqlDependency) {
                    this.evaluateDynamicQueries(fieldApi, rowId);
                }
            }
        }
    }

    flushAllFieldChangeTimers() {
        if (!this._fieldChangeTimers) return;
        for (let key in this._fieldChangeTimers) {
            clearTimeout(this._fieldChangeTimers[key]);
            delete this._fieldChangeTimers[key];
        }
    }

    evaluateDynamicQueries(changedFieldApi, rowId, isInitialLoad = false) {
        if (!this._activeSoqlQueries) this._activeSoqlQueries = {};
        for (let sec of this.sections) {
            if (!sec.rows) continue;
            for (let row of sec.rows) {
                for (let f of row.fields) {
                    if (f.dynamicSoql && f.soqlDependencies && f.soqlDependencies.includes(changedFieldApi)) {

                        if (isInitialLoad && this.isEditMode && !f.fetchOnEdit) {
                            continue;
                        }

                        this.executeSingleDynamicQuery(f, row.id);
                    }
                }
            }
        }
    }

    executeSingleDynamicQuery(field, rowId) {
        let bindParams = {};
        let hasAllParams = true;

        field.soqlDependencies.forEach(dep => {
            let val = null;
            if (this.sectionData[rowId] && this.sectionData[rowId][dep] !== undefined) {
                val = this.sectionData[rowId][dep];
            } else {
                val = this.getGlobalValue(dep);
            }

            if (val === undefined || val === null || val === '') {
                hasAllParams = false;
            }
            bindParams[dep] = val;
        });

        if (!hasAllParams) {
            let emptyVal = field.isMultiSelect ? [] : (field.isCheckbox ? false : '');
            if (this.sectionData[rowId] && this.sectionData[rowId][field.apiName] !== emptyVal) {
                this.sectionData[rowId][field.apiName] = emptyVal;
                this.updateFieldState(rowId, field.apiName, { currentValue: emptyVal, currentDetails: '' });

                // *** EXECUTION ORDER UNIFIED ***
                this.calculateFormulas();
                this.applyMatrixRules();
                this.evaluateVisibility();
            }
            return;
        }

        let safeQuery = field.dynamicSoql.replace(/'?\{([^}]+)\}'?/g, ':$1');

        const queryKey = `${rowId}-${field.apiName}`;
        const currentQueryStr = JSON.stringify(bindParams);
        this._activeSoqlQueries[queryKey] = currentQueryStr;

        executeDynamicQuery({ soqlQuery: safeQuery, bindParams: bindParams })
            .then(result => {
                if (this._activeSoqlQueries[queryKey] !== currentQueryStr) return;

                let newValue = field.isCheckbox ? false : '';
                if (result) {
                    const extractVal = (obj) => {
                        for (let key in obj) {
                            if (key !== 'attributes' && key !== 'Id') {
                                if (typeof obj[key] === 'object' && obj[key] !== null) return extractVal(obj[key]);
                                return obj[key];
                            }
                        }
                        return obj.Id || null;
                    };
                    let extracted = extractVal(result);
                    if (extracted !== null && extracted !== undefined) {
                        newValue = extracted;
                    }
                }

                if (this.sectionData[rowId] && this.sectionData[rowId][field.apiName] !== newValue) {
                    this.sectionData[rowId][field.apiName] = newValue;

                    if (field.isLookup && newValue) {
                        this.updateFieldState(rowId, field.apiName, { currentValue: 'Resolving...' });

                        getRecordDetails({
                            recordId: newValue,
                            objectApiName: field.lookupTargetObject,
                            searchFields: field.lookupSearchField || 'Name'
                        })
                            .then(res => {
                                if (res && res.label) {
                                    this.updateFieldState(rowId, field.apiName, {
                                        currentValue: res.label,
                                        currentDetails: res.details || ''
                                    });
                                } else {
                                    this.updateFieldState(rowId, field.apiName, { currentValue: newValue });
                                }
                            })
                            .catch(() => {
                                this.updateFieldState(rowId, field.apiName, { currentValue: newValue });
                            });
                    } else {
                        this.updateFieldState(rowId, field.apiName, { currentValue: newValue });
                    }

                    this.filterDependencies(rowId, field.apiName, newValue);

                    // *** EXECUTION ORDER UNIFIED ***
                    this.calculateFormulas();
                    this.applyMatrixRules();
                    this.evaluateVisibility();

                    this.evaluateDynamicQueries(field.apiName, rowId);

                    if (field.isLookup) {
                        this.handleReactiveContextChange(field.apiName, newValue);
                    }
                }
            })
            .catch(err => {
                console.error('Dynamic SOQL Error:', err);
            });
    }

    filterDependencies(rowId, ctrlApi, ctrlVal) {
        for (let sec of this.sections) {
            if (!sec.rows) continue;
            for (let row of sec.rows) {
                if (row.id === rowId) {
                    for (let f of row.fields) {
                        if (f.controllerField === ctrlApi) {
                            let newOptions = [];
                            if (f.dependencyMap && f.dependencyMap[ctrlVal]) {
                                newOptions = f.dependencyMap[ctrlVal].map(opt => ({ label: String(opt.label), value: String(opt.value) }));
                            }

                            if (f.isPicklist && !f.isMultiSelect) {
                                newOptions = [{ label: '--None--', value: '' }, ...newOptions];
                            }

                            f.filteredOptions = newOptions;

                            if (this.sectionData[rowId] && this.sectionData[rowId][f.apiName]) {
                                const emptyVal = f.isMultiSelect ? [] : '';
                                this.sectionData[rowId][f.apiName] = emptyVal;
                                f.currentValue = emptyVal;
                            }
                        }
                    }
                }
            }
        }
    }

    calculateFormulas(isInitialLoad = false) {
        let triggeredFormulas = [];

        for (let sec of this.sections) {
            if (!sec.rows) continue;
            for (let row of sec.rows) {
                const rowData = this.sectionData[row.id];
                if (!rowData) continue;
                for (let f of row.fields) {
                    if (f.formulaLogic) {
                        try {
                            let expression = f.formulaLogic;
                            const regex = /\{([^}]+)\}/g;
                            const parsedExpression = expression.replace(regex, (match, fieldName) => {
                                let val;
                                if (rowData && rowData.hasOwnProperty(fieldName)) {
                                    val = rowData[fieldName];
                                } else {
                                    val = this.getGlobalValue(fieldName);
                                }

                                if (val === undefined || val === null || val === '') return 0;
                                return !isNaN(val) ? val : `"${val}"`;
                            });
                            const result = new Function('return ' + parsedExpression)();

                            if (rowData[f.apiName] !== result) {
                                rowData[f.apiName] = result;
                                triggeredFormulas.push({ apiName: f.apiName, rowId: row.id });
                            }
                        } catch (err) { }
                    }
                }
            }
        }

        if (triggeredFormulas.length > 0) {
            triggeredFormulas.forEach(formula => {
                this.evaluateDynamicQueries(formula.apiName, formula.rowId, isInitialLoad);
            });
        }
    }

    // *** STABILIZATION LOOP UPGRADED ***
    evaluateVisibility() {
        let forceSectionRepaint = false;
        let isStabilized = false;
        let loopCount = 0;
        let restoredFieldsForSoql = [];

        do {
            isStabilized = true;
            loopCount++;

            if (loopCount > 10) {
                console.warn('Dynamic Form: Visibility evaluation hit stabilization loop limit.');
                break;
            }

            let dataChangedThisPass = false;

            for (let i = 0; i < this.sections.length; i++) {
                let sec = this.sections[i];
                let secChanged = false;

                let isLogicallyVisible = true;
                if (sec.visibilityLogic) {
                    try {
                        const logic = JSON.parse(sec.visibilityLogic);
                        isLogicallyVisible = Boolean(this.checkLogic(logic, null, true));
                    } catch (e) { }
                }

                const hasUpload = sec.rows && sec.rows.some(row => row.fields && row.fields.some(f => f.isFileUpload));
                if (hasUpload && !this.savedRecordId) { isLogicallyVisible = false; }

                if (sec.isLogicallyVisible !== isLogicallyVisible) {
                    sec.isLogicallyVisible = isLogicallyVisible;
                    secChanged = true;
                    isStabilized = false;
                }

                let isWizardVisible = true;
                if (this.isWizardMode) { isWizardVisible = (i === this.currentStepIndex); }

                let finalSecVisible = Boolean(sec.isLogicallyVisible && isWizardVisible);

                if (this.isSubmitHidden) {
                    finalSecVisible = Boolean(hasUpload);           // only change the display outcome
                    if (hasUpload && !sec.isExpanded) {
                        sec.isExpanded = true;
                        secChanged = true;
                        isStabilized = false;
                    }
                }


                if (sec.isVisible !== finalSecVisible) {
                    sec.isVisible = finalSecVisible;
                    secChanged = true;
                    isStabilized = false;
                }

                let baseClass = sec.isExpanded ? 'slds-section slds-is-open slds-m-bottom_medium' : 'slds-section slds-m-bottom_medium';
                if (!sec.isVisible) baseClass += ' slds-hide';

                if (sec.sectionClass !== baseClass) {
                    sec.sectionClass = baseClass;
                    secChanged = true;
                }

                if (sec.rows) {
                    let rowsChanged = false;
                    for (let rIndex = 0; rIndex < sec.rows.length; rIndex++) {
                        let row = sec.rows[rIndex];
                        let fieldsChanged = false;

                        for (let f of row.fields) {

                            let syncedValue = f.currentValue;
                            if (!f.isLookup && !f.isFileUpload) {
                                if (this.sectionData[row.id] && this.sectionData[row.id].hasOwnProperty(f.apiName)) {
                                    let storedVal = this.sectionData[row.id][f.apiName];
                                    if (f.isMultiSelect && typeof storedVal === 'string') {
                                        syncedValue = storedVal ? storedVal.split(';') : [];
                                    } else {
                                        syncedValue = storedVal;
                                    }
                                }
                            }

                            if (syncedValue === undefined || syncedValue === null) {
                                syncedValue = f.isMultiSelect ? [] : (f.isCheckbox ? false : '');
                            }

                            if (f.isMultiSelect) {
                                if (JSON.stringify(f.currentValue) !== JSON.stringify(syncedValue)) {
                                    f.currentValue = syncedValue;
                                    fieldsChanged = true;
                                }
                            } else {
                                if (f.currentValue !== syncedValue) {
                                    f.currentValue = syncedValue;
                                    fieldsChanged = true;
                                }
                            }

                            let isFieldLogicVisible = true;
                            if (f.visibilityLogic) {
                                try {
                                    const logic = JSON.parse(f.visibilityLogic);
                                    isFieldLogicVisible = Boolean(this.checkLogic(logic, this.sectionData[row.id], false));
                                } catch (e) { }
                            }

                            if (sec.allowMultiple && rIndex > 0 && f.isDisplayText) {
                                isFieldLogicVisible = false;
                            }

                            const finalFieldLogicallyVisible = Boolean(isFieldLogicVisible && sec.isLogicallyVisible);

                            const becameVisible = (f.isVisible === false && finalFieldLogicallyVisible === true);

                            if (f.isVisible !== finalFieldLogicallyVisible) {
                                f.isVisible = finalFieldLogicallyVisible;
                                fieldsChanged = true;
                                isStabilized = false;
                            }

                            const newDisplayClass = finalFieldLogicallyVisible ? '' : 'slds-hide';
                            if (f.cssDisplayClass !== newDisplayClass) {
                                f.cssDisplayClass = newDisplayClass;
                                fieldsChanged = true;
                                isStabilized = false;
                            }

                            if (!finalFieldLogicallyVisible) {
                                const emptyVal = f.isMultiSelect ? [] : (f.isCheckbox ? false : '');
                                let currentDataVal = this.sectionData[row.id] ? this.sectionData[row.id][f.apiName] : undefined;

                                let needsWipe = false;
                                if (f.isMultiSelect) {
                                    if (Array.isArray(currentDataVal) && currentDataVal.length > 0) needsWipe = true;
                                    else if (typeof currentDataVal === 'string' && currentDataVal !== '') needsWipe = true;
                                } else {
                                    if (currentDataVal !== emptyVal && currentDataVal !== undefined) needsWipe = true;
                                }

                                if (needsWipe) {
                                    this.sectionData[row.id][f.apiName] = emptyVal;
                                    f.currentValue = emptyVal;

                                    if (f.isLookup) f.currentDetails = '';

                                    fieldsChanged = true;
                                    isStabilized = false;
                                    dataChangedThisPass = true;
                                }
                            }
                            else if (becameVisible) {
                                const emptyVal = f.isMultiSelect ? [] : (f.isCheckbox ? false : '');
                                let currentDataVal = this.sectionData[row.id] ? this.sectionData[row.id][f.apiName] : undefined;

                                let isEmpty = false;
                                if (f.isMultiSelect) {
                                    isEmpty = (!Array.isArray(currentDataVal) || currentDataVal.length === 0) && (typeof currentDataVal !== 'string' || currentDataVal === '');
                                } else {
                                    isEmpty = (currentDataVal === emptyVal || currentDataVal === undefined);
                                }

                                if (isEmpty && f._restorableValue !== emptyVal && f._restorableValue !== undefined) {
                                    if (!this.sectionData[row.id]) this.sectionData[row.id] = {};
                                    this.sectionData[row.id][f.apiName] = f._restorableValue;

                                    let newSyncedDisplay = f._restorableDisplayValue;
                                    if (f.isMultiSelect && typeof f._restorableValue === 'string') {
                                        newSyncedDisplay = f._restorableValue ? f._restorableValue.split(';') : [];
                                    }

                                    f.currentValue = newSyncedDisplay;
                                    if (f.isLookup) f.currentDetails = f._restorableDetails;

                                    fieldsChanged = true;
                                    isStabilized = false;
                                    dataChangedThisPass = true;

                                    restoredFieldsForSoql.push({ apiName: f.apiName, rowId: row.id, isLookup: f.isLookup });
                                }
                            }

                            let isFieldRequired = Boolean(f.isStaticRequired);
                            if (f.requiredLogic) {
                                try {
                                    const reqLogic = JSON.parse(f.requiredLogic);
                                    isFieldRequired = isFieldRequired || Boolean(this.checkLogic(reqLogic, this.sectionData[row.id], false));
                                } catch (e) { }
                            }

                            const finalRequired = Boolean(finalFieldLogicallyVisible) ? isFieldRequired : false;
                            if (f.required !== finalRequired) {
                                f.required = finalRequired;
                                fieldsChanged = true;
                                isStabilized = false;
                            }
                        }

                        if (fieldsChanged) {
                            row.fields = [...row.fields];
                            rowsChanged = true;
                        }
                    }

                    if (rowsChanged || secChanged) {
                        sec.rows = [...sec.rows];
                        forceSectionRepaint = true;
                    }
                } else if (secChanged) {
                    forceSectionRepaint = true;
                }
            }

            // *** NEW: Cascade visibility changes instantly into the Matrix rules ***
            if (dataChangedThisPass) {
                this.calculateFormulas();

                // If the destroyed data changed a matrix cell to readonly, loop again!
                let matrixWipedData = this.applyMatrixRules();
                if (matrixWipedData) {
                    isStabilized = false;
                }
            }

        } while (!isStabilized);

        if (forceSectionRepaint) {
            this.sections = [...this.sections];
        }

        if (restoredFieldsForSoql.length > 0) {
            const uniqueRestores = [];
            const seenKeys = new Set();
            restoredFieldsForSoql.forEach(item => {
                const key = item.rowId + '-' + item.apiName;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    uniqueRestores.push(item);
                }
            });

            uniqueRestores.forEach(item => {
                this.evaluateDynamicQueries(item.apiName, item.rowId);
                if (item.isLookup) {
                    const restoredVal = this.sectionData[item.rowId] ? this.sectionData[item.rowId][item.apiName] : null;
                    if (restoredVal) {
                        this.handleReactiveContextChange(item.apiName, restoredVal);
                    }
                }
            });
        }
    }

    checkLogic(logic, dataContext, isGlobal) {
        if (!logic) return true;
        if (logic.when) {
            let currentVal;
            if (dataContext && dataContext.hasOwnProperty(logic.when)) { currentVal = dataContext[logic.when]; } else { currentVal = this.getGlobalValue(logic.when); }
            let targetVal = logic.value;
            if (typeof currentVal === 'boolean') targetVal = (String(targetVal).toLowerCase() === 'true');
            if (logic.operator === 'includes') {
                return currentVal && String(currentVal).includes(targetVal);
            }
            if (logic.operator === 'excludes') {
                return !currentVal || !String(currentVal).includes(targetVal);
            }
            return logic.operator === 'equals' ? currentVal === targetVal : currentVal !== targetVal;
        }
        if (logic.operator === 'AND') return logic.conditions.every(c => this.checkLogic(c, dataContext, isGlobal));
        if (logic.operator === 'OR') return logic.conditions.some(c => this.checkLogic(c, dataContext, isGlobal));
        return true;
    }

    getGlobalValue(fieldApiName) {
        if (fieldApiName && fieldApiName.startsWith('MATRIX__')) {
            return this.matrixState ? this.matrixState[fieldApiName] : undefined;
        }

        for (const uuid in this.sectionData) {
            if (this.sectionData[uuid].hasOwnProperty(fieldApiName)) { return this.sectionData[uuid][fieldApiName]; }
        }
        if (this._serverData && this._serverData.parent && this._serverData.parent[fieldApiName] !== undefined) { return this._serverData.parent[fieldApiName]; }
        return undefined;
    }

    findNextVisibleSectionIndex(currentIndex) {
        for (let i = currentIndex + 1; i < this.sections.length; i++) {
            const sec = this.sections[i];
            const hasUpload = sec.rows && sec.rows.some(row => row.fields.some(f => f.isFileUpload));
            if (hasUpload && !this.savedRecordId) continue;
            let isLogicVisible = true;
            if (sec.visibilityLogic) { try { const logic = JSON.parse(sec.visibilityLogic); isLogicVisible = this.checkLogic(logic, null, true); } catch (e) { isLogicVisible = false; } }
            if (isLogicVisible) return i;
        }
        return -1;
    }

    findPrevVisibleSectionIndex(currentIndex) {
        for (let i = currentIndex - 1; i >= 0; i--) {
            const sec = this.sections[i];
            const hasUpload = sec.rows && sec.rows.some(row => row.fields.some(f => f.isFileUpload));
            if (hasUpload && !this.savedRecordId) continue;
            let isLogicVisible = true;
            if (sec.visibilityLogic) { try { const logic = JSON.parse(sec.visibilityLogic); isLogicVisible = this.checkLogic(logic, null, true); } catch (e) { isLogicVisible = false; } }
            if (isLogicVisible) return i;
        }
        return -1;
    }

    handleNext() {
        if (!this.validateCurrentStep()) {
            return;
        }
        const nextIdx = this.findNextVisibleSectionIndex(this.currentStepIndex);
        if (nextIdx !== -1) {
            this.currentStepIndex = nextIdx;
            this.evaluateVisibility();
        }
    }

    handlePrevious() {
        const prevIdx = this.findPrevVisibleSectionIndex(this.currentStepIndex);
        if (prevIdx !== -1) {
            this.currentStepIndex = prevIdx;
            this.evaluateVisibility();
        }
    }

    handleCancel() {
        if (this.isLoading) return;

        const isSafeToRollback = (
            !this.isEditMode &&
            this.savedRecordId &&
            this._isSaveCommitted
        );

        if (isSafeToRollback) {
            this.isLoading = true;
            rollbackTransaction({
                recordId: this.savedRecordId,
                childIds: this._rollbackChildIds,
                saveWithoutSharing: this.saveWithoutSharing
            })
                .then(() => {
                    this.showToast('Success', 'Submission cancelled. Record rolled back.', 'info');
                    this.navigateBack();
                })
                .catch(error => {
                    this.showToast('Error', 'Failed to rollback: ' + (error.body ? error.body.message : error.message), 'error');
                })
                .finally(() => {
                    this.isLoading = false;
                });
        } else {
            this.navigateBack();
        }
    }

    handleAddRow(event) {
        const sectionId = event.target.dataset.id;
        let targetSection = this.sections.find(s => s.id === sectionId);
        if (!targetSection) return;

        const newUuid = generateUuid();
        this.sectionData[newUuid] = {};

        const templateFields = targetSection.rows[0].fields;
        const newFields = templateFields.map(f => {
            let newVal = '';
            let newDisplay = '';
            if (f.prepopulate) {
                let isContextMatch = false;
                if (this.recordId && f.keyPrefix && this.recordId.indexOf(f.keyPrefix) === 0) isContextMatch = true;
                const isUserPrepop = Boolean(f.lookupTargetObject === 'User' && !f.keyPrefix);

                if (isContextMatch && f.sourceFieldApiName && this._cachedSourceData && this._cachedSourceData[f.sourceFieldApiName]) {
                    const sourceInfo = this._cachedSourceData[f.sourceFieldApiName];
                    newVal = sourceInfo.value; newDisplay = sourceInfo.label;
                } else if (isContextMatch) { newVal = this.recordId; }
                else if (isUserPrepop && this._cachedMetadata) { newVal = this._cachedMetadata.currentUserId; newDisplay = this._cachedMetadata.currentUserName; }
            }
            if (newVal) this.sectionData[newUuid][f.apiName] = newVal;
            else if (f.defaultValue) {
                if (f.type && f.type.toLowerCase() === 'checkbox') { this.sectionData[newUuid][f.apiName] = (f.defaultValue.toLowerCase() === 'true'); }
                else { this.sectionData[newUuid][f.apiName] = f.defaultValue; }
            } else { this.sectionData[newUuid][f.apiName] = (f.type === 'Checkbox') ? false : ''; }

            let newFilteredOpts = [];
            if (f.filteredOptions) {
                newFilteredOpts = f.filteredOptions.map(opt => ({ label: String(opt.label), value: String(opt.value) }));
            }

            return {
                ...f,
                currentValue: newDisplay,
                lookupOptions: [],
                showLookupOptions: false,
                uploadedFiles: [],
                filteredOptions: newFilteredOpts,
                cssDisplayClass: '',
                _restorableValue: newVal,
                _restorableDisplayValue: newDisplay,
                _restorableDetails: ''
            };
        });

        const newRow = { id: newUuid, label: `Item #${targetSection.rows.length + 1}`, fields: newFields, isRemovable: true };
        targetSection.rows = [...targetSection.rows, newRow];

        this.sectionData = { ...this.sectionData };
        this.sections = [...this.sections];

        this.evaluateVisibility();
    }

    handleRemoveRow(event) {
        const rowId = event.currentTarget.dataset.rowid;
        const sectionId = event.currentTarget.dataset.secid;
        if (this.sectionData[rowId] && this.sectionData[rowId].Id) this._recordsToDelete.push(this.sectionData[rowId].Id);

        const sec = this.sections.find(s => s.id === sectionId);
        if (sec) {
            sec.rows = sec.rows.filter(r => r.id !== rowId);
            sec.rows.forEach((r, idx) => { r.label = idx === 0 ? 'Item #1' : `Item #${idx + 1}`; });
        }
        delete this.sectionData[rowId];

        this.sectionData = { ...this.sectionData };
        this.sections = [...this.sections];

        this.evaluateVisibility();
    }

    handleReactiveContextChange(controllingFieldApi, newRecordId) {
        let dependentFieldsToFetch = [];
        let sourceFieldsToQuery = [];

        this.sections.forEach(sec => {
            if (!sec.isStandardSection || !sec.rows) return;
            sec.rows.forEach(row => {
                row.fields.forEach(f => {
                    if (f.controllingLookup === controllingFieldApi) {
                        dependentFieldsToFetch.push({ rowId: row.id, field: f });
                        if (f.sourceFieldApiName) {
                            sourceFieldsToQuery.push(f.sourceFieldApiName);
                        }
                    }
                });
            });
        });

        if (dependentFieldsToFetch.length === 0) return;

        if (!newRecordId) {
            dependentFieldsToFetch.forEach(dep => {
                const emptyVal = dep.field.isMultiSelect ? [] : '';
                if (this.sectionData[dep.rowId]) {
                    this.sectionData[dep.rowId][dep.field.apiName] = emptyVal;
                }
                this.updateFieldState(dep.rowId, dep.field.apiName, {
                    currentValue: emptyVal,
                    currentDetails: ''
                });

                this.evaluateDynamicQueries(dep.field.apiName, dep.rowId);
            });

            // *** EXECUTION ORDER UNIFIED ***
            this.calculateFormulas();
            this.applyMatrixRules();
            this.evaluateVisibility();
            return;
        }

        if (sourceFieldsToQuery.length > 0) {
            this.isLoading = true;
            getSourceRecordData({
                sourceRecordId: newRecordId,
                sourceFields: Array.from(new Set(sourceFieldsToQuery))
            })
                .then(sourceData => {
                    dependentFieldsToFetch.forEach(dep => {
                        const f = dep.field;
                        if (f.sourceFieldApiName && sourceData && sourceData[f.sourceFieldApiName]) {
                            const fetchedInfo = sourceData[f.sourceFieldApiName];

                            if (!this.sectionData[dep.rowId]) this.sectionData[dep.rowId] = {};
                            this.sectionData[dep.rowId][f.apiName] = fetchedInfo.value;

                            this.updateFieldState(dep.rowId, f.apiName, {
                                currentValue: fetchedInfo.label || fetchedInfo.value,
                                currentDetails: ''
                            });

                            this.evaluateDynamicQueries(f.apiName, dep.rowId);
                        }
                    });

                    // *** EXECUTION ORDER UNIFIED ***
                    this.calculateFormulas();
                    this.applyMatrixRules();
                    this.evaluateVisibility();
                    this.fetchMissingLookupDetails();
                })
                .catch(err => { })
                .finally(() => {
                    this.isLoading = false;
                });
        }
    }

    handleFocus(event) {
        const fieldApi = event.currentTarget.dataset.api;
        const rowId = event.currentTarget.dataset.row;
        this._activeLookup = `${rowId}-${fieldApi}`;
    }

    handleLookupSearch(event) {
        const fieldApi = event.currentTarget.dataset.api;
        const rowId = event.currentTarget.dataset.row;
        const searchTerm = event.target.value;
        const field = this.findField(fieldApi, rowId);
        if (!field) return;
        if (event.target.setCustomValidity) { event.target.setCustomValidity(''); event.target.reportValidity(); }

        let idChanged = false;
        if (this.sectionData[rowId] && this.sectionData[rowId][fieldApi]) {
            this.sectionData[rowId][fieldApi] = '';
            idChanged = true;
            this.handleReactiveContextChange(fieldApi, null);
        }

        const debounceKey = `${rowId}-${fieldApi}`;
        if (!this._lookupSearchTimers) this._lookupSearchTimers = {};
        if (this._lookupSearchTimers[debounceKey]) {
            clearTimeout(this._lookupSearchTimers[debounceKey]);
            delete this._lookupSearchTimers[debounceKey];
        }

        if (!searchTerm) {
            this.updateFieldState(rowId, fieldApi, {
                currentValue: '',
                currentDetails: '',
                showLookupOptions: false,
                lookupClass: 'slds-combobox slds-dropdown-trigger slds-dropdown-trigger_click'
            });

            if (idChanged) {
                this.evaluateDynamicQueries(fieldApi, rowId);
            }

            this.sectionData = { ...this.sectionData };
            this.evaluateVisibility();
            return;
        }

        if (idChanged) {
            this.evaluateDynamicQueries(fieldApi, rowId);
            this.sectionData = { ...this.sectionData };
            this.evaluateVisibility();
        }

        if (searchTerm.length >= 3) {
            if (!this._activeSearchTerms) this._activeSearchTerms = {};
            this._activeSearchTerms[debounceKey] = searchTerm;

            // Require 3+ chars to reduce noise from single-keystroke searches; combined with 300ms debounce, this prevents ~50% of unnecessary Apex calls.
            // Debounce so a fast typist fires one Apex/search-index call instead of one per keystroke.
            this._lookupSearchTimers[debounceKey] = setTimeout(() => {
                searchRecords({ searchTerm, objectApiName: field.lookupTargetObject, searchFields: field.lookupSearchField }).then(res => {

                    if (this._activeLookup !== debounceKey) return;
                    if (this._activeSearchTerms[debounceKey] !== searchTerm) return;

                    const isOpen = res && res.length > 0;
                    let safeOptions = [];
                    if (res) {
                        safeOptions = res.map(opt => ({
                            id: String(opt.id),
                            label: String(opt.label),
                            meta: opt.meta ? String(opt.meta) : '',
                            details: opt.details ? String(opt.details) : ''
                        }));
                    }
                    this.updateFieldState(rowId, fieldApi, { lookupOptions: safeOptions, showLookupOptions: isOpen, lookupClass: isOpen ? 'slds-combobox slds-dropdown-trigger slds-dropdown-trigger_click slds-is-open' : 'slds-combobox slds-dropdown-trigger slds-dropdown-trigger_click' });
                });
            }, 300);
        }
    }

    handleLookupSelect(event) {
        event.preventDefault();
        const fieldApi = event.currentTarget.dataset.api;
        const rowId = event.currentTarget.dataset.row;
        const recordId = event.currentTarget.dataset.id;
        const label = event.currentTarget.dataset.label;
        const details = event.currentTarget.dataset.details;

        if (!this.sectionData[rowId]) this.sectionData[rowId] = {};
        this.sectionData[rowId][fieldApi] = recordId;

        this.updateFieldState(rowId, fieldApi, { currentValue: label, currentDetails: details, showLookupOptions: false, lookupClass: 'slds-combobox slds-dropdown-trigger slds-dropdown-trigger_click' });

        // Clear stale-response guards so pending search calls won't overwrite this selection
        const debounceKey = `${rowId}-${fieldApi}`;
        this._activeLookup = null;
        if (this._activeSearchTerms) delete this._activeSearchTerms[debounceKey];
        if (this._lookupSearchTimers && this._lookupSearchTimers[debounceKey]) {
            clearTimeout(this._lookupSearchTimers[debounceKey]);
            delete this._lookupSearchTimers[debounceKey];
        }

        this.handleReactiveContextChange(fieldApi, recordId);

        this.evaluateDynamicQueries(fieldApi, rowId);

        this.sectionData = { ...this.sectionData };
        this.evaluateVisibility();
    }

    handleBlur(event) {
        const fieldApi = event.currentTarget.dataset.api;
        const rowId = event.currentTarget.dataset.row;

        this._activeLookup = null;

        setTimeout(() => {
            const hasValidId = this.sectionData[rowId] && this.sectionData[rowId][fieldApi];
            const field = this.findField(fieldApi, rowId);
            if (!field) return;

            let newValue = hasValidId ? field.currentValue : '';
            let newDetails = hasValidId ? field.currentDetails : '';

            this.updateFieldState(rowId, fieldApi, {
                currentValue: newValue,
                currentDetails: newDetails,
                showLookupOptions: false,
                lookupClass: 'slds-combobox slds-dropdown-trigger slds-dropdown-trigger_click'
            });

            const inputCmp = this.template.querySelector(`lightning-input[data-row="${rowId}"][data-api="${fieldApi}"]`);
            if (inputCmp) inputCmp.reportValidity();

        }, 300);
    }

    handleCustomFileUpload(event) {
        const files = event.target.files;
        const rowId = event.target.dataset.row;
        const fieldApi = event.target.dataset.api;

        if (!files || files.length === 0) return;
        if (!this.savedRecordId) {
            this.showToast('Error', 'Please save the record before uploading files.', 'error');
            return;
        }

        this.isLoading = true;
        let uploadPromises = [];

        for (let i = 0; i < files.length; i++) {
            let file = files[i];
            if (file.size > 4000000) {
                this.showToast('Warning', `File "${file.name}" is too large (Max 4MB). Skipped.`, 'warning');
                continue;
            }
            let promise = new Promise((resolve, reject) => {
                let reader = new FileReader();
                reader.onload = () => {
                    let base64 = reader.result.split(',')[1];
                    uploadFile({
                        parentId: this.savedRecordId,
                        fileName: file.name,
                        base64Data: base64,
                        saveWithoutSharing: this.saveWithoutSharing
                    })
                        .then(documentId => { resolve({ name: file.name, documentId: documentId }); })
                        .catch(error => { reject(error); });
                };
                reader.readAsDataURL(file);
            });
            uploadPromises.push(promise);
        }

        Promise.all(uploadPromises)
            .then(uploadedResults => {
                this.isLoading = false;
                if (uploadedResults.length > 0) {
                    this.showToast('Success', `${uploadedResults.length} file(s) uploaded successfully.`, 'success');
                    let filesAdded = false;
                    for (let sec of this.sections) {
                        if (!sec.rows) continue;
                        for (let row of sec.rows) {
                            if (row.id === rowId) {
                                for (let f of row.fields) {
                                    if (f.apiName === fieldApi) {
                                        let newArr = [...(f.uploadedFiles || []), ...uploadedResults];
                                        f.uploadedFiles = newArr.map(file => ({ name: String(file.name), documentId: String(file.documentId) }));
                                        filesAdded = true;
                                    }
                                }
                            }
                        }
                    }
                    if (filesAdded) this.evaluateVisibility();
                }
            })
            .catch(error => {
                this.isLoading = false;
                this.showToast('Error', 'Some files failed to upload.', 'error');
            });
    }

    handleUploadFinished(event) {
        const uploadedFiles = event.detail.files;
        const fieldApi = event.target.dataset.api;
        const rowId = event.target.dataset.row;

        let filesAdded = false;
        for (let sec of this.sections) {
            if (!sec.rows) continue;
            for (let row of sec.rows) {
                if (row.id === rowId) {
                    for (let f of row.fields) {
                        if (f.apiName === fieldApi) {
                            let newArr = [...(f.uploadedFiles || []), ...uploadedFiles];
                            f.uploadedFiles = newArr.map(file => ({ name: String(file.name), documentId: String(file.documentId) }));
                            filesAdded = true;
                        }
                    }
                }
            }
        }
        if (filesAdded) this.evaluateVisibility();
        this.showToast('Success', `${uploadedFiles.length} ${this.labels.msgUploadSuccess}`, 'success');
    }

    handleFileRemove(event) {
        const docId = event.target.name;
        const rowId = event.target.dataset.row;
        const fieldApi = event.target.dataset.api;
        this.isLoading = true;

        deleteRecord({
            recordId: docId,
            saveWithoutSharing: this.saveWithoutSharing
        }).then(() => {
            this.isLoading = false;
            this.showToast('Success', 'File deleted.', 'success');
            let filesRemoved = false;
            for (let sec of this.sections) {
                if (!sec.rows) continue;
                for (let row of sec.rows) {
                    if (row.id === rowId) {
                        for (let f of row.fields) {
                            if (f.apiName === fieldApi) {
                                let newArr = f.uploadedFiles.filter(file => file.documentId !== docId);
                                f.uploadedFiles = newArr.map(file => ({ name: String(file.name), documentId: String(file.documentId) }));
                                filesRemoved = true;
                            }
                        }
                    }
                }
            }
            if (filesRemoved) this.evaluateVisibility();
        }).catch(error => {
            this.isLoading = false;
            this.showToast('Error', 'Could not delete file: ' + error.body.message, 'error');
        });
    }

    updateFieldState(rowId, apiName, newState) {
        let sectionsChanged = false;
        for (let sec of this.sections) {
            if (!sec.rows) continue;
            let rowsChanged = false;
            for (let row of sec.rows) {
                if (row.id === rowId) {
                    let fieldsChanged = false;
                    for (let f of row.fields) {
                        if (f.apiName === apiName) {
                            for (let key in newState) {
                                if (f[key] !== newState[key]) {
                                    f[key] = newState[key];
                                    fieldsChanged = true;
                                }
                            }
                        }
                    }
                    if (fieldsChanged) {
                        row.fields = [...row.fields];
                        rowsChanged = true;
                    }
                }
            }
            if (rowsChanged) {
                sec.rows = [...sec.rows];
                sectionsChanged = true;
            }
        }
        if (sectionsChanged) {
            this.sections = [...this.sections];
        }
    }

    navigateBack() {
        this.dispatchEvent(new CustomEvent('close', { detail: { recordId: null } }));
    }

    closeFormAndNavigate() {
        this.dispatchEvent(new CustomEvent('close', { detail: { recordId: this.savedRecordId } }));
    }

    handleFinish() {
        if (this.savedRecordId) {
            notifyRecordUpdateAvailable([{ recordId: this.savedRecordId }]);
            this.closeFormAndNavigate();
        }
    }

    enterUploadMode() {
        this.evaluateVisibility();
    }

    resetForm() {
        if (!this._cachedMetadata) { window.location.reload(); return; }
        this.isLoading = true; this.savedRecordId = null; this.isSubmitHidden = false; this.sectionData = {};
        this.matrixState = {};
        this.sections = [];
        this._rollbackChildIds = [];
        setTimeout(() => {
            if (this.recordId && this._cachedMetadata) {
                const queryConfig = this.buildQueryConfig(this._cachedMetadata.sections, this._formTargetObject);
                getExistingRecordData({ recordId: this.recordId, objectApiName: this._formTargetObject, queryConfigJson: JSON.stringify(queryConfig) })
                    .then(existingData => { if (existingData) { this.buildForm(this._cachedMetadata.sections, this._formTargetObject, existingData); } else { this.handleCreateMode(this._cachedMetadata); } });
            } else { this.handleCreateMode(this._cachedMetadata); }
        }, 100);
    }

    validateCurrentStep() {
        const inputs = [...this.template.querySelectorAll('lightning-input, lightning-combobox, lightning-textarea, lightning-dual-listbox')];
        let isValid = true;
        let matrixErrorLabel = '';
        let invalidSectionIds = new Set();

        inputs.forEach(input => {
            const secId = input.dataset.secid;
            const apiName = input.dataset.api;
            const rowId = input.dataset.row;

            const sec = this.sections.find(s => s.id === secId);
            if (!sec || !sec.isVisible) return;

            let field = null;
            if (sec.rows) {
                const row = sec.rows.find(r => r.id === rowId);
                if (row) field = row.fields.find(f => f.apiName === apiName);
            }
            if (!field || !field.isVisible) return;

            if (input.type === 'search') {
                const domValue = input.value;
                let internalId = null;
                if (this.sectionData[rowId] && this.sectionData[rowId][apiName]) {
                    internalId = this.sectionData[rowId][apiName];
                }

                if (domValue && domValue.trim().length > 0 && !internalId) {
                    input.setCustomValidity('Please select a valid record from the list.');
                    isValid = false;
                    if (secId) invalidSectionIds.add(secId);
                } else {
                    input.setCustomValidity('');
                }
            }

            if (!input.checkValidity()) {
                isValid = false;
                if (secId) invalidSectionIds.add(secId);
            }
        });

        if (invalidSectionIds.size > 0) {
            for (let sec of this.sections) {
                if (invalidSectionIds.has(sec.id) && !sec.isExpanded && sec.isVisible) {
                    sec.isExpanded = true;
                    sec.sectionClass = 'slds-section slds-is-open slds-m-bottom_medium';
                }
            }
            this.sections = [...this.sections];
        }

        setTimeout(() => {
            const freshInputs = [...this.template.querySelectorAll('lightning-input, lightning-combobox, lightning-textarea, lightning-dual-listbox')];
            freshInputs.forEach(input => {
                const secId = input.dataset.secid;
                const apiName = input.dataset.api;
                const rowId = input.dataset.row;

                const sec = this.sections.find(s => s.id === secId);
                if (!sec || !sec.isVisible) return;

                let field = null;
                if (sec.rows) {
                    const row = sec.rows.find(r => r.id === rowId);
                    if (row) field = row.fields.find(f => f.apiName === apiName);
                }
                if (!field || !field.isVisible) return;

                input.reportValidity();
            });
        }, 100);

        const visibleSections = this.isWizardMode ? (this.sections[this.currentStepIndex] ? [this.sections[this.currentStepIndex]] : []) : this.sections.filter(s => s.isVisible);

        for (const sec of visibleSections) {
            if (sec && sec.isMatrix && sec.isRequired) {
                let hasData = false;
                if (sec.matrixRows) {
                    sec.matrixRows.forEach(r => {
                        r.cells.forEach(c => {
                            if (c.value !== '' && c.value !== null && c.value !== undefined && c.value !== false && c.value !== 'false') {
                                hasData = true;
                            }
                        });
                    });
                }
                if (!hasData) {
                    isValid = false;
                    if (!matrixErrorLabel) matrixErrorLabel = sec.label;
                    invalidSectionIds.add(sec.id);
                }
            }
        }

        if (matrixErrorLabel) {
            for (let sec of this.sections) {
                if (invalidSectionIds.has(sec.id) && !sec.isExpanded && sec.isVisible) {
                    sec.isExpanded = true;
                    sec.sectionClass = 'slds-section slds-is-open slds-m-bottom_medium';
                }
            }
            this.sections = [...this.sections];
            this.showToast('Error', `Please provide at least one entry in the "${matrixErrorLabel}" section.`, 'error');
        } else if (!isValid) {
            this.showToast('Error', 'Please correct the errors on this step.', 'error');
        }

        return isValid;
    }

    handleSubmit(event) {
        if (this.isLoading) return;
        const isQuickFinish = event.target.dataset.mode === 'finish';

        if (!this.validateCurrentStep()) {
            return;
        }

        let firstErrorStepIndex = -1;
        let matrixErrorLabel = '';
        let errorSectionId = null;

        this.sections.forEach((sec, index) => {
            if (!sec.isLogicallyVisible) return;

            if (sec.isMatrix) {
                if (sec.isRequired) {
                    let hasData = false;
                    if (sec.matrixRows) {
                        sec.matrixRows.forEach(r => {
                            r.cells.forEach(c => {
                                if (c.value !== '' && c.value !== null && c.value !== undefined && c.value !== false && c.value !== 'false') {
                                    hasData = true;
                                }
                            });
                        });
                    }
                    if (!hasData) {
                        if (firstErrorStepIndex === -1) {
                            firstErrorStepIndex = index;
                            errorSectionId = sec.id;
                            matrixErrorLabel = sec.label;
                        }
                    }
                }
            }
            else if (sec.isStandardSection && sec.rows) {
                sec.rows.forEach(row => {
                    const rowData = this.sectionData[row.id];
                    row.fields.forEach(field => {
                        if (!field.isVisible) return;

                        const val = rowData[field.apiName];
                        let isEmpty = (val === null || val === undefined || val === '');

                        if (field.isCheckbox && val === false) {
                            isEmpty = true;
                        }

                        if (field.required && isEmpty && !field.isFileUpload && !field.isDisplayText && !field.isHeader) {
                            if (firstErrorStepIndex === -1) {
                                firstErrorStepIndex = index;
                                errorSectionId = sec.id;
                            }
                        }

                        if (field.isLookup) {
                            const text = field.currentValue;
                            if (isEmpty && text && text.trim().length > 0) {
                                if (firstErrorStepIndex === -1) {
                                    firstErrorStepIndex = index;
                                    errorSectionId = sec.id;
                                }
                            }
                        }
                    });
                });
            }
        });

        if (firstErrorStepIndex !== -1) {
            if (this.isWizardMode && this.currentStepIndex !== firstErrorStepIndex) {
                this.currentStepIndex = firstErrorStepIndex;
                this.evaluateVisibility();
            }

            if (errorSectionId) {
                for (let sec of this.sections) {
                    if (sec.id === errorSectionId && !sec.isExpanded) {
                        sec.isExpanded = true;
                        sec.sectionClass = 'slds-section slds-is-open slds-m-bottom_medium';
                    }
                }
                this.sections = [...this.sections];
            }

            setTimeout(() => { this.validateCurrentStep(); }, 100);
            return;
        }

        let primarySections = [];
        let dependentSections = [];
        this.sections.forEach(sec => {
            if (!sec.isLogicallyVisible) return;
            if (sec.parentSectionDevName) { dependentSections.push(sec); } else { primarySections.push(sec); }
        });

        let payload = {};
        let relationshipMap = {};
        const ensurePayloadBucket = (objName, isArray) => { if (!payload[objName]) { payload[objName] = isArray ? [] : {}; } };

        let dynamicRecordsToDelete = [...this._recordsToDelete];

        primarySections.forEach(sec => {
            if (sec.isMatrix) {
                const matrixObjName = sec.objectApiName || 'Form_Matrix_Entry__c';
                ensurePayloadBucket(matrixObjName, true);
                if (sec.relationshipParentField) { relationshipMap[matrixObjName] = sec.relationshipParentField; }
                if (sec.matrixRows) {
                    sec.matrixRows.forEach(r => {
                        r.cells.forEach(c => {
                            if (c.recordId && (c.value === '' || c.value === null || c.value === undefined || c.value === 'false')) {
                                dynamicRecordsToDelete.push(c.recordId);
                            } else if (c.value !== '' && c.value !== null && c.value !== undefined && c.value !== 'false') {
                                payload[matrixObjName].push({
                                    Id: c.recordId, Section_Key__c: sec.developerName,
                                    Row_Key__c: c.rowKey, Column_Key__c: c.colKey, Value__c: c.value
                                });
                            }
                        });
                    });
                }
            } else if (sec.allowMultiple) {
                const objName = sec.targetObject;
                if (sec.relationshipParentField) relationshipMap[objName] = sec.relationshipParentField;
                ensurePayloadBucket(objName, true);
                let sectionPayloads = [];
                if (sec.rows) {
                    sec.rows.forEach(row => {
                        const rowData = { ...this.sectionData[row.id] };
                        let hasUserValue = false;
                        row.fields.forEach(f => {
                            if (!f.isVisible) {
                                delete rowData[f.apiName];
                                return;
                            }
                            const val = rowData[f.apiName];
                            if (!f.saveToDb) { delete rowData[f.apiName]; }
                            else if (val !== null && val !== undefined) {
                                if (val !== '' && val !== false && !f.prepopulate && !f.isFileUpload) { hasUserValue = true; }
                            }
                        });
                        if (hasUserValue || rowData.Id) {
                            row.fields.forEach(f => { if (f.isFileUpload) delete rowData[f.apiName]; });
                            sectionPayloads.push(rowData);
                        }
                    });
                }
                if (sectionPayloads.length > 0) { payload[objName].push(...sectionPayloads); }
            } else if (sec.isStandardSection) {
                if (sec.rows && sec.rows.length > 0) {
                    const row = sec.rows[0];
                    const rowData = this.sectionData[row.id];
                    const sectionTargetObj = sec.targetObject || this._formTargetObject;
                    row.fields.forEach(f => {
                        if (!f.saveToDb || !f.isVisible) return;
                        const targetObj = f.targetObject || this._formTargetObject;
                        const relField = f.parentRelationshipField;
                        if (targetObj !== this._formTargetObject && relField) { relationshipMap[targetObj] = relField; }
                        const val = rowData[f.apiName];
                        if (val !== null && val !== undefined && !f.isFileUpload) {
                            ensurePayloadBucket(targetObj, false);
                            payload[targetObj][f.apiName] = val;

                            if (targetObj !== this._formTargetObject && !payload[targetObj]['Id']) {
                                if (this._serverData && this._serverData.children &&
                                    this._serverData.children[targetObj] &&
                                    this._serverData.children[targetObj].length > 0) {
                                    payload[targetObj]['Id'] = this._serverData.children[targetObj][0].Id;
                                }
                            }
                        }
                    });
                    if (rowData.Id) {
                        ensurePayloadBucket(sectionTargetObj, false);
                        payload[sectionTargetObj]['Id'] = rowData.Id;
                    }
                }
            }
        });

        if (this.recordTypeId && this.objectApiName) {
            if (!payload[this._formTargetObject]) payload[this._formTargetObject] = {};
            if (!Array.isArray(payload[this._formTargetObject])) { payload[this._formTargetObject]['RecordTypeId'] = this.recordTypeId; }
        }

        Object.keys(payload).forEach(key => {
            if (Array.isArray(payload[key])) {
                if (payload[key].length === 0) delete payload[key];
            } else {
                if (key !== this._formTargetObject) {
                    if (!payload[key].Id && !payload[key].id) {
                        let hasRealData = false;
                        for (let fName in payload[key]) {
                            let v = payload[key][fName];
                            if (v !== '' && v !== false && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) {
                                hasRealData = true;
                                break;
                            }
                        }
                        if (!hasRealData) {
                            delete payload[key];
                        }
                    } else if (Object.keys(payload[key]).length === 0) {
                        delete payload[key];
                    }
                }
            }
        });

        const matrixSections = this.sections.filter(sec => sec.isMatrix && sec.parentSectionDevName && sec.isLogicallyVisible);
        for (const matrixSec of matrixSections) {
            const hasMatrixData = matrixSec.matrixRows && matrixSec.matrixRows.some(r => r.cells.some(c => c.value !== '' && c.value !== null && c.value !== undefined && c.value !== false && c.value !== 'false'));
            if (hasMatrixData) {
                const parentSec = this.sections.find(s => s.developerName === matrixSec.parentSectionDevName);
                if (parentSec) {
                    let effectiveTargetObj = parentSec.targetObject || parentSec.objectApiName;

                    if (effectiveTargetObj === this._formTargetObject) {
                        if (parentSec.rows && parentSec.rows.length > 0) {
                            const childField = parentSec.rows[0].fields.find(f => f.targetObject && f.targetObject !== this._formTargetObject);
                            if (childField) {
                                effectiveTargetObj = childField.targetObject;
                            }
                        }
                    }

                    const hasParentData = payload[effectiveTargetObj] !== undefined;

                    let isParentValid = false;
                    if (effectiveTargetObj === this._formTargetObject) {
                        isParentValid = (this.recordId || hasParentData);
                    } else {
                        isParentValid = hasParentData;
                    }

                    if (!isParentValid) {
                        this.showToast('Error', `Cannot save ${matrixSec.label}. Please enter data for the parent record first.`, 'error');
                        return;
                    }
                }
            }
        }

        if (Object.keys(payload).length === 0 && dynamicRecordsToDelete.length === 0) {
            if (dependentSections.length === 0) {
                this.showToast('Error', 'No data found. Please fill in at least one field.', 'error'); return;
            }
        }

        this.isLoading = true;

        saveMultiObject({
            parentObjectApiName: this._formTargetObject,
            payload: payload,
            relationshipMap: relationshipMap,
            recordsToDelete: Array.from(new Set(dynamicRecordsToDelete)),
            saveWithoutSharing: this.saveWithoutSharing
        })
            .then(result => {
                this.savedRecordId = result.parentId;
                this._isSaveCommitted = true;

                if (result.allInsertedChildIds && Array.isArray(result.allInsertedChildIds)) {
                    this._rollbackChildIds = [...this._rollbackChildIds, ...result.allInsertedChildIds];
                }

                const childIdMap = result.childIds || {};

                let phase2Promises = [];
                let sectionsByParent = {};
                dependentSections.forEach(sec => {
                    if (!sectionsByParent[sec.parentSectionDevName]) { sectionsByParent[sec.parentSectionDevName] = []; }
                    sectionsByParent[sec.parentSectionDevName].push(sec);
                });

                Object.keys(sectionsByParent).forEach(parentDevName => {
                    const parentSec = this.sections.find(s => s.developerName === parentDevName);
                    if (!parentSec) return;

                    let targetObj = parentSec.targetObject || parentSec.objectApiName;

                    if (targetObj === this._formTargetObject) {
                        if (parentSec.rows && parentSec.rows.length > 0) {
                            const childField = parentSec.rows[0].fields.find(f => f.targetObject && f.targetObject !== this._formTargetObject);
                            if (childField) {
                                targetObj = childField.targetObject;
                            }
                        }
                    }

                    const newParentId = childIdMap[targetObj] || childIdMap[targetObj.toLowerCase()];

                    if (newParentId) {
                        let batchPayload = {};
                        let batchRelMap = {};
                        let batchRecordsToDelete = [];
                        batchPayload[targetObj] = { Id: newParentId };

                        sectionsByParent[parentDevName].forEach(sec => {
                            if (!sec.isMatrix) return;
                            const matrixObjName = sec.objectApiName || 'Form_Matrix_Entry__c';
                            if (!batchPayload[matrixObjName]) batchPayload[matrixObjName] = [];
                            if (sec.relationshipParentField) { batchRelMap[matrixObjName] = sec.relationshipParentField; }

                            if (sec.matrixRows) {
                                sec.matrixRows.forEach(r => {
                                    r.cells.forEach(c => {
                                        if (c.recordId && (c.value === '' || c.value === null || c.value === undefined || c.value === 'false')) {
                                            batchRecordsToDelete.push(c.recordId);
                                        }
                                        else if (c.value !== '' && c.value !== null && c.value !== undefined && c.value !== 'false') {
                                            let record = {
                                                Id: c.recordId, Section_Key__c: sec.developerName,
                                                Row_Key__c: c.rowKey, Column_Key__c: c.colKey, Value__c: c.value
                                            };
                                            if (sec.relationshipParentField) { record[sec.relationshipParentField] = newParentId; }
                                            batchPayload[matrixObjName].push(record);
                                        }
                                    });
                                });
                            }
                        });

                        if (Object.keys(batchPayload).length > 1 || batchRecordsToDelete.length > 0) {
                            phase2Promises.push(
                                saveMultiObject({
                                    parentObjectApiName: targetObj,
                                    payload: batchPayload,
                                    relationshipMap: batchRelMap,
                                    recordsToDelete: Array.from(new Set(batchRecordsToDelete)),
                                    saveWithoutSharing: this.saveWithoutSharing
                                })
                            );
                        }
                    }
                });
                return Promise.all(phase2Promises);
            })
            .then((phase2Results) => {
                if (phase2Results && phase2Results.length > 0) {
                    phase2Results.forEach(res => {
                        if (res && res.allInsertedChildIds && Array.isArray(res.allInsertedChildIds)) {
                            this._rollbackChildIds = [...this._rollbackChildIds, ...res.allInsertedChildIds];
                        }
                    });
                }

                this.isLoading = false;
                notifyRecordUpdateAvailable([{ recordId: this.savedRecordId }]);

                if (this.isEditMode || isQuickFinish) {
                    this.showToast('Success', this.labels.msgRecordSaved, 'success');
                    this.closeFormAndNavigate();
                } else {
                    this.isSubmitHidden = true;
                    this.enterUploadMode();
                    this.showToast('Success', this.labels.msgRecordSavedUpload, 'success');
                }
            })
            .catch(error => {
                console.error('Submission Error:', error);

                if (!this.isEditMode && this.savedRecordId && this._isSaveCommitted) {
                    this.isLoading = true;
                    rollbackTransaction({
                        recordId: this.savedRecordId,
                        childIds: this._rollbackChildIds,
                        saveWithoutSharing: this.saveWithoutSharing
                    })
                        .then(() => {
                            this.showToast('Error', 'Submission failed. Record rolled back.', 'error');
                            this.savedRecordId = null;
                            this._isSaveCommitted = false;
                        })
                        .catch(delErr => {
                            this.showToast('Error', 'Submission failed and rollback failed. Please contact admin.', 'error');
                        })
                        .finally(() => {
                            this.isLoading = false;
                        });
                } else {
                    let msg = error.body ? error.body.message : error.message;
                    this.showToast('Error', msg, 'error');
                    this.isLoading = false;
                }
            });
    }
}