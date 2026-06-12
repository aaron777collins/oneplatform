export async function waitForHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // Not ready yet
    }
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  throw new Error(`Service at ${url} did not become healthy within ${timeoutMs}ms`);
}
