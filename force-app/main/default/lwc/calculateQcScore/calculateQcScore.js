import { LightningElement, api } from 'lwc';
import { CloseActionScreenEvent } from 'lightning/actions';

export default class CalculateQcScore extends LightningElement {
    @api recordId;
    @api objectApiName;

    handleClose() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }
}