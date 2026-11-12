import { CONFIG } from "./config";

/**
 * CRM відповіла відмовою (ліміт, автентифікація, збій) або невідомо чим.
 * Це НЕ «картки немає»: створювати в такому стані не можна, інакше отримаємо дубль.
 */
export class CrmUnavailableError extends Error {}

/**
 * Відмови KeyCRM приходять як звичайна відповідь із тілом (HTTP 429/401/500),
 * а не як виняток, тому їх треба розпізнавати за вмістом.
 */
export function isCrmRejection(res: any): boolean {
  if (!res || typeof res !== "object") return false;
  const status = Number(res.__httpStatus ?? 0);
  if (status === 429 || status === 401 || status === 403 || status >= 500) return true;
  return /too many attempts|unauthenticated|rate limit/i.test(String(res.message ?? ""));
}

/* ------------------------------------------------------------------ */
/* Глобальний обмежувач темпу запитів до CRM                           */
/* ------------------------------------------------------------------ */

/**
 * Ключ CRM має спільний ліміт на всі запити (воркер замовлень + фіскалізація +
 * ручні перевірки). Раніше шлюз сам вичерпував квоту й отримував відмови, які
 * виглядали як «успіх». Тепер запити чекають у вікні, а не б'ються об ліміт.
 */
const requestTimestamps: number[] = [];
const WINDOW_MS = 60 * 1000;

function dropExpired(now: number): void {
  while (requestTimestamps.length > 0 && now - requestTimestamps[0]! >= WINDOW_MS) {
    requestTimestamps.shift();
  }
}

/** Чекає вільне місце у вікні ліміту й резервує його. Повертає час очікування. */
export async function awaitCrmSlot(): Promise<number> {
  const limit = Math.max(1, CONFIG.CRM_MAX_REQUESTS_PER_MIN);
  const queuedAt = Date.now();

  for (;;) {
    const now = Date.now();
    dropExpired(now);

    // Між перевіркою та записом немає await, тож два виклики не можуть
    // зарезервувати одне й те саме місце.
    if (requestTimestamps.length < limit) {
      requestTimestamps.push(now);
      return now - queuedAt;
    }

    const waitMs = WINDOW_MS - (now - requestTimestamps[0]!) + 50;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/** Скільки запитів уже витрачено за останню хвилину (для діагностики). */
export function getCrmRequestRate(): { lastMinute: number; limit: number } {
  dropExpired(Date.now());
  return {
    lastMinute: requestTimestamps.length,
    limit: Math.max(1, CONFIG.CRM_MAX_REQUESTS_PER_MIN),
  };
}