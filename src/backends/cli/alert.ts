export async function sendAlert(url: string | undefined, payload: Record<string, unknown>, fetchFn: typeof fetch = fetch): Promise<void> {
  if (!url) return;
  try {
    await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (e) {
    process.stderr.write(`[houtini-lm][AUTH] alert webhook failed: ${String(e)}\n`);
  }
}
