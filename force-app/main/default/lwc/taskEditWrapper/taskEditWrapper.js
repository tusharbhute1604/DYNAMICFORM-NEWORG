import { LightningElement, api, wire } from 'lwc';
import { getRecord } from 'lightning/uiRecordApi';

export default class TaskEditWrapper extends LightningElement {
    @api recordId;
    @api objectApiName = 'Task'; // Provide a default fallback for the Aura context
    
    // Natively fetch the RecordTypeId using the Lightning Data Service
    @wire(getRecord, { recordId: '$recordId', layoutTypes: ['Compact'] })
    taskRecord;

    get activeRecordTypeId() {
        return this.taskRecord?.data?.recordTypeId || '';
    }

    get isReady() {
        // Only load the form once LDS has returned the record context
        return !!this.taskRecord && (!!this.taskRecord.data || !!this.taskRecord.error);
    }

    handleClose() {
        // Dispatch a standard custom event instead of CloseActionScreenEvent
        // This decouples the LWC from the specific quick action framework, 
        // adhering to the Dependency Inversion Principle.
        this.dispatchEvent(new CustomEvent('closeaction'));
    }
}