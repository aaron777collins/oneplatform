[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / filter

# Function: filter()

> **filter**(`field`): [`FieldConditionBuilder`](../interfaces/FieldConditionBuilder.md)

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:134](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L134)

Entry point for the filter DSL. Returns a FieldConditionBuilder primed
to add a condition on the named field.

Example:
  filter('status').eq('active').and('price').gt(100)

## Parameters

### field

`string`

## Returns

[`FieldConditionBuilder`](../interfaces/FieldConditionBuilder.md)
