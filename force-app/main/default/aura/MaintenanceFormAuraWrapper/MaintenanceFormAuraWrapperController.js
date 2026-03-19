({
    doInit : function(component, event, helper) {
        var urlParams = new URLSearchParams(window.location.search);
        var recId = urlParams.get('c__recordId');
        var recTypeId = urlParams.get('c__recordTypeId');
        
        if (recId) { component.set("v.recordId", recId); }
        if (recTypeId) { component.set("v.recordTypeId", recTypeId); }
    },
    
    handleClose : function(component, event, helper) {
        var workspaceAPI = component.find("workspace");
        
        workspaceAPI.isConsoleNavigation().then(function(isConsole) {
            if (isConsole) {
                // Console App: Explicitly close the tab
                workspaceAPI.getFocusedTabInfo().then(function(response) {
                    workspaceAPI.closeTab({tabId: response.tabId});
                }).catch(function(error) {
                    console.error('Aura Close Tab Error:', error);
                });
            }
            // Notice: We removed the 'else' block entirely.
            // The LWC will handle Standard App cleanup via "replace: true" navigation.
        }).catch(function(err) {
            console.error('Console Check Error:', err);
        });
    }
})