// S3-compatible object storage service — interacts with MinIO (or AWS S3) via
// raw HTTP requests with AWS Signature V4 signing. No additional npm packages
// required; all signing is implemented using Node.js built-in crypto.
//
// WHY raw HTTP instead of the AWS SDK: the task spec requires no additional
// npm packages. Node.js crypto provides everything needed for Sig V4.

import { createHmac, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StorageBucket {
  name: string;
  createdAt: string;
}

export interface StorageObject {
  key: string;
  /** Bytes, or null for common prefixes (folders). */
  size: number | null;
  lastModified: string | null;
  contentType: string | null;
  etag: string | null;
  /** True when this entry represents a synthetic folder prefix, not a real object. */
  isFolder: boolean;
}

export interface ListObjectsResult {
  objects: StorageObject[];
  /** Continuation token for the next page; null when listing is complete. */
  nextContinuationToken: string | null;
  isTruncated: boolean;
}

export interface ObjectMetadata {
  key: string;
  size: number;
  lastModified: string;
  contentType: string;
  etag: string;
}

export interface PresignedUrlResult {
  url: string;
  expiresAt: string;
}

export interface StorageService {
  listBuckets(): Promise<StorageBucket[]>;
  listObjects(
    bucket: string,
    options?: { prefix?: string; delimiter?: string; maxKeys?: number; continuationToken?: string },
  ): Promise<ListObjectsResult>;
  getObjectMetadata(bucket: string, key: string): Promise<ObjectMetadata>;
  deleteObject(bucket: string, key: string): Promise<void>;
  generatePresignedDownloadUrl(bucket: string, key: string, expiresInSeconds?: number): Promise<PresignedUrlResult>;
  /** Upload bytes to the given bucket/key. */
  putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface StorageServiceConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

// ---------------------------------------------------------------------------
// AWS Signature V4 implementation
//
// References:
//   https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
//   https://docs.aws.amazon.com/general/latest/gr/sigv4-create-string-to-sign.html
//   https://docs.aws.amazon.com/general/latest/gr/sigv4-signed-request-examples.html
// ---------------------------------------------------------------------------

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function deriveSigningKey(
  secretKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmacSha256(`AWS4${secretKey}`, date);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");
  return kSigning;
}

type SigV4Headers = Record<string, string> & {
  Authorization: string;
  "x-amz-date": string;
  "x-amz-content-sha256": string;
  host: string;
};

function signRequest(
  method: string,
  url: URL,
  config: StorageServiceConfig,
  payloadHash: string,
  additionalHeaders: Record<string, string> = {},
): SigV4Headers {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);

  const host = url.host;
  const canonicalUri = encodeCanonicalUri(url.pathname);
  const canonicalQueryString = buildCanonicalQueryString(url.searchParams);

  // Include additional headers in the signed set. Always sign host,
  // x-amz-date, and x-amz-content-sha256. Additional callers may pass
  // extra headers that must also be signed.
  const signedHeadersMap: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...additionalHeaders,
  };

  // Canonical headers must be sorted by header name, lowercase.
  const sortedKeys = Object.keys(signedHeadersMap).sort();
  const canonicalHeaders = sortedKeys
    .map((k) => `${k}:${signedHeadersMap[k]?.trim()}\n`)
    .join("");
  const signedHeaders = sortedKeys.join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(config.secretAccessKey, dateStamp, config.region, "s3");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");

  return {
    Authorization: authorization,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    host,
  };
}

function encodeCanonicalUri(path: string): string {
  // Each path segment is percent-encoded but slashes between segments are kept.
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function buildCanonicalQueryString(params: URLSearchParams): string {
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  return sorted
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// ---------------------------------------------------------------------------
// Pre-signed URL generation (query-string-based auth, no request needed)
// ---------------------------------------------------------------------------

function buildPresignedUrl(
  url: URL,
  config: StorageServiceConfig,
  expiresInSeconds: number,
): string {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const credential = `${config.accessKeyId}/${credentialScope}`;
  const host = url.host;

  // Build the query string for the pre-signed URL.
  const params = new URLSearchParams(url.searchParams);
  params.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  params.set("X-Amz-Credential", credential);
  params.set("X-Amz-Date", amzDate);
  params.set("X-Amz-Expires", String(expiresInSeconds));
  params.set("X-Amz-SignedHeaders", "host");

  const sortedParams = new URLSearchParams(
    [...params.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );

  const canonicalUri = encodeCanonicalUri(url.pathname);
  const canonicalQueryString = buildCanonicalQueryString(sortedParams);
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";
  // Pre-signed URLs use the literal string "UNSIGNED-PAYLOAD" per S3 spec.
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(config.secretAccessKey, dateStamp, config.region, "s3");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  sortedParams.set("X-Amz-Signature", signature);

  return `${url.origin}${url.pathname}?${sortedParams.toString()}`;
}

// ---------------------------------------------------------------------------
// XML parsing helpers — parse S3 XML responses without an xml parser package.
//
// WHY custom parsing: the responses have simple, predictable structure. Using
// regex extraction avoids an additional npm dependency while remaining correct
// for the subset of S3 XML responses we consume.
// ---------------------------------------------------------------------------

function extractTagContent(xml: string, tag: string): string[] {
  const results: string[] = [];
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    if (match[1] !== undefined) {
      results.push(decodeXmlEntities(match[1].trim()));
    }
  }
  return results;
}

/**
 * Decodes the five predefined XML entities that S3 uses in responses.
 * A full XML parser is not required because S3 only emits these five
 * entities in the fields we consume (ETag, key names, error codes).
 */
function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractSingleTag(xml: string, tag: string): string | null {
  const values = extractTagContent(xml, tag);
  return values[0] ?? null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStorageService(config: StorageServiceConfig): StorageService {
  const EMPTY_PAYLOAD_HASH = sha256Hex("");

  // -------------------------------------------------------------------------
  // listBuckets — GET / (S3 ListBuckets)
  // -------------------------------------------------------------------------

  async function listBuckets(): Promise<StorageBucket[]> {
    const url = new URL(`${config.endpoint}/`);
    const sigHeaders = signRequest("GET", url, config, EMPTY_PAYLOAD_HASH);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        ...sigHeaders,
        Accept: "application/xml",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new StorageServiceError(
        `ListBuckets failed: HTTP ${response.status} — ${body}`,
        response.status,
      );
    }

    const xml = await response.text();

    const names = extractTagContent(xml, "Name");
    const dates = extractTagContent(xml, "CreationDate");

    return names.map((name, i) => ({
      name,
      createdAt: dates[i] ?? new Date().toISOString(),
    }));
  }

  // -------------------------------------------------------------------------
  // listObjects — GET /{bucket}?list-type=2 (S3 ListObjectsV2)
  // -------------------------------------------------------------------------

  async function listObjects(
    bucket: string,
    options: {
      prefix?: string;
      delimiter?: string;
      maxKeys?: number;
      continuationToken?: string;
    } = {},
  ): Promise<ListObjectsResult> {
    const url = new URL(`${config.endpoint}/${encodeURIComponent(bucket)}`);
    url.searchParams.set("list-type", "2");

    if (options.prefix !== undefined && options.prefix !== "") {
      url.searchParams.set("prefix", options.prefix);
    }
    if (options.delimiter !== undefined && options.delimiter !== "") {
      url.searchParams.set("delimiter", options.delimiter);
    }
    if (options.maxKeys !== undefined) {
      url.searchParams.set("max-keys", String(options.maxKeys));
    }
    if (options.continuationToken !== undefined && options.continuationToken !== "") {
      url.searchParams.set("continuation-token", options.continuationToken);
    }

    const sigHeaders = signRequest("GET", url, config, EMPTY_PAYLOAD_HASH);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        ...sigHeaders,
        Accept: "application/xml",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new StorageServiceError(
        `ListObjectsV2 failed for bucket "${bucket}": HTTP ${response.status} — ${body}`,
        response.status,
      );
    }

    const xml = await response.text();

    // Parse real objects from <Contents> blocks.
    const objects: StorageObject[] = parseContents(xml);

    // Parse folder prefixes from <CommonPrefixes> blocks.
    const prefixes = extractTagContent(xml, "Prefix");
    // The first <Prefix> may be the query prefix itself inside <ListBucketResult>;
    // common prefix entries only appear inside <CommonPrefixes> elements.
    const commonPrefixBlocks = [...xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)];
    for (const block of commonPrefixBlocks) {
      const blockXml = block[1] ?? "";
      const prefixValue = extractSingleTag(blockXml, "Prefix");
      if (prefixValue !== null) {
        objects.push({
          key: prefixValue,
          size: null,
          lastModified: null,
          contentType: null,
          etag: null,
          isFolder: true,
        });
      }
    }

    const nextToken = extractSingleTag(xml, "NextContinuationToken");
    const isTruncatedStr = extractSingleTag(xml, "IsTruncated");

    return {
      objects,
      nextContinuationToken: nextToken,
      isTruncated: isTruncatedStr === "true",
    };
  }

  function parseContents(xml: string): StorageObject[] {
    const contentBlocks = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)];
    return contentBlocks.map((block) => {
      const blockXml = block[1] ?? "";
      const key = extractSingleTag(blockXml, "Key") ?? "";
      const sizeStr = extractSingleTag(blockXml, "Size");
      const lastModified = extractSingleTag(blockXml, "LastModified");
      // ETag values are wrapped in quotes by S3 — strip them.
      const rawEtag = extractSingleTag(blockXml, "ETag");
      const etag = rawEtag !== null ? rawEtag.replace(/^"|"$/g, "") : null;

      return {
        key,
        size: sizeStr !== null ? parseInt(sizeStr, 10) : null,
        lastModified,
        contentType: null, // ListObjectsV2 does not return content type; use HeadObject for that.
        etag,
        isFolder: false,
      };
    });
  }

  // -------------------------------------------------------------------------
  // getObjectMetadata — HEAD /{bucket}/{key} (S3 HeadObject)
  // -------------------------------------------------------------------------

  async function getObjectMetadata(bucket: string, key: string): Promise<ObjectMetadata> {
    const url = new URL(
      `${config.endpoint}/${encodeURIComponent(bucket)}/${encodeObjectKey(key)}`,
    );
    const sigHeaders = signRequest("HEAD", url, config, EMPTY_PAYLOAD_HASH);

    const response = await fetch(url.toString(), {
      method: "HEAD",
      headers: sigHeaders,
    });

    if (response.status === 404) {
      throw new StorageObjectNotFoundError(
        `Object "${key}" not found in bucket "${bucket}".`,
        bucket,
        key,
      );
    }

    if (!response.ok) {
      throw new StorageServiceError(
        `HeadObject failed for "${bucket}/${key}": HTTP ${response.status}`,
        response.status,
      );
    }

    const rawEtag = response.headers.get("etag") ?? "";
    return {
      key,
      size: parseInt(response.headers.get("content-length") ?? "0", 10),
      lastModified: response.headers.get("last-modified") ?? new Date().toISOString(),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      etag: rawEtag.replace(/^"|"$/g, ""),
    };
  }

  // -------------------------------------------------------------------------
  // deleteObject — DELETE /{bucket}/{key} (S3 DeleteObject)
  // -------------------------------------------------------------------------

  async function deleteObject(bucket: string, key: string): Promise<void> {
    const url = new URL(
      `${config.endpoint}/${encodeURIComponent(bucket)}/${encodeObjectKey(key)}`,
    );
    const sigHeaders = signRequest("DELETE", url, config, EMPTY_PAYLOAD_HASH);

    const response = await fetch(url.toString(), {
      method: "DELETE",
      headers: sigHeaders,
    });

    // S3 returns 204 No Content on successful deletion, 404 if the object
    // didn't exist (treated as success — idempotent delete), or 2xx variants.
    if (response.status === 404) {
      // Idempotent — already gone, no error.
      return;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new StorageServiceError(
        `DeleteObject failed for "${bucket}/${key}": HTTP ${response.status} — ${body}`,
        response.status,
      );
    }
  }

  // -------------------------------------------------------------------------
  // generatePresignedDownloadUrl — unsigned query-string auth (S3 presigned)
  //
  // The pre-signed URL is generated entirely in-process using Sig V4 query
  // string signing. No upstream request is made; the URL is safe to hand to
  // the browser which will GET it directly from MinIO/S3.
  // -------------------------------------------------------------------------

  async function generatePresignedDownloadUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number = 3600,
  ): Promise<PresignedUrlResult> {
    if (expiresInSeconds < 1 || expiresInSeconds > 604800) {
      throw new StorageValidationError(
        `expiresInSeconds must be between 1 and 604800 (7 days), got ${expiresInSeconds}.`,
      );
    }

    const url = new URL(
      `${config.endpoint}/${encodeURIComponent(bucket)}/${encodeObjectKey(key)}`,
    );

    const presignedUrl = buildPresignedUrl(url, config, expiresInSeconds);
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    return { url: presignedUrl, expiresAt };
  }

  // -------------------------------------------------------------------------
  // putObject — PUT /{bucket}/{key} (S3 PutObject)
  // -------------------------------------------------------------------------

  async function putObject(
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    const url = new URL(
      `${config.endpoint}/${encodeURIComponent(bucket)}/${encodeObjectKey(key)}`,
    );
    const payloadHash = sha256Hex(body);
    // Only sign content-type (not content-length) — including content-length in
    // the signed set causes MinIO to reject the request when the header value
    // differs from the actual body size after the network layer.
    const sigHeaders = signRequest("PUT", url, config, payloadHash, {
      "content-type": contentType,
    });

    const response = await fetch(url.toString(), {
      method: "PUT",
      headers: {
        ...sigHeaders,
        "Content-Type": contentType,
      },
      body,
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new StorageServiceError(
        `PutObject failed for "${bucket}/${key}": HTTP ${response.status} — ${responseBody}`,
        response.status,
      );
    }
  }

  return {
    listBuckets,
    listObjects,
    getObjectMetadata,
    deleteObject,
    generatePresignedDownloadUrl,
    putObject,
  };
}

// ---------------------------------------------------------------------------
// Encode an object key for use in a URL path.
// Each segment is encoded individually so slashes that represent directory
// separators are preserved as forward slashes in the URL path.
// ---------------------------------------------------------------------------

function encodeObjectKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class StorageServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "StorageServiceError";
  }
}

export class StorageObjectNotFoundError extends StorageServiceError {
  constructor(
    message: string,
    public readonly bucket: string,
    public readonly key: string,
  ) {
    super(message, 404);
    this.name = "StorageObjectNotFoundError";
  }
}

export class StorageValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "StorageValidationError";
  }
}
