import type { Context } from "hono";

export type ExtractedCredential =
  | { type: "jwt"; token: string }
  | { type: "apiKey"; key: string }
  | null;

export interface CredentialExtractor {
  extract(c: Context): ExtractedCredential;
}

export class BearerTokenExtractor implements CredentialExtractor {
  extract(c: Context): ExtractedCredential {
    const header = c.req.header("Authorization");
    if (header?.startsWith("Bearer ")) {
      return { type: "jwt", token: header.slice(7) };
    }
    return null;
  }
}

export class CookieTokenExtractor implements CredentialExtractor {
  extract(c: Context): ExtractedCredential {
    const cookieHeader = c.req.header("cookie") ?? "";
    const match = cookieHeader.match(/(?:^|;\s*)op_access_token=([^;]+)/);
    if (match?.[1]) {
      return { type: "jwt", token: match[1] };
    }
    return null;
  }
}

export class ApiKeyExtractor implements CredentialExtractor {
  extract(c: Context): ExtractedCredential {
    const key = c.req.header("X-API-Key");
    if (key) {
      return { type: "apiKey", key };
    }
    return null;
  }
}

export function createCredentialChain(...extractors: CredentialExtractor[]): CredentialExtractor {
  return {
    extract(c: Context): ExtractedCredential {
      for (const extractor of extractors) {
        const result = extractor.extract(c);
        if (result !== null) return result;
      }
      return null;
    },
  };
}
