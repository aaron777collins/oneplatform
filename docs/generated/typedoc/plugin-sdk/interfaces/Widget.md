[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / Widget

# Interface: Widget

Defined in: [packages/plugin-sdk/src/types/widget.ts:47](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/widget.ts#L47)

## Methods

### declareDataRequirements()

> **declareDataRequirements**(): [`DataQuery`](DataQuery.md)[]

Defined in: [packages/plugin-sdk/src/types/widget.ts:72](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/widget.ts#L72)

Declare what platform data this widget needs.
The platform pre-fetches this data before calling render(), so render() receives
fully populated WidgetData.queryResults without making any async calls.

Keep queries minimal — each declared query adds latency to the dashboard load.

#### Returns

[`DataQuery`](DataQuery.md)[]

***

### declareSlot()

> **declareSlot**(): [`WidgetSlotDeclaration`](WidgetSlotDeclaration.md)

Defined in: [packages/plugin-sdk/src/types/widget.ts:75](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/widget.ts#L75)

Declare which slot(s) this widget can render in.

#### Returns

[`WidgetSlotDeclaration`](WidgetSlotDeclaration.md)

***

### metadata()

> **metadata**(): [`WidgetMetadata`](WidgetMetadata.md)

Defined in: [packages/plugin-sdk/src/types/widget.ts:48](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/widget.ts#L48)

#### Returns

[`WidgetMetadata`](WidgetMetadata.md)

***

### render()

> **render**(`data`): `string`

Defined in: [packages/plugin-sdk/src/types/widget.ts:63](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/widget.ts#L63)

Return a complete HTML document string to be served inside the widget iframe.

Security constraints:
- Do not include <script> tags in the output. DOMPurify (server-side) strips
  all <script> elements. The platform injects a bootstrap script via nonce.
- Do not attempt to access window.parent or window.top — the iframe uses
  sandbox="allow-scripts" (no allow-same-origin), creating an opaque origin.
- Use inline styles freely (style-src 'unsafe-inline' is permitted).
- Do not embed external images — use data URIs or serve from the widget bundle.

The returned HTML must be a complete document (<html><head><body>...</body></html>).

#### Parameters

##### data

[`WidgetData`](WidgetData.md)

#### Returns

`string`
