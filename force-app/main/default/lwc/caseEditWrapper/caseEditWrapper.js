import { LightningElement, api } from 'lwc';
import { CloseActionScreenEvent } from 'lightning/actions';

export default class CaseEditWrapper extends LightningElement {
    @api recordId;
    @api objectApiName;

    handleClose() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }
}