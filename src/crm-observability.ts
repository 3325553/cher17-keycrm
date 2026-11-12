import redis from "./redis";
import { CONFIG, REDIS_KEYS } from "./config";

/**
 * Книга вхідних стукотів CRM і лічильник наших звернень до неї.
 * Рядові події пишуться в Redis, а не лише в stdout: на хостингу логи контейнера
 * втрачаються, а розбирати «чи стукнула CRM по цій картці» треба тижнем пізніше.
 */

const KYIV_TIME_ZONE = "Europe/Kyiv";

function kyivDay(input: number = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: KYIV_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(input));
}

function kyivTime(input: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: KYIV_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(input));
}

/** Оперативний злімок стукоту: що саме бачив сервіс і як відповів. */
function pick(context: any) {
  return {
    crm_order_id: context?.id ?? null,
    source_uuid: context?.source_uuid ?? null,
    status_id: context?.status_id ?? null,
    fiscal_status: context?.fiscal_status ?? null,
    payment_status: context?.payment_status ?? null,
    source_id: context?.source_id ?? null,
  };
}

export async function recordFiscalizationEvent(entry: {
  crmOrderId?: string | null;
  direction: "in" | "out";
  action: string;
  detail?: string | null;
  payload?: any;
}): Promise<void> {
  const at = Date.now();
  const line = {
    at,
    time: kyivTime(at),
    direction: entry.direction,
    action: entry.action,
    crm_order_id: entry.crmOrderId ?? null,
    detail: entry.detail ?? null,
    ...(entry.direction === "in" ? pick(entry.payload) : {}),
  };

  try {
    await redis.lpush(REDIS_KEYS.FISCALIZATION_EVENTS, JSON.stringify(line));
    await redis.ltrim(
      REDIS_KEYS.FISCALIZATION_EVENTS,
      0,
      CONFIG.FISCAL_EVENT_LOG_SIZE - 1,
    );
    await redis.expire(REDIS_KEYS.FISCALIZATION_EVENTS, CONFIG.FISCAL_EVENT_LOG_TTL_SEC);
  } catch (error) {
    // Книга подій не повинна ламати обробку стукоту.
    console.error("Не вдалося записати подію фіскалізації:", error);
  }

  console.log(`🧾 fiscalization ${entry.direction} ${entry.action}: ${JSON.stringify(line)}`);
}

/**
 * Один рядок на кожне звернення до CRM: хто питав, що відповіли, скільки чекав
 * своєї черги у внутрішньому обмежувачі. Показує і вичерпану квоту, і те,
 * що стукіт було загублено не на боці CRM.
 */
export async function recordCrmCall(call: {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  waitedMs: number;
}): Promise<void> {
  const operation = normalizeOperation(call.method, call.path);
  const bucket = call.status >= 400 ? String(call.status) : "ok";

  try {
    const day = kyivDay();
    await redis.hincrby(REDIS_KEYS.CRM_CALLS_DAY(day), `${operation}:${bucket}`, 1);
    await redis.expire(REDIS_KEYS.CRM_CALLS_DAY(day), CONFIG.CRM_CALL_DAY_TTL_SEC);
  } catch (error) {
    console.error("Не вдалося порахувати звернення до CRM:", error);
  }

  // У консоль — лише те, що болить: відмови й повільні запити.
  if (call.status >= 400 || call.durationMs > 5000 || call.waitedMs > 5000) {
    console.warn(
      `🐢 CRM ${call.method} ${call.path} → HTTP ${call.status} ` +
        `(тривалість ${Math.round(call.durationMs)}мс, очікування у черзі ${Math.round(call.waitedMs)}мс)`,
    );
  }
}

function normalizeOperation(method: string, path: string): string {
  const pathname = path.split("?")[0] ?? path;

  if (pathname.startsWith("/pipelines")) return `pipelines_${method.toLowerCase()}`;
  if (/^\/order\/[^/]+$/.test(pathname)) return method === "PUT" ? "order_update" : "order_read";
  if (pathname === "/order") return method === "POST" ? "order_create" : "order_search";
  return `${pathname.replace(/^\/+/, "").replace(/\/+$/, "") || "root"}_${method.toLowerCase()}`;
}

export async function readFiscalizationEvents(limit = 50): Promise<any[]> {
  const items = (await redis.lrange(REDIS_KEYS.FISCALIZATION_EVENTS, 0, limit - 1)) ?? [];
  return items.map((item) => {
    try {
      return JSON.parse(String(item));
    } catch {
      return { action: "unparsable", raw: String(item).slice(0, 300) };
    }
  });
}

/** hgetall у клієнті повертається то об'єктом, то масивом field/value. */
function asRecord(raw: unknown): Record<string, string> {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < raw.length; i += 2) {
      out[String(raw[i])] = String(raw[i + 1]);
    }
    return out;
  }
  return raw as Record<string, string>;
}

/** Сума звернень до CRM по днях і розбивка «операція → код відповіді». */
export async function readCrmCallCounts(days = 3): Promise<any> {
  const perDay: Record<string, Record<string, number>> = {};
  const operations: Record<string, { total: number; rejected: number }> = {};

  for (let offset = 0; offset < days; offset++) {
    const day = kyivDay(Date.now() - offset * 24 * 60 * 60 * 1000);
    const hash = asRecord(await redis.hgetall(REDIS_KEYS.CRM_CALLS_DAY(day)));
    if (Object.keys(hash).length === 0) continue;

    const buckets: Record<string, number> = {};
    for (const [key, value] of Object.entries(hash)) {
      const count = Number(value ?? 0);
      buckets[key] = count;

      const [rawOperation, rawCode] = key.split(":");
      const operation = String(rawOperation ?? "unknown");
      const code = String(rawCode ?? "ok");
      const agg = (operations[operation] ??= { total: 0, rejected: 0 });
      agg.total += count;
      if (code !== "ok") agg.rejected += count;
    }
    perDay[day] = buckets;
  }

  return { days, perDay, operations };
}
