import { LightningElement, api, wire } from 'lwc';
import { CloseActionScreenEvent } from 'lightning/actions';
import { getRecord } from 'lightning/uiRecordApi';

export default class CaseEditWrapper extends LightningElement {
    @api recordId;
    @api objectApiName;
    
    // Natively fetch the RecordTypeId using the Lightning Data Service
    @wire(getRecord, { recordId: '$recordId', layoutTypes: ['Compact'] })
    caseRecord;

    get activeRecordTypeId() {
        return this.caseRecord?.data?.recordTypeId || '';
    }

    get isReady() {
        // Only load the form once LDS has returned the record context
        return this.caseRecord && (this.caseRecord.data || this.caseRecord.error);
    }

    handleClose() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }
}