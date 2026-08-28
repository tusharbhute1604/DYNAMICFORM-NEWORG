public with sharing class DynamicFormController {

    public class FormWrapper {
        @AuraEnabled public String objectApiName;
        @AuraEnabled public String formTitle;
        @AuraEnabled public String formIcon;
        @AuraEnabled public String formInstructions;
        @AuraEnabled public String buttonConfig; 
        @AuraEnabled public String currentUserId;
        @AuraEnabled public String currentUserName;
        @AuraEnabled public String displayMode; 
        @AuraEnabled public Boolean saveWithoutSharing; 
        @AuraEnabled public List<SectionWrapper> sections = new List<SectionWrapper>();
    }

    public class SectionWrapper {
        @AuraEnabled public String id;
        @AuraEnabled public String developerName;
        @AuraEnabled public String label;
        @AuraEnabled public Integer order;
        @AuraEnabled public String objectApiName; 
        @AuraEnabled public String relationshipParentField; 
        @AuraEnabled public Boolean allowMultipleRows;
        @AuraEnabled public String visibilityLogic; 
        @AuraEnabled public Integer numColumns; 
        @AuraEnabled public String customComponentName;
        @AuraEnabled public String showOn;
        @AuraEnabled public Boolean isRequired; 
        @AuraEnabled public Boolean isCollapsed; 
        
        @AuraEnabled public String renderAs;
        @AuraEnabled public String sectionConfig;
        @AuraEnabled public String parentSectionDevName;

        @AuraEnabled public List<FieldWrapper> fields = new List<FieldWrapper>();
    }

    public class FieldWrapper {
        @AuraEnabled public String label;
        @AuraEnabled public String apiName;
        @AuraEnabled public String type;
        @AuraEnabled public String htmlContent;
        @AuraEnabled public Boolean required;
        @AuraEnabled public String requiredLogic; 
        @AuraEnabled public String visibilityLogic;
        @AuraEnabled public String controllerField;
        @AuraEnabled public String controllingLookup; 
        @AuraEnabled public String lookupTargetObject;
        @AuraEnabled public String lookupSearchField;
        @AuraEnabled public List<Map<String, String>> picklistOptions;
        @AuraEnabled public Map<String, List<Map<String, String>>> dependencyMap;
        @AuraEnabled public String overridePicklistValues; 
        @AuraEnabled public Boolean prepopulate;
        @AuraEnabled public Boolean readOnly; 
        @AuraEnabled public String keyPrefix;
        @AuraEnabled public String sourceFieldApiName;
        @AuraEnabled public Boolean excludeFromDb; 
        @AuraEnabled public Boolean fetchOnEdit;
        @AuraEnabled public String targetObject; 
        @AuraEnabled public String parentRelationshipField; 
        @AuraEnabled public String helpText;
        @AuraEnabled public String defaultValue; 
        @AuraEnabled public String formulaLogic; 
        @AuraEnabled public Boolean saveToDb; 
        @AuraEnabled public String dynamicSoql; 
    }

    public class LookupRecordDetails {
        @AuraEnabled public String id;
        @AuraEnabled public String label;
        @AuraEnabled public String details; 
    }

    @AuraEnabled(cacheable=true)
    public static FormWrapper getFormMetadata(String formDeveloperName, String recordTypeId) {
        FormWrapper form = new FormWrapper();
        try {
            Form_Config__mdt config = [
                SELECT Id, Object_API_Name__c, Active__c, Form_Title__c, Form_Icon__c, 
                       Display_Mode__c, Form_Instructions__c, Button_Config_JSON__c, Save_Without_Sharing__c
                FROM Form_Config__mdt 
                WHERE DeveloperName = :formDeveloperName 
                LIMIT 1
            ];

            if (config.Active__c == false) {
                throw new AuraHandledException('This form is currently inactive.');
            }

            form.objectApiName = config.Object_API_Name__c;
            form.formTitle = String.isNotBlank(config.Form_Title__c) ? config.Form_Title__c : 'Dynamic Form';
            form.formIcon = String.isNotBlank(config.Form_Icon__c) ? config.Form_Icon__c : 'standard:record';
            form.displayMode = String.isNotBlank(config.Display_Mode__c) ? config.Display_Mode__c : 'Single Page';
            form.formInstructions = config.Form_Instructions__c;
            form.buttonConfig = config.Button_Config_JSON__c;
            form.saveWithoutSharing = config.Save_Without_Sharing__c == true; 
            
            form.currentUserId = UserInfo.getUserId();
            form.currentUserName = UserInfo.getName();

            List<Form_Section__mdt> sectionRecords = [
                SELECT Id, DeveloperName, Label, Order__c, Object_API_Name__c, Relationship_Parent_Field__c, 
                       Allow_Multiple_Rows__c, Visibility_Logic__c, Number_of_Columns__c,
                       Custom_Component_Name__c, Show_On__c, Is_Required__c, Override_Label__c,
                       Collapse_by_Default__c,
                       Render_As__c, Section_Config_JSON__c, Parent_Section_DeveloperName__c
                FROM Form_Section__mdt 
                WHERE Form_Config__c = :config.Id 
                ORDER BY Order__c ASC
            ];
            
            List<Form_Field__mdt> allFields = [
                SELECT Id, Label, Field_API_Name__c, Field_Type__c, Required__c, Order__c, 
                       Visibility_Logic__c, Required_Logic__c, Controller_Field__c, Controlling_Lookup__c, Form_Section__c, 
                       Lookup_Target_Object__c, Lookup_Search_Field__c,
                       Override_Picklist_Values__c, Override_Dependency_JSON__c,
                       Prepopulate__c, Read_Only__c, Key_Prefix__c,
                       Source_Field_API_Name__c, Fetch_On_Edit__c, Override_Label__c,
                       Target_Object_API_Name__c, Target_Object_Parent_Field__c,
                       Help_Text__c, HTML_Content__c, Dynamic_SOQL__c,
                       Default_Value__c, Formula_Logic__c, Save_To_Database__c
                FROM Form_Field__mdt 
                WHERE Form_Section__r.Form_Config__r.DeveloperName = :formDeveloperName 
                ORDER BY Order__c ASC NULLS LAST
            ];

            Map<String, SObjectField> mainDescribeMap = new Map<String, SObjectField>();
            Schema.SObjectType mainToken = Schema.getGlobalDescribe().get(config.Object_API_Name__c);
            if (mainToken != null) {
                mainDescribeMap = mainToken.getDescribe().fields.getMap();
            }

            Map<String, Map<String, SObjectField>> childDescribeCache = new Map<String, Map<String, SObjectField>>();

            for (Form_Section__mdt sec : sectionRecords) {
                SectionWrapper sw = new SectionWrapper();
                sw.id = sec.Id;
                sw.developerName = sec.DeveloperName;
                sw.label = String.isNotBlank(sec.Override_Label__c) ? sec.Override_Label__c : sec.Label;
                sw.order = (Integer)sec.Order__c;
                sw.objectApiName = sec.Object_API_Name__c;
                sw.relationshipParentField = sec.Relationship_Parent_Field__c; 
                sw.allowMultipleRows = sec.Allow_Multiple_Rows__c;
                sw.visibilityLogic = sec.Visibility_Logic__c;
                sw.numColumns = (sec.Number_of_Columns__c != null) ? (Integer)sec.Number_of_Columns__c : 2;
                sw.customComponentName = sec.Custom_Component_Name__c;
                sw.showOn = sec.Show_On__c;
                sw.isRequired = sec.Is_Required__c == true; 
                sw.isCollapsed = sec.Collapse_by_Default__c == true; 
                
                sw.renderAs = sec.Render_As__c;
                sw.sectionConfig = sec.Section_Config_JSON__c;
                sw.parentSectionDevName = sec.Parent_Section_DeveloperName__c;
                
                sw.fields = new List<FieldWrapper>();

                for (Form_Field__mdt f : allFields) {
                    if (f.Form_Section__c == sec.Id) {
                        FieldWrapper fw = new FieldWrapper();
                        
                        fw.label = String.isNotBlank(f.Override_Label__c) ? f.Override_Label__c : f.Label;
                        fw.helpText = f.Help_Text__c; 
                        fw.defaultValue = f.Default_Value__c;
                        fw.formulaLogic = f.Formula_Logic__c;
                        fw.htmlContent = f.HTML_Content__c; 
                        fw.saveToDb = (f.Save_To_Database__c != false); 
                        fw.type = f.Field_Type__c;
                        fw.required = f.Required__c;
                        fw.requiredLogic = f.Required_Logic__c; 
                        fw.visibilityLogic = f.Visibility_Logic__c;
                        fw.controllerField = f.Controller_Field__c;
                        fw.controllingLookup = f.Controlling_Lookup__c; 
                        fw.lookupTargetObject = f.Lookup_Target_Object__c;
                        fw.lookupSearchField = f.Lookup_Search_Field__c;
                        fw.overridePicklistValues = f.Override_Picklist_Values__c;
                        fw.prepopulate = f.Prepopulate__c; 
                        fw.readOnly = f.Read_Only__c;
                        fw.keyPrefix = f.Key_Prefix__c;
                        fw.sourceFieldApiName = f.Source_Field_API_Name__c;
                        fw.fetchOnEdit = f.Fetch_On_Edit__c;
                        fw.dynamicSoql = f.Dynamic_SOQL__c;
                        
                        if (String.isNotBlank(f.Target_Object_API_Name__c)) {
                            fw.targetObject = f.Target_Object_API_Name__c;
                            fw.parentRelationshipField = f.Target_Object_Parent_Field__c;
                        } else {
                            fw.targetObject = sec.Object_API_Name__c;
                            fw.parentRelationshipField = sec.Relationship_Parent_Field__c;
                        }

                        if (String.isNotBlank(f.Field_API_Name__c)) {
                            fw.apiName = f.Field_API_Name__c;
                            if (f.Save_To_Database__c == false) {
                                fw.excludeFromDb = true;
                            } else {
                                fw.excludeFromDb = false;
                            }
                        } else {
                            fw.apiName = 'UI_ONLY_' + f.Id;
                            fw.excludeFromDb = true;
                            fw.saveToDb = false; 
                        }
                        
                        String typeLower = (f.Field_Type__c != null) ? f.Field_Type__c.toLowerCase() : '';
                        if (typeLower == 'display text' || typeLower == 'rich text') {
                            fw.excludeFromDb = true;
                            fw.saveToDb = false;
                        }
                        
                        fw.picklistOptions = new List<Map<String, String>>();
                        fw.dependencyMap = new Map<String, List<Map<String, String>>>();
                        
                        if (!fw.excludeFromDb && (typeLower.contains('picklist') || typeLower.contains('multi'))) {
                            Map<String, SObjectField> targetMap = null;
                            if (fw.targetObject == config.Object_API_Name__c) {
                                targetMap = mainDescribeMap;
                            } else if (String.isNotBlank(fw.targetObject)) {
                                if (childDescribeCache.containsKey(fw.targetObject)) {
                                    targetMap = childDescribeCache.get(fw.targetObject);
                                } else {
                                    Schema.SObjectType childToken = Schema.getGlobalDescribe().get(fw.targetObject);
                                    if (childToken != null) {
                                        targetMap = childToken.getDescribe().fields.getMap();
                                        childDescribeCache.put(fw.targetObject, targetMap);
                                    }
                                }
                            }
                            if (targetMap != null) {
                                processPicklistLogic(f, fw, targetMap, recordTypeId, config.Object_API_Name__c);
                            }
                        }
                        else if (fw.excludeFromDb && (typeLower.contains('picklist') || typeLower.contains('multi'))) {
                             if (String.isNotBlank(f.Override_Picklist_Values__c)) {
                                for (String val : f.Override_Picklist_Values__c.split(',')) {
                                    fw.picklistOptions.add(new Map<String, String>{'label'=>val.trim(), 'value'=>val.trim()});
                                }
                            }
                        }
                        sw.fields.add(fw);
                    }
                }
                form.sections.add(sw);
            }
        } catch (Exception e) { 
            throw new AuraHandledException(getCleanErrorMessage(e)); 
        }
        return form;
    }

    @AuraEnabled
    public static SObject executeDynamicQuery(String soqlQuery, Map<String, Object> bindParams) {
        try {
            if (String.isBlank(soqlQuery)) return null;
            if (!soqlQuery.toLowerCase().contains('limit 1')) soqlQuery += ' LIMIT 1';
            
            List<SObject> results = Database.queryWithBinds(soqlQuery, bindParams, AccessLevel.SYSTEM_MODE);
            if (!results.isEmpty()) return results[0];
            return null;
        } catch (Exception e) {
            return null; 
        }
    }

    @AuraEnabled(cacheable=true)
    public static List<Map<String, String>> searchRecords(String searchTerm, String objectApiName, String searchFields) {
        try {
            List<String> fieldList = searchFields.split(',');
            for (Integer i = 0; i < fieldList.size(); i++) { fieldList[i] = fieldList[i].trim(); }
            String fieldsCsv = String.join(fieldList, ', ');

            // SOSL leverages the Salesforce search index instead of a full table scan,
            // which is what a leading-wildcard SOQL LIKE '%term%' forces on large objects.
            String soslTerm = escapeSoslReservedChars(searchTerm) + '*';

            // FIND matches on ANY field on the object, not just fieldList (e.g. a term
            // appearing in Description would match when searching CaseNumber). This WHERE
            // re-filters the FIND-matched candidates down to the configured fields; it's cheap
            // because it only runs against the already-narrowed SOSL match set, not a full scan.
            String likeValue = '%' + String.escapeSingleQuotes(searchTerm) + '%';
            List<String> likeConditions = new List<String>();
            for (String fName : fieldList) {
                likeConditions.add(fName + ' LIKE \'' + likeValue + '\'');
            }
            String whereClause = '(' + String.join(likeConditions, ' OR ') + ')';
            // Standard User lookups exclude inactive users by default; SOSL has no equivalent
            // built in, so enforce it explicitly to match standard lookup behavior.
            if (objectApiName.equalsIgnoreCase('User')) {
                whereClause += ' AND IsActive = true';
            }

            String sosl = 'FIND \'' + soslTerm + '\' IN ALL FIELDS RETURNING ' +
                String.escapeSingleQuotes(objectApiName) + '(Id, ' + String.escapeSingleQuotes(fieldsCsv) +
                ' WHERE ' + whereClause + ' LIMIT 10)';

            List<List<SObject>> searchResults = Search.query(sosl);
            List<SObject> records = searchResults.isEmpty() ? new List<SObject>() : searchResults[0];
            List<Map<String, String>> results = new List<Map<String, String>>();
            String primaryField = fieldList[0].trim();
            String secondaryField = (fieldList.size() > 1) ? fieldList[1].trim() : null;
            for (SObject rec : records) {
                String labelVal = (String)rec.get(primaryField);
                String metaVal = '';
                String detailsVal = '';
                if (secondaryField != null) {
                    try { 
                        Object val = rec.get(secondaryField); 
                        if (val != null) metaVal = String.valueOf(val); 
                    } catch (Exception e) { metaVal = ''; }
                }
                if (fieldList.size() > 1) {
                    List<String> detailLines = new List<String>();
                    for (Integer i = 1; i < fieldList.size(); i++) {
                        String fName = fieldList[i].trim();
                        try { 
                            Object val = rec.get(fName); 
                            String displayVal = (val != null) ? String.valueOf(val) : ''; 
                            detailLines.add(fName + ': ' + displayVal); 
                        } catch (Exception e) {}
                    }
                    if (!detailLines.isEmpty()) detailsVal = String.join(detailLines, '\n');
                }
                results.add(new Map<String, String>{'id' => (String)rec.get('Id'), 'label' => labelVal, 'meta' => metaVal, 'details' => detailsVal});
            }
            return results;
        } catch (Exception e) { 
            throw new AuraHandledException(getCleanErrorMessage(e)); 
        }
    }

    @AuraEnabled(cacheable=true)
    public static LookupRecordDetails getRecordDetails(String recordId, String objectApiName, String searchFields) {
        LookupRecordDetails result = new LookupRecordDetails();
        if (String.isBlank(recordId)) {
            return result;
        }
        try {
            // --- NEW: Self-Healing Object & Field Resolution ---
            // If the CMDT is missing the target object, dynamically resolve it from the ID
            if (String.isBlank(objectApiName) || objectApiName == 'null' || objectApiName == 'undefined') {
                Id recId = (Id)recordId;
                objectApiName = recId.getSObjectType().getDescribe().getName();
            }
            
            if (String.isBlank(searchFields) || searchFields == 'null' || searchFields == 'undefined') {
                searchFields = 'Name';
            }
            
            // Edge case safeguard: Case object does not have a standard 'Name' field
            if (objectApiName.equalsIgnoreCase('Case') && searchFields.equalsIgnoreCase('Name')) {
                searchFields = 'CaseNumber';
            }
            // ---------------------------------------------------

            List<String> fieldList = searchFields.split(',');
            String query = 'SELECT ' + String.escapeSingleQuotes(searchFields) + ' FROM ' + String.escapeSingleQuotes(objectApiName) + ' WHERE Id = :recordId LIMIT 1';
            SObject rec = Database.query(query);
            
            String primaryField = fieldList[0].trim();
            result.id = recordId;
            result.label = (String)rec.get(primaryField);
            
            if (fieldList.size() > 1) {
                List<String> detailLines = new List<String>();
                for (Integer i = 1; i < fieldList.size(); i++) {
                    String fName = fieldList[i].trim();
                    try { 
                        Object val = rec.get(fName); 
                        String displayVal = (val != null) ? String.valueOf(val) : ''; 
                        detailLines.add(fName + ': ' + displayVal); 
                    } catch (Exception e) {}
                }
                if (!detailLines.isEmpty()) {
                    result.details = String.join(detailLines, '\n');
                }
            }
        } catch (Exception e) { 
            // Fallback: If query fails, output the raw ID to prevent UI crashing
            result.id = recordId; 
            result.label = recordId; 
            System.debug('getRecordDetails Error: ' + e.getMessage());
        }
        return result;
    }

    @AuraEnabled
    public static Map<String, Map<String, Object>> getSourceRecordData(String sourceRecordId, List<String> sourceFields) {
        Map<String, Map<String, Object>> result = new Map<String, Map<String, Object>>();
        if (String.isBlank(sourceRecordId) || sourceFields == null || sourceFields.isEmpty()) return result;
        try {
            String cleanId = sourceRecordId.replaceAll('[^a-zA-Z0-9]', '');
            if (cleanId.length() < 15) return result;
            Id recId = (Id)cleanId;
            
            Schema.SObjectType sType = recId.getSObjectType();
            if (sType == null) return result;
            
            String objName = sType.getDescribe().getName();
            Map<String, SObjectField> rawFieldMap = sType.getDescribe().fields.getMap();
            Map<String, SObjectField> lowerFieldMap = new Map<String, SObjectField>();
            for(String key : rawFieldMap.keySet()) lowerFieldMap.put(key.toLowerCase(), rawFieldMap.get(key));
            
            Set<String> queryFields = new Set<String>();
            Map<String, String> relationMap = new Map<String, String>();
            for(String f : sourceFields) {
                String fLower = f.toLowerCase();
                if(lowerFieldMap.containsKey(fLower)) {
                    SObjectField token = lowerFieldMap.get(fLower);
                    String realApiName = token.getDescribe().getName();
                    queryFields.add(realApiName);
                    DescribeFieldResult dfr = token.getDescribe();
                    if(dfr.getType() == Schema.DisplayType.REFERENCE) { 
                        String relName = dfr.getRelationshipName(); 
                        if(relName != null) { 
                            String nameField = 'Name'; 
                            String path = relName + '.' + nameField; 
                            relationMap.put(f, path); 
                            queryFields.add(path); 
                        } 
                    }
                }
            }
            if(queryFields.isEmpty()) return result;
            
            String q = 'SELECT ' + String.join(new List<String>(queryFields), ',') + ' FROM ' + String.escapeSingleQuotes(objName) + ' WHERE Id = :recId LIMIT 1';
            List<SObject> records = Database.query(q);
            if(records.isEmpty()) return result;
            SObject res = records[0];
            
            for(String f : sourceFields) {
                String fLower = f.toLowerCase();
                if (!lowerFieldMap.containsKey(fLower)) continue;
                String realApiName = lowerFieldMap.get(fLower).getDescribe().getName();
                Map<String, Object> data = new Map<String, Object>();
                Object val = res.get(realApiName);
                data.put('value', val);
                
                if(relationMap.containsKey(f)) {
                    String path = relationMap.get(f);
                    List<String> parts = path.split('\\.');
                    SObject temp = res;
                    Boolean safe = true;
                    for(Integer i=0; i<parts.size()-1; i++) { 
                        temp = temp.getSObject(parts[i]); 
                        if(temp == null) { safe = false; break; } 
                    }
                    if(safe && temp.get(parts[parts.size()-1]) != null) {
                        data.put('label', temp.get(parts[parts.size()-1])); 
                    } else {
                        data.put('label', val); 
                    }
                } else {
                    data.put('label', val); 
                }
                result.put(f, data);
            }
        } catch (Exception e) { 
            System.debug('Error in getSourceRecordData: ' + e.getMessage()); 
        }
        return result;
    }

    @AuraEnabled
    public static Map<String, Object> getExistingRecordData(String recordId, String objectApiName, String queryConfigJson) {
        if (String.isBlank(recordId) || String.isBlank(objectApiName) || String.isBlank(queryConfigJson)) return null;
        Map<String, Object> response = new Map<String, Object>();
        try {
            Map<String, Object> config = (Map<String, Object>)JSON.deserializeUntyped(queryConfigJson);
            Set<String> parentFields = new Set<String>{'Id'};
            Map<String, String> parentLookupMap = new Map<String, String>(); 
            List<Object> parentFieldsConfig = (List<Object>)config.get('parentFields');
            
            if (parentFieldsConfig != null) {
                for(Object o : parentFieldsConfig) {
                    Map<String, Object> fMap = (Map<String, Object>)o;
                    String api = (String)fMap.get('api');
                    String type = (String)fMap.get('type');
                    String search = (String)fMap.get('search');
                    parentFields.add(api);
                    if (type == 'Lookup' && String.isNotBlank(search)) { 
                        String relField = getRelationshipField(api); 
                        String firstSearchField = search.split(',')[0].trim(); 
                        if (api.equalsIgnoreCase('WhatId') || api.equalsIgnoreCase('WhoId') || api.equalsIgnoreCase('OwnerId')) {
                            firstSearchField = 'Name';
                        }
                        String path = relField + '.' + firstSearchField; 
                        parentFields.add(path); 
                        parentLookupMap.put(api, path); 
                    }
                }
            }
            String parentQuery = 'SELECT ' + String.join(new List<String>(parentFields), ',') + ' FROM ' + String.escapeSingleQuotes(objectApiName) + ' WHERE Id = :recordId LIMIT 1';
            List<SObject> parentList = Database.query(parentQuery);
            if (parentList.isEmpty()) return null;
            
            response.put('parent', processRecord(parentList[0], parentLookupMap));
            
            Map<String, List<Map<String, Object>>> childData = new Map<String, List<Map<String, Object>>>();
            List<Object> childrenConfig = (List<Object>)config.get('children');
            
            if (childrenConfig != null) {
                for (Object item : childrenConfig) {
                    Map<String, Object> childMap = (Map<String, Object>)item;
                    String childObj = (String)childMap.get('objectApiName');
                    String parentField = (String)childMap.get('parentField');
                    List<Object> fieldsList = (List<Object>)childMap.get('fields');
                    
                    if (String.isBlank(childObj) || String.isBlank(parentField)) continue;
                    
                    Set<String> cFields = new Set<String>{'Id'};
                    Map<String, String> childLookupMap = new Map<String, String>();
                    if (fieldsList != null) {
                        for(Object o : fieldsList) {
                            Map<String, Object> fMap = (Map<String, Object>)o;
                            String api = (String)fMap.get('api');
                            String type = (String)fMap.get('type');
                            String search = (String)fMap.get('search');
                            cFields.add(api);
                            if (type == 'Lookup' && String.isNotBlank(search)) { 
                                String relField = getRelationshipField(api); 
                                String firstSearchField = search.split(',')[0].trim(); 
                                if (api.equalsIgnoreCase('WhatId') || api.equalsIgnoreCase('WhoId') || api.equalsIgnoreCase('OwnerId')) {
                                    firstSearchField = 'Name';
                                }
                                String path = relField + '.' + firstSearchField; 
                                cFields.add(path); 
                                childLookupMap.put(api, path); 
                            }
                        }
                    }
                    
                    String childQuery = 'SELECT ' + String.join(new List<String>(cFields), ',') + ' FROM ' + String.escapeSingleQuotes(childObj) + ' WHERE ' + String.escapeSingleQuotes(parentField) + ' = :recordId LIMIT 100';
                    List<SObject> records = Database.query(childQuery);
                    List<Map<String, Object>> processedChildren = new List<Map<String, Object>>();
                    for(SObject rec : records) processedChildren.add(processRecord(rec, childLookupMap));
                    
                    if (childData.containsKey(childObj)) childData.get(childObj).addAll(processedChildren);
                    else childData.put(childObj, processedChildren);
                }
            }
            response.put('children', childData);
            return response;
        } catch (Exception e) { 
            throw new AuraHandledException(getCleanErrorMessage(e)); 
        }
    }

    @AuraEnabled
    public static Map<String, Object> saveMultiObject(
        String parentObjectApiName, 
        Map<String, Object> payload, 
        Map<String, Object> relationshipMap, 
        List<String> recordsToDelete,
        Boolean saveWithoutSharing) {
        
        Savepoint sp = Database.setSavepoint();
        Map<String, Object> response = new Map<String, Object>();
        SystemModeDML sysDml = new SystemModeDML(); 
        
        try {
            if (String.isBlank(parentObjectApiName) || payload == null) {
                throw new AuraHandledException('Missing required data for save.');
            }

            if (recordsToDelete != null && !recordsToDelete.isEmpty()) {
                Map<Schema.SObjectType, List<Id>> idsByType = new Map<Schema.SObjectType, List<Id>>();
                for (String rid : recordsToDelete) { 
                    if (String.isNotBlank(rid)) {
                        String cleanId = rid.replaceAll('[^a-zA-Z0-9]', '');
                        if (cleanId.length() >= 15) {
                            try {
                                Id recId = (Id)cleanId;
                                Schema.SObjectType sType = recId.getSObjectType();
                                if (sType != null) {
                                    if (!idsByType.containsKey(sType)) idsByType.put(sType, new List<Id>());
                                    idsByType.get(sType).add(recId);
                                }
                            } catch (Exception e) {}
                        }
                    }
                }
                
                List<SObject> objsToDelete = new List<SObject>();
                for (Schema.SObjectType sType : idsByType.keySet()) {
                    String objName = sType.getDescribe().getName();
                    List<Id> idList = idsByType.get(sType);
                    String q = 'SELECT Id FROM ' + String.escapeSingleQuotes(objName) + ' WHERE Id IN :idList';
                    objsToDelete.addAll(Database.query(q));
                }

                if (!objsToDelete.isEmpty()) {
                    if (saveWithoutSharing != null && saveWithoutSharing) sysDml.doDelete(objsToDelete);
                    else Database.delete(objsToDelete);
                }
            }

            String payloadJson = JSON.serialize(payload);
            Map<String, Object> cleanPayload = (Map<String, Object>)JSON.deserializeUntyped(payloadJson);
            Map<String, Object> cleanRelMap = new Map<String, Object>();
            if (relationshipMap != null) { 
                String relJson = JSON.serialize(relationshipMap); 
                cleanRelMap = (Map<String, Object>)JSON.deserializeUntyped(relJson); 
            }

            Map<String, Object> lowerPayload = new Map<String, Object>();
            for (String key : cleanPayload.keySet()) lowerPayload.put(key.toLowerCase(), cleanPayload.get(key));

            String parentKey = parentObjectApiName.toLowerCase();
            if (!lowerPayload.containsKey(parentKey)) throw new AuraHandledException('Payload missing data for parent object: ' + parentObjectApiName);

            Map<String, Object> parentData = (Map<String, Object>)lowerPayload.get(parentKey);
            SObject parentRec = createSObject(parentObjectApiName, parentData);
            if (parentRec == null) throw new AuraHandledException('Invalid Parent Object');
            
            if (parentData.containsKey('Id') && parentData.get('Id') != null) parentRec.Id = (Id)String.valueOf(parentData.get('Id')).replaceAll('[^a-zA-Z0-9]', ''); 
            else if (parentData.containsKey('id') && parentData.get('id') != null) parentRec.Id = (Id)String.valueOf(parentData.get('id')).replaceAll('[^a-zA-Z0-9]', ''); 

            if (saveWithoutSharing != null && saveWithoutSharing) sysDml.doUpsert(parentRec);
            else upsert parentRec;
            
            response.put('parentId', parentRec.Id);

            Map<String, String> createdChildIds = new Map<String, String>();
            List<String> allInsertedChildIds = new List<String>(); 

            for (String objName : lowerPayload.keySet()) {
                if (objName == parentKey) continue; 
                
                Object rawChildData = lowerPayload.get(objName);
                String lookupField = null;
                for(String relKey : cleanRelMap.keySet()) { 
                    if(relKey.equalsIgnoreCase(objName)) { lookupField = String.valueOf(cleanRelMap.get(relKey)); break; } 
                }
                if (String.isBlank(lookupField)) continue;

                if (rawChildData instanceof List<Object>) {
                    List<Object> dataList = (List<Object>)rawChildData;
                    List<SObject> recordsToInsert = new List<SObject>();
                    for (Object item : dataList) {
                        Map<String, Object> itemMap = (Map<String, Object>)item;
                        SObject childRec = createSObject(objName, itemMap);
                        if (childRec != null) {
                            Boolean isUpdate = false;
                            if (itemMap.containsKey('Id') && itemMap.get('Id') != null) { 
                                childRec.Id = (Id)String.valueOf(itemMap.get('Id')).replaceAll('[^a-zA-Z0-9]', ''); 
                                isUpdate = true; 
                            } else if (itemMap.containsKey('id') && itemMap.get('id') != null) { 
                                childRec.Id = (Id)String.valueOf(itemMap.get('id')).replaceAll('[^a-zA-Z0-9]', ''); 
                                isUpdate = true; 
                            }
                            if (!isUpdate && childRec.get(lookupField) == null) childRec.put(lookupField, parentRec.Id);
                            recordsToInsert.add(childRec);
                        }
                    }
                    if (!recordsToInsert.isEmpty()) {
                        if (saveWithoutSharing != null && saveWithoutSharing) sysDml.doUpsert(recordsToInsert);
                        else upsert recordsToInsert;
                        
                        for (SObject rec : recordsToInsert) allInsertedChildIds.add((String)rec.Id);
                    }
                }
                else if (rawChildData instanceof Map<String, Object>) {
                    Map<String, Object> itemMap = (Map<String, Object>)rawChildData;
                    SObject childRec = createSObject(objName, itemMap);
                    if (childRec != null) {
                        Boolean isUpdate = false;
                        if (itemMap.containsKey('Id') && itemMap.get('Id') != null) { 
                            childRec.Id = (Id)String.valueOf(itemMap.get('Id')).replaceAll('[^a-zA-Z0-9]', ''); 
                            isUpdate = true; 
                        } else if (itemMap.containsKey('id') && itemMap.get('id') != null) { 
                            childRec.Id = (Id)String.valueOf(itemMap.get('id')).replaceAll('[^a-zA-Z0-9]', ''); 
                            isUpdate = true; 
                        }
                        if (!isUpdate && childRec.get(lookupField) == null) childRec.put(lookupField, parentRec.Id);
                        
                        if (saveWithoutSharing != null && saveWithoutSharing) sysDml.doUpsert(childRec);
                        else upsert childRec;
                        
                        createdChildIds.put(objName, childRec.Id);
                        allInsertedChildIds.add((String)childRec.Id); 
                    }
                }
            }
            response.put('childIds', createdChildIds);
            response.put('allInsertedChildIds', allInsertedChildIds); 
            return response;

        } catch (Exception e) { 
            Database.rollback(sp); 
            throw new AuraHandledException(getCleanErrorMessage(e)); 
        }
    }

    // *** FIX: Enabled SaveWithoutSharing DML override for standalone file/record deletions ***
    @AuraEnabled
    public static void deleteRecord(String recordId, Boolean saveWithoutSharing) {
        if (String.isBlank(recordId)) return;
        try { 
            String cleanId = recordId.replaceAll('[^a-zA-Z0-9]', '');
            if (cleanId.length() >= 15) {
                Id recId = (Id)cleanId; 
                Schema.SObjectType sType = recId.getSObjectType();
                if (sType != null) {
                    SObject recToDelete = sType.newSObject(recId);
                    if (saveWithoutSharing != null && saveWithoutSharing) {
                        new SystemModeDML().doDelete(new List<SObject>{recToDelete});
                    } else {
                        Database.delete(recToDelete); 
                    }
                }
            }
        } catch (Exception e) { 
            throw new AuraHandledException(getCleanErrorMessage(e)); 
        }
    }

    // *** FIX: Enabled SaveWithoutSharing DML override for Rollback Sequences ***
    @AuraEnabled
    public static void rollbackTransaction(String recordId, List<String> childIds, Boolean saveWithoutSharing) {
        List<SObject> childRecordsToDelete = new List<SObject>();
        List<SObject> parentRecordToDelete = new List<SObject>();

        if (childIds != null && !childIds.isEmpty()) {
            for (String cId : childIds) {
                if (String.isNotBlank(cId)) {
                    String cleanId = cId.replaceAll('[^a-zA-Z0-9]', '');
                    if (cleanId.length() >= 15) {
                        try {
                            Id parsedId = (Id)cleanId;
                            childRecordsToDelete.add(parsedId.getSObjectType().newSObject(parsedId));
                        } catch (Exception e) {}
                    }
                }
            }
        }

        if (String.isNotBlank(recordId)) {
            String cleanId = recordId.replaceAll('[^a-zA-Z0-9]', '');
            if (cleanId.length() >= 15) {
                try {
                    Id parsedId = (Id)cleanId;
                    parentRecordToDelete.add(parsedId.getSObjectType().newSObject(parsedId));
                } catch (Exception e) {}
            }
        }

        try {
            SystemModeDML sysDml = new SystemModeDML();
            if (!childRecordsToDelete.isEmpty()) {
                if (saveWithoutSharing != null && saveWithoutSharing) sysDml.doDelete(childRecordsToDelete, false);
                else Database.delete(childRecordsToDelete, false);
            }
            if (!parentRecordToDelete.isEmpty()) {
                if (saveWithoutSharing != null && saveWithoutSharing) sysDml.doDelete(parentRecordToDelete, false);
                else Database.delete(parentRecordToDelete, false);
            }
        } catch (Exception e) {
            System.debug('Error rolling back transactional save: ' + e.getMessage());
        }
    }

    // *** FIX: Enabled SaveWithoutSharing DML override for File Uploads ***
    @AuraEnabled
    public static Id uploadFile(String parentId, String fileName, String base64Data, Boolean saveWithoutSharing) {
        try {
            ContentVersion cv = new ContentVersion();
            cv.VersionData = EncodingUtil.base64Decode(base64Data);
            cv.Title = fileName;
            cv.PathOnClient = fileName;
            cv.FirstPublishLocationId = parentId; 
            
            if (saveWithoutSharing != null && saveWithoutSharing) {
                new SystemModeDML().doInsert(cv);
            } else {
                insert cv;
            }
            
            ContentVersion insertedCv = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id LIMIT 1];
            return insertedCv.ContentDocumentId;
            
        } catch (Exception e) {
            throw new AuraHandledException(getCleanErrorMessage(e));
        }
    }

    private static String escapeSoslReservedChars(String term) {
        if (String.isBlank(term)) return term;
        Set<String> reserved = new Set<String>{ '\\', '?', '&', '|', '!', '{', '}', '[', ']', '(', ')', '^', '~', '*', ':', '"', '\'' };
        String output = '';
        for (Integer i = 0; i < term.length(); i++) {
            String ch = term.substring(i, i + 1);
            output += reserved.contains(ch) ? '\\' + ch : ch;
        }
        return output;
    }

    private static String getCleanErrorMessage(Exception e) {
        if (e instanceof System.DmlException) return ((System.DmlException)e).getDmlMessage(0);
        String errorMsg = e.getMessage();
        if (errorMsg.contains('FIELD_CUSTOM_VALIDATION_EXCEPTION')) errorMsg = errorMsg.substringAfter('FIELD_CUSTOM_VALIDATION_EXCEPTION, ').substringBefore(': [');
        else if (errorMsg.contains('INSUFFICIENT_ACCESS')) errorMsg = 'You do not have permission to access or modify this record.';
        else if (errorMsg.contains('DUPLICATE_VALUE')) errorMsg = 'A record with this information already exists.';
        else if (errorMsg.contains('REQUIRED_FIELD_MISSING')) errorMsg = 'Please fill out all required fields: ' + errorMsg.substringAfter('REQUIRED_FIELD_MISSING, ').substringBefore(':');
        else if (errorMsg.contains('Class.')) errorMsg = errorMsg.substringBefore('Class.');
        return errorMsg.trim();
    }

    private static void processPicklistLogic(Form_Field__mdt f, FieldWrapper fw, Map<String, SObjectField> describeMap, String recordTypeId, String rootObjectApiName) {
        if (String.isNotBlank(f.Override_Picklist_Values__c)) { 
            for (String val : f.Override_Picklist_Values__c.split(',')) { fw.picklistOptions.add(new Map<String, String>{'label'=>val.trim(), 'value'=>val.trim()}); } 
        }
        if (String.isNotBlank(f.Override_Dependency_JSON__c)) {
            Map<String, Object> raw = (Map<String, Object>)JSON.deserializeUntyped(f.Override_Dependency_JSON__c);
            for (String k : raw.keySet()) {
                List<Map<String, String>> opts = new List<Map<String, String>>();
                for (Object o : (List<Object>)raw.get(k)) { 
                    Map<String, Object> m = (Map<String, Object>)o; 
                    opts.add(new Map<String, String>{'label'=>String.valueOf(m.get('label')), 'value'=>String.valueOf(m.get('value'))}); 
                }
                fw.dependencyMap.put(k, opts);
            }
        }
        if (fw.picklistOptions.isEmpty() && describeMap.containsKey(f.Field_API_Name__c.toLowerCase())) {
            SObjectField fieldToken = describeMap.get(f.Field_API_Name__c.toLowerCase());
            Schema.DescribeFieldResult dfr = fieldToken.getDescribe();
            
            Boolean fetchSuccess = false;
            Set<String> allowedValues = new Set<String>();

            if (String.isNotBlank(recordTypeId) && String.isNotBlank(fw.targetObject) && fw.targetObject.equalsIgnoreCase(rootObjectApiName)) {
                try {
                    if(!Test.isRunningTest()) {
                        ConnectApi.PicklistValuesCollection rtValues = ConnectApi.RecordUi.getPicklistValuesByRecordType(fw.targetObject, recordTypeId);
                        if (rtValues != null && rtValues.picklistFieldValues != null) {
                            ConnectApi.PicklistValues fieldValues = null;
                            for (String fieldKey : rtValues.picklistFieldValues.keySet()) {
                                if (fieldKey.equalsIgnoreCase(fw.apiName)) { fieldValues = rtValues.picklistFieldValues.get(fieldKey); break; }
                            }
                            if (fieldValues != null && fieldValues.values != null) {
                                for (ConnectApi.PicklistValue pv : fieldValues.values) {
                                    fw.picklistOptions.add(new Map<String, String>{'label' => pv.label, 'value' => pv.value});
                                    allowedValues.add(pv.value); 
                                }
                                fetchSuccess = true;
                            }
                        }
                    }
                } catch (Exception e) {}
            }

            if (!fetchSuccess) {
                for (Schema.PicklistEntry entry : dfr.getPicklistValues()) { 
                    if (entry.isActive()) {
                        fw.picklistOptions.add(new Map<String, String>{'label' => entry.getLabel(), 'value' => entry.getValue()}); 
                        allowedValues.add(entry.getValue());
                    }
                }
            }
            
            if (String.isNotBlank(f.Controller_Field__c)) {
                fw.dependencyMap = PicklistDependencyHelper.getSerializedDependencyMap(fieldToken);
                if (fetchSuccess && !allowedValues.isEmpty()) {
                    for (String ctrlVal : fw.dependencyMap.keySet()) {
                        List<Map<String, String>> filteredDeps = new List<Map<String, String>>();
                        for (Map<String, String> depOpt : fw.dependencyMap.get(ctrlVal)) {
                            if (allowedValues.contains(depOpt.get('value'))) { filteredDeps.add(depOpt); }
                        }
                        fw.dependencyMap.put(ctrlVal, filteredDeps);
                    }
                }
            }
        }
    }

    private static Map<String, Object> processRecord(SObject rec, Map<String, String> lookupMap) {
        Map<String, Object> data = rec.getPopulatedFieldsAsMap().clone();
        for (String fieldApi : lookupMap.keySet()) {
            String path = lookupMap.get(fieldApi);
            if (path.contains('.')) {
                List<String> parts = path.split('\\.');
                SObject current = rec;
                Boolean safe = true;
                for(Integer i=0; i<parts.size()-1; i++) { 
                    current = current.getSObject(parts[i]); 
                    if(current == null) { safe = false; break; } 
                }
                if(safe) { 
                    Object val = current.get(parts[parts.size()-1]); 
                    data.put(fieldApi + '_Label', val); 
                }
            }
        }
        return data;
    }

    private static String getRelationshipField(String apiName) {
        if (apiName.endsWithIgnoreCase('Id')) return apiName.substring(0, apiName.length()-2);
        if (apiName.endsWithIgnoreCase('__c')) return apiName.substring(0, apiName.length()-3) + '__r';
        return apiName;
    }

    private static SObject createSObject(String objName, Map<String, Object> data) {
        if (String.isBlank(objName) || data == null) return null;
        Schema.SObjectType targetType = Schema.getGlobalDescribe().get(objName);
        if (targetType == null) return null;
        
        SObject obj = targetType.newSObject();
        Map<String, SObjectField> fieldMap = targetType.getDescribe().fields.getMap();
        Map<String, SObjectField> lowerFieldMap = new Map<String, SObjectField>();
        for(String fName : fieldMap.keySet()) lowerFieldMap.put(fName.toLowerCase(), fieldMap.get(fName));
        
        for (String key : data.keySet()) {
            String lowerKey = key.toLowerCase();
            if (lowerFieldMap.containsKey(lowerKey)) {
                SObjectField f = lowerFieldMap.get(lowerKey);
                Object val = data.get(key);
                
                if (f.getDescribe().isCreateable() || f.getDescribe().isUpdateable()) {
                    if (val == null || String.valueOf(val).trim() == '') {
                        if (f.getDescribe().isNillable()) obj.put(f, null); 
                    } else {
                        DisplayType t = f.getDescribe().getType();
                        String valString = String.valueOf(val).trim();
                        if (t == DisplayType.DOUBLE || t == DisplayType.CURRENCY || t == DisplayType.PERCENT) obj.put(f, Double.valueOf(valString));
                        else if (t == DisplayType.INTEGER) obj.put(f, Integer.valueOf(valString));
                        else if (t == DisplayType.DATE) obj.put(f, Date.valueOf(valString));
                        else if (t == DisplayType.DATETIME) {
                            if (valString.contains('T') || valString.contains('Z')) obj.put(f, (Datetime)JSON.deserialize('"' + valString + '"', Datetime.class));
                            else obj.put(f, Datetime.valueOf(valString));
                        } 
                        else if (t == DisplayType.BOOLEAN) obj.put(f, Boolean.valueOf(valString));
                        else if (t == DisplayType.REFERENCE || t == DisplayType.ID) {
                            String cleanId = valString.replaceAll('[^a-zA-Z0-9]', '');
                            if (cleanId.length() >= 15) obj.put(f, (Id)cleanId);
                        } 
                        else obj.put(f, valString);
                    }
                }
            }
        }
        return obj;
    }

    // *** FIX: Inner class now supports Insert and allows AllOrNone flag for deletion ***
    @TestVisible
    private without sharing class SystemModeDML {
        public void doUpsert(SObject record) { upsert record; }
        public void doUpsert(List<SObject> records) { upsert records; }
        public void doDelete(List<SObject> records) { Database.delete(records); }
        public void doDelete(List<SObject> records, Boolean allOrNone) { Database.delete(records, allOrNone); }
        public void doInsert(SObject record) { insert record; }
    }
}