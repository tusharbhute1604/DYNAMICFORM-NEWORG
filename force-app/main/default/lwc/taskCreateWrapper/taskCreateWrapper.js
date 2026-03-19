import { LightningElement, api } from 'lwc';
import { CloseActionScreenEvent } from 'lightning/actions';

export default class CaseCreateWrapper extends LightningElement {
    @api recordId;
    @api objectApiName;

    handleClose() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }
}