({
    closeModal : function(component, event, helper) {
        // Intercept the LWC custom event and fire the native Aura close event
        var dismissActionPanel = $A.get("e.force:closeQuickAction");
        if(dismissActionPanel){
            dismissActionPanel.fire();
        }
        
        // Ensure the underlying record page refreshes to reflect any changes 
        // made by your c-dynamic-record-form
        $A.get('e.force:refreshView').fire();
    }
})