import { LightningElement, api } from 'lwc';
import { CloseActionScreenEvent } from 'lightning/actions';
import { NavigationMixin } from 'lightning/navigation';

export default class CaseCreateWrapper extends NavigationMixin(LightningElement) {
    @api recordId;
    @api objectApiName;
    @api recordTypeId;
    
    // Flag to determine if running in Visualforce/Lightning Out
    // Defaults to false (Standard/Quick Action mode)
    @api isLightningOut = false;

    handleClose(event) {
        // Grab the ID passed up from the dynamic form
        const savedId = event.detail ? event.detail.recordId : null;

        // 1. Fire close event to the Visualforce Page (for Console/Tab fix)
        // CRITICAL: bubbles & composed required to cross Shadow DOM to VF Container
        this.dispatchEvent(new CustomEvent('close', { 
            detail: { recordId: savedId },
            bubbles: true,
            composed: true
        }));

        // 2. Handle Quick Action Navigation
        // (Note: This call is usually ignored by Lightning Out/VF, but works in Quick Actions)
        if (savedId) {
            this[NavigationMixin.Navigate]({
                type: 'standard__recordPage',
                attributes: {
                    recordId: savedId,
                    actionName: 'view'
                }
            });
        }

        // 3. Close the Quick Action Modal
        this.dispatchEvent(new CloseActionScreenEvent());
    }
}