import { SignJWT, importPKCS8 } from "jose";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

export interface ServiceTokenSigner {
  sign(): Promise<string>;
}

export async function createServiceTokenSigner(
  serviceName: string,
  privateKeyPem: string,
): Promise<ServiceTokenSigner> {
  const privateKey = await importPKCS8(privateKeyPem, "EdDSA");

  let cached: { token: string; expiresAt: number } | null = null;

  async function sign(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    // Reuse cached token if it has at least 60s of remaining validity
    if (cached && cached.expiresAt - now > 60) {
      return cached.token;
    }

    const expiresAt = now + 300; // 5 minutes
    const token = await new SignJWT({ sub: serviceName, role: "service" as const })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .setJti(`svc-${serviceName}-${now}`)
      .sign(privateKey);

    cached = { token, expiresAt };
    return token;
  }

  return { sign };
}

export async function loadServicePrivateKey(
  serviceName: string,
  keysDir: string = "/data/service-keys",
): Promise<string> {
  const keyPath = path.join(keysDir, `${serviceName}.key.pem`);
  if (!existsSync(keyPath)) {
    throw new Error(
      `Service private key not found at ${keyPath}. ` +
      `Generate with: openssl genpkey -algorithm Ed25519 -out ${keyPath}`,
    );
  }
  return readFile(keyPath, "utf8");
}
