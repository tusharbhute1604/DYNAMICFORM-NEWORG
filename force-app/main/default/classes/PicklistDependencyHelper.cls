public with sharing class PicklistDependencyHelper {
    public static Map<String, List<Map<String, String>>> getSerializedDependencyMap(Schema.SObjectField dependentField) {
        Map<String, List<Map<String, String>>> results = new Map<String, List<Map<String, String>>>();
        Schema.DescribeFieldResult depRes = dependentField.getDescribe();
        Schema.SObjectField ctrlField = depRes.getController();
        if (ctrlField == null) return results;

        List<Schema.PicklistEntry> ctrlEntries = ctrlField.getDescribe().getPicklistValues();
        List<Schema.PicklistEntry> depEntries = depRes.getPicklistValues();

        for (Schema.PicklistEntry ctrl : ctrlEntries) {
            results.put(ctrl.getValue(), new List<Map<String, String>>());
        }

        for (Schema.PicklistEntry dep : depEntries) {
            // Access validFor hidden property via serialization to decode dependency
            Map<String,Object> depJson = (Map<String,Object>)JSON.deserializeUntyped(JSON.serialize(dep));
            String validFor = (String)depJson.get('validFor');
            
            if (String.isNotBlank(validFor)) {
                List<Integer> base64indexes = getBase64Indexes(validFor);
                for (Integer idx : base64indexes) {
                    if (idx < ctrlEntries.size()) {
                        String ctrlValue = ctrlEntries[idx].getValue();
                        results.get(ctrlValue).add(new Map<String, String>{
                            'label' => dep.getLabel(), 'value' => dep.getValue()
                        });
                    }
                }
            }
        }
        return results;
    }

    private static List<Integer> getBase64Indexes(String validFor) {
        String base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        List<Integer> indexes = new List<Integer>();
        for (Integer i = 0; i < validFor.length(); i++) {
            Integer val = base64Chars.indexOf(validFor.substring(i, i + 1));
            for (Integer bit = 5; bit >= 0; bit--) {
                if (((val >> bit) & 1) == 1) indexes.add((i * 6) + (5 - bit));
            }
        }
        return indexes;
    }
}