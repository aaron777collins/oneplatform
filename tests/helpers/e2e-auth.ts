const AUTH_URL = process.env.OP_AUTH_URL ?? "http://localhost:13001";

export async function getToken(tenantId: string, email: string, password: string): Promise<string> {
  const regRes = await fetch(`${AUTH_URL}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, tenantId }),
  });
  if (regRes.status !== 201) {
    const body = await regRes.text();
    throw new Error(`Register failed (${regRes.status}): ${body}`);
  }

  const regBody = await regRes.json() as { accessToken?: string };
  if (regBody.accessToken !== undefined) {
    return regBody.accessToken;
  }

  const loginRes = await fetch(`${AUTH_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, tenantId }),
  });
  if (loginRes.status !== 200) {
    const body = await loginRes.text();
    throw new Error(`Login failed (${loginRes.status}): ${body}`);
  }
  const loginBody = await loginRes.json() as { accessToken: string };
  return loginBody.accessToken;
}
