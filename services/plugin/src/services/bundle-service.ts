import { createHash, createHmac } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { Logger } from "@oneplatform/core";
import { StorageUnavailableError, ChecksumMismatchError } from "./errors.js";

// ---------------------------------------------------------------------------
// BundleService — MinIO upload / download / integrity / lifecycle (spec §12)
//
// MinIO exposes an S3-compatible API. We sign requests with AWS Signature V4
// using Node.js built-in crypto to avoid adding the heavy @aws-sdk/client-s3
// dependency. The signing logic covers the subset of S3 operations used here:
//   PutObject, GetObject, DeleteObject, HeadObject, HeadBucket,
//   CreateBucket, PutBucketLifecycleConfiguration.
// ---------------------------------------------------------------------------

export interface BundleServiceConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region: string;
  bucket: string;
  logger: Logger;
}

export interface BundleService {
  /** Ensure the bucket exists and lifecycle policy is applied. Idempotent. */
  ensureBucket(): Promise<void>;
  /** Upload bundle.js to MinIO. */
  upload(params: {
    manifestId: string;
    version: string;
    bundlePath: string;
    checksum: string;
  }): Promise<{ bucket: string; key: string }>;
  /** Stream the bundle directly from MinIO — no in-memory buffer. */
  download(bucket: string, key: string): Promise<{ stream: Readable; checksum: string }>;
  /** Delete a bundle object from MinIO. */
  delete(bucket: string, key: string): Promise<void>;
  /** Verify the SHA-256 checksum of a local file and its sidecar. */
  verifyChecksum(bundlePath: string, expectedChecksum: string): Promise<void>;
  /** Health check. */
  ping(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// AWS Signature V4 helpers
// ---------------------------------------------------------------------------

function toHex(buf: Buffer): string {
  return buf.toString("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function formatDate(d: Date): string {
  return d.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 8);
}

function formatDatetime(d: Date): string {
  return d.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
}

function getDerivedKey(secretKey: string, date: string, region: string, service: string): Buffer {
  const kDate = hmacSha256("AWS4" + secretKey, date);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

interface SignedHeaders {
  Authorization: string;
  "x-amz-date": string;
  "x-amz-content-sha256": string;
  host: string;
  [key: string]: string;
}

function signRequest(params: {
  method: string;
  url: string;
  region: string;
  accessKey: string;
  secretKey: string;
  payloadHash: string;
  extraHeaders?: Record<string, string>;
}): SignedHeaders {
  const { method, url, region, accessKey, secretKey, payloadHash, extraHeaders = {} } = params;
  const parsed = new URL(url);
  const now = new Date();
  const date = formatDate(now);
  const datetime = formatDatetime(now);

  const host = parsed.host;
  const allHeaders: Record<string, string> = {
    host,
    "x-amz-date": datetime,
    "x-amz-content-sha256": payloadHash,
    ...extraHeaders,
  };

  const sortedHeaderNames = Object.keys(allHeaders).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((k) => `${k.toLowerCase()}:${allHeaders[k]!.trim()}`)
    .join("\n") + "\n";
  const signedHeadersStr = sortedHeaderNames.map((k) => k.toLowerCase()).join(";");

  const canonicalQueryString = parsed.search
    ? parsed.search
        .slice(1)
        .split("&")
        .sort()
        .join("&")
    : "";

  const canonicalRequest = [
    method.toUpperCase(),
    parsed.pathname,
    canonicalQueryString,
    canonicalHeaders,
    signedHeadersStr,
    payloadHash,
  ].join("\n");

  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    datetime,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = getDerivedKey(secretKey, date, region, "s3");
  const signature = toHex(hmacSha256(signingKey, stringToSign));

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

  return {
    Authorization: authHeader,
    "x-amz-date": datetime,
    "x-amz-content-sha256": payloadHash,
    host,
    ...extraHeaders,
  };
}

// ---------------------------------------------------------------------------
// Build the canonical MinIO object key (spec §12.1)
// ---------------------------------------------------------------------------

function buildBundleKey(manifestId: string, version: string): string {
  return `${manifestId}/${version}/bundle.js`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBundleService(config: BundleServiceConfig): BundleService {
  const { endpoint, accessKey, secretKey, region, bucket, logger } = config;

  function objectUrl(bkt: string, key: string): string {
    return `${endpoint}/${bkt}/${key}`;
  }

  function bucketUrl(bkt: string): string {
    return `${endpoint}/${bkt}`;
  }

  async function s3Fetch(
    method: string,
    url: string,
    bodyBuffer?: Buffer,
    extraHeaders?: Record<string, string>
  ): Promise<Response> {
    const payloadHash = bodyBuffer
      ? sha256Hex(bodyBuffer)
      : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // SHA256("")

    const signed = signRequest({
      method,
      url,
      region,
      accessKey,
      secretKey,
      payloadHash,
      extraHeaders: {
        ...(extraHeaders ?? {}),
      },
    });

    // Remove 'host' from the headers we pass to fetch — the browser/Node sets it automatically.
    const { host: _host, ...fetchHeaders } = signed;

    const response = await fetch(url, {
      method,
      headers: fetchHeaders as Record<string, string>,
      ...(bodyBuffer !== undefined ? { body: bodyBuffer } : {}),
    });

    return response;
  }

  return {
    async ensureBucket(): Promise<void> {
      const url = bucketUrl(bucket);
      const headResp = await s3Fetch("HEAD", url);

      if (headResp.status === 404 || headResp.status === 403) {
        const createResp = await s3Fetch("PUT", url);
        if (!createResp.ok && createResp.status !== 409) {
          throw new StorageUnavailableError(
            `Failed to create MinIO bucket '${bucket}': HTTP ${createResp.status}`
          );
        }
        logger.info("Created plugin-bundles bucket", { bucket });
      } else if (!headResp.ok) {
        throw new StorageUnavailableError(
          `MinIO HeadBucket failed: HTTP ${headResp.status}`
        );
      }

      // Apply lifecycle policy (best-effort backstop, spec §12.5).
      const lifecycleXml = `<?xml version="1.0" encoding="UTF-8"?>
<LifecycleConfiguration>
  <Rule>
    <ID>delete-expired-bundles</ID>
    <Status>Enabled</Status>
    <Filter><Prefix></Prefix></Filter>
    <Expiration><ExpiredObjectDeleteMarker>true</ExpiredObjectDeleteMarker></Expiration>
  </Rule>
</LifecycleConfiguration>`;
      const xmlBuf = Buffer.from(lifecycleXml, "utf-8");
      const lifecycleUrl = `${bucketUrl(bucket)}?lifecycle`;
      try {
        await s3Fetch("PUT", lifecycleUrl, xmlBuf, {
          "content-type": "application/xml",
        });
      } catch (err) {
        logger.warn("Failed to apply MinIO lifecycle policy (non-fatal)", {
          error: String(err),
        });
      }
    },

    async upload({ manifestId, version, bundlePath, checksum }): Promise<{ bucket: string; key: string }> {
      const key = buildBundleKey(manifestId, version);
      const url = objectUrl(bucket, key);

      // Read the file into memory for upload. Bundle max is 50MB; acceptable for upload.
      // Note: The service validates size before this point (spec §4.2).
      const bundleData = await readFile(bundlePath);

      const startMs = Date.now();
      const resp = await s3Fetch("PUT", url, bundleData, {
        "content-type": "application/javascript",
        "x-amz-meta-x-plugin-manifest-id": manifestId,
        "x-amz-meta-x-plugin-version": version,
        "x-amz-meta-x-plugin-checksum": checksum,
        "x-amz-meta-x-installed-at": new Date().toISOString(),
      });

      if (!resp.ok) {
        throw new StorageUnavailableError(
          `MinIO PutObject failed for ${key}: HTTP ${resp.status}`
        );
      }

      logger.debug("Bundle uploaded to MinIO", {
        key,
        durationMs: Date.now() - startMs,
      });

      return { bucket, key };
    },

    async download(bkt: string, key: string): Promise<{ stream: Readable; checksum: string }> {
      // HEAD to get checksum metadata before streaming.
      const headUrl = objectUrl(bkt, key);
      const headResp = await s3Fetch("HEAD", headUrl);
      if (!headResp.ok) {
        throw new StorageUnavailableError(
          `MinIO HeadObject failed for ${key}: HTTP ${headResp.status}`
        );
      }

      const checksum =
        headResp.headers.get("x-amz-meta-x-plugin-checksum") ?? "";

      // GET the object — stream to caller (spec §12.3 — no in-memory buffering).
      const getUrl = objectUrl(bkt, key);
      const signed = signRequest({
        method: "GET",
        url: getUrl,
        region,
        accessKey,
        secretKey,
        payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      });
      const { host: _h, ...getHeaders } = signed;

      const getResp = await fetch(getUrl, {
        method: "GET",
        headers: getHeaders as Record<string, string>,
      });

      if (!getResp.ok || getResp.body === null) {
        throw new StorageUnavailableError(
          `MinIO GetObject failed for ${key}: HTTP ${getResp.status}`
        );
      }

      // Convert the Web ReadableStream to a Node.js Readable.
      const { Readable } = await import("node:stream");
      const nodeStream = Readable.fromWeb(
        getResp.body as import("node:stream/web").ReadableStream<Uint8Array>
      );

      return { stream: nodeStream, checksum };
    },

    async delete(bkt: string, key: string): Promise<void> {
      const url = objectUrl(bkt, key);
      try {
        await s3Fetch("DELETE", url);
      } catch (err) {
        logger.warn("MinIO DeleteObject failed (non-fatal)", {
          key,
          error: String(err),
        });
      }
    },

    async verifyChecksum(bundlePath: string, expectedChecksum: string): Promise<void> {
      const hash = createHash("sha256");
      const stream = createReadStream(bundlePath);

      const CHECKSUM_TIMEOUT_MS = 30_000;

      const hashPromise = pipeline(stream, async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk as Buffer);
          yield chunk;
        }
      });

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          stream.destroy();
          reject(new Error(`Checksum verification timed out after ${CHECKSUM_TIMEOUT_MS}ms`));
        }, CHECKSUM_TIMEOUT_MS);
        hashPromise.finally(() => clearTimeout(timer));
      });

      try {
        await Promise.race([hashPromise, timeoutPromise]);
      } catch (err) {
        hashPromise.catch(() => {});
        timeoutPromise.catch(() => {});
        throw err;
      }

      const actual = hash.digest("hex");

      if (actual !== expectedChecksum) {
        throw new ChecksumMismatchError(
          "Bundle checksum verification failed",
          {
            expected: expectedChecksum,
            actual,
            source: "manifest.bundleChecksum vs bundle.js content",
          }
        );
      }

      // Also verify the sidecar .sha256 file (spec §4.4).
      const sidecarChecksum = (
        await readFile(bundlePath + ".sha256", "utf-8").catch(() => "")
      ).trim();

      if (sidecarChecksum.length > 0 && sidecarChecksum !== expectedChecksum) {
        throw new ChecksumMismatchError(
          "Bundle checksum verification failed",
          {
            expected: expectedChecksum,
            actual: sidecarChecksum,
            source: "manifest.bundleChecksum vs bundle.js.sha256 sidecar",
          }
        );
      }
    },

    async ping(): Promise<boolean> {
      try {
        const resp = await fetch(`${endpoint}/minio/health/live`, {
          signal: AbortSignal.timeout(5_000),
        });
        // MinIO health endpoint returns 200 when healthy.
        // Fall back to HeadBucket if health endpoint is not available.
        if (resp.status === 200) return true;
      } catch {
        // Fall through to bucket check
      }

      try {
        const url = bucketUrl(bucket);
        const resp = await s3Fetch("HEAD", url);
        return resp.ok || resp.status === 403;
      } catch {
        return false;
      }
    },
  };
}
