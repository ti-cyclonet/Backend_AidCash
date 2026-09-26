/**
 * Reporta a Authoriza el consumo de plataformas externas (Cloudinary, Belvo…)
 * para los indicadores de costos. Acumula en memoria y envía en lote cada
 * minuto: nunca bloquea ni hace fallar la operación que lo origina.
 * Requiere AUTHORIZA_API_URL e INTERNAL_API_KEY; sin la clave no reporta.
 */
type UsageEvent = { platform: string; metric: string; quantity: number; tenantId?: string | null };

const APPLICATION = 'Kiri';
const FLUSH_MS = 60_000;
const pending = new Map<string, UsageEvent & { application: string; day: string }>();
let timer: ReturnType<typeof setInterval> | null = null;

const today = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

export function reportPlatformUsage(event: UsageEvent): void {
  if (!process.env.INTERNAL_API_KEY || !(event.quantity > 0)) return;
  const day = today();
  const key = [day, event.tenantId || '-', event.platform, event.metric].join('|');
  const current = pending.get(key);
  if (current) current.quantity += event.quantity;
  else pending.set(key, { ...event, application: APPLICATION, day });
  if (!timer) {
    timer = setInterval(() => void flushPlatformUsage(), FLUSH_MS);
    timer.unref?.();
  }
}

export async function flushPlatformUsage(): Promise<void> {
  if (!pending.size) return;
  const events = [...pending.values()];
  pending.clear();
  const base = (process.env.AUTHORIZA_API_URL || process.env.AUTHORIZA_URL || 'http://localhost:3000').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/platform-costs/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    // Se reintenta en el siguiente ciclo (acotado para no crecer sin límite)
    if (pending.size < 1000) {
      for (const e of events) {
        const key = [e.day, e.tenantId || '-', e.platform, e.metric].join('|');
        const current = pending.get(key);
        if (current) current.quantity += e.quantity;
        else pending.set(key, e);
      }
    }
    console.warn(`[platform-usage] No se pudo reportar consumo a Authoriza: ${(err as Error).message}`);
  }
}
