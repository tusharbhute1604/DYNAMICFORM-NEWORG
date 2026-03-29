Formula Logic (Formula_Logic__c)

The formula engine runs in JavaScript. This means you can use standard math operators and JavaScript logic.

Syntax: Wrap field API names in curly braces: {Field_API_Name__c}.

Trigger: Recalculates automatically whenever any field on the form changes.

Complexity Levels & Examples:

Simple (Basic Math)

Scenario: Calculate Total Price.

Formula: {Quantity__c} * {Unit_Price__c}

Medium (Logic / Text)

Scenario: Concatenate Name.

Formula: '{FirstName}' + ' ' + '{LastName}'

Scenario: Weighted Score.

Formula: ({Quality_Score__c} * 0.7) + ({Speed_Score__c} * 0.3)

Complex (Conditional Logic)

Scenario: Determine Status based on Score (Ternary Operator).

Formula: {Total_Score__c} >= 80 ? 'Pass' : 'Fail'

Explanation: If Score is greater/equal to 80, set value to 'Pass', otherwise 'Fail'.

Advanced (Math Functions)

Scenario: Rounding a calculated tax amount.

Formula: Math.round({Subtotal__c} * 0.15)