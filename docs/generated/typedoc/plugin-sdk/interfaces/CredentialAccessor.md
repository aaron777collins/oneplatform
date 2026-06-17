[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / CredentialAccessor

# Interface: CredentialAccessor

Defined in: [packages/plugin-sdk/src/types/context.ts:54](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L54)

## Methods

### get()

> **get**(`name`): `Promise`\<`string`\>

Defined in: [packages/plugin-sdk/src/types/context.ts:67](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L67)

Returns the decrypted credential value for a named credential bound to this
plugin instance. Credentials are configured by a platform admin and bound
at enable time via the plugin instance configuration form.

The returned string is the raw credential value (API key, token, password, etc.).
Never log this value. Never include it in error messages. Never store it in the
plugin's cache — the platform rotates credentials and will deliver updated values
automatically.

#### Parameters

##### name

`string`

#### Returns

`Promise`\<`string`\>

#### Throws

PluginAuthError if the credential is not found or decryption fails.

***

### list()

> **list**(): `Promise`\<`string`[]\>

Defined in: [packages/plugin-sdk/src/types/context.ts:73](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L73)

Returns the names of all credentials available to this plugin instance.
Use this to check for optional credentials before calling get().

#### Returns

`Promise`\<`string`[]\>
