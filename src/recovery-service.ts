import redis from "./redis";
import { CONFIG, REDIS_KEYS } from "./config";
import type { SiteOrder, OrderMapping } from "./types";
import { addStatusToHistory } from "./order-mapping-service";
import { enqueueDelayed } from "./delayed-queue";
import { formatDateTimeKyiv, validateSiteOrder } from "./utils";
import {
  findExistingCrmOrderIdBySourceUuid,
  rememberCrmOrderId,
} from "./queue-service";

/**
 * Відновлення замовлень, які не дійшли до CRM.
 *
 * Три операції:
 *  - зібрати повний перелік замовлень без картки (за весь час, не лише останні 1000);
 *  - звірити конкретні номери з самою CRM (1 запит на номер);
 *  - керовано відправити збережені копії з паузою між ними.
 *
 * Нічого не створюється в CRM напряму: відправка йде через звичайну чергу,
 * де перед створенням завжди спрацьовує перевірка «чи вже є картка».
 */

const MAX_DLQ_SCAN = 50000;
const MAX_DELAYED_SCAN = 20000;
const MAX_QUEUE_SCAN = 5000;
const PAID_STATUS_ID = 4;
const SITE_STATUSES = [0, 1, 2, 3];

let scanInProgress = false;

export type BacklogEntry = {
  id: string;
  paid: boolean;
  order_status: number | null;
  total: number;
  currency: string | null;
  date: number | null;
  date_kyiv: string | null;
  current_status: string | null;
  known_crm_id: string | null;
  last_error: string | null;
  dlq_entries: number;
  dlq_retry_count: number;
  sources: string[];
  has_payload: boolean;
  updated_at: number | null;
};

export type BacklogReport = {
  generated_at: number;
  generated_at_kyiv: string;
  scanned: {
    dlq_entries: number;
    dlq_truncated: boolean;
    history_index: number;
    delayed: number;
    pending: number;
    processing: number;
  };
  unique_orders: number;
  /** Період, за яким рахуються підсумки (за замовчуванням від 01.11). */
  window: {
    since: number | null;
    until: number | null;
    since_kyiv: string | null;
    until_kyiv: string | null;
  };
  in_window: number;
  without_date: number;
  with_known_card: number;
  without_card: number;
  without_payload: number;
  paid_without_card: { count: number; total: number };
  unpaid_without_card: { count: number; total: number };
  paid_without_card_by_day: Record<string, { count: number; total: number }>;
  orders: BacklogEntry[];
};

type Candidate = {
  id: string;
  order: SiteOrder | null;
  sources: Set<string>;
  dlqEntries: number;
  dlqRetryCount: number;
  dlqError: string | null;
  dlqFailedAt: number | null;
  delayedPayloads: string[];
  pendingPayloads: string[];
  processingPayloads: string[];
};

function toMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function kyivDay(ms: number | null): string | null {
  if (ms == null) return null;
  try {
    return formatDateTimeKyiv(ms).slice(0, 10);
  } catch {
    return null;
  }
}

/**
 * Приймає «2026-11-01», ISO-рядок або мілісекунди.
 * Дата без часу означає початок доби за Києвом (endOfDay=true — кінець доби).
 */
export function parseDateParam(value?: string | null, endOfDay = false): number | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return null;
    return numeric > 1e12 ? numeric : numeric * 1000;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const base = Date.parse(`${raw}T00:00:00Z`);
    if (!Number.isFinite(base)) return null;
    // Зсув доби за Києвом визначаємо рендером, щоб не залежати від TZ контейнера.
    const rendered = Date.parse(`${formatDateTimeKyiv(base).replace(" ", "T")}Z`);
    const kyivMidnight = base - (rendered - base);
    return endOfDay ? kyivMidnight + 86399999 : kyivMidnight;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Табличний вигляд переліку для звірки (нічого не змінює). */
export function backlogToCsv(report: BacklogReport): string {
  const header = [
    "id", "paid", "order_status", "total", "currency", "date_kyiv",
    "current_status", "known_crm_id", "dlq_entries", "sources", "last_error",
  ];
  const escape = (value: unknown) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = report.orders.map((entry) =>
    [
      entry.id, entry.paid ? 1 : 0, entry.order_status, entry.total, entry.currency,
      entry.date_kyiv, entry.current_status, entry.known_crm_id, entry.dlq_entries,
      entry.sources.join("|"), entry.last_error,
    ].map(escape).join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

/** Картка воронки (лід) — це не замовлення, її номер не можна плутати з CRM ID. */
function isLeadCardShape(crm: any): boolean {
  return Boolean(
    crm &&
      typeof crm === "object" &&
      (crm.contact_id != null || crm.contact?.id != null || crm.target_type != null),
  );
}

function orderIdFromMapping(id: string, mapping: OrderMapping | null): string | null {
  const crm = mapping?.crm_order;
  if (!crm || typeof crm !== "object" || crm.id == null) return null;
  if (isLeadCardShape(crm)) return null;
  if (crm.source_uuid != null && String(crm.source_uuid) !== String(id)) return null;
  return String(crm.id);
}

/** Оплачена копія важливіша за неоплачену: саме вона несе гроші. */
function pickPayload(preferred: SiteOrder | null, fallback: SiteOrder | null): SiteOrder | null {
  if (!preferred) return fallback;
  if (!fallback) return preferred;
  const preferredPaid = Number(preferred.paymentStatus) === 1;
  const fallbackPaid = Number(fallback.paymentStatus) === 1;
  if (preferredPaid !== fallbackPaid) return preferredPaid ? preferred : fallback;
  return preferred;
}

function parseSiteOrder(raw: unknown): SiteOrder | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    const order = parsed?.order ?? parsed;
    if (!order || typeof order !== "object" || order.externalOrderId == null) return null;
    return order as SiteOrder;
  } catch {
    return null;
  }
}

function ensureCandidate(map: Map<string, Candidate>, id: string): Candidate {
  let candidate = map.get(id);
  if (!candidate) {
    candidate = {
      id,
      order: null,
      sources: new Set<string>(),
      dlqEntries: 0,
      dlqRetryCount: 0,
      dlqError: null,
      dlqFailedAt: null,
      delayedPayloads: [],
      pendingPayloads: [],
      processingPayloads: [],
    };
    map.set(id, candidate);
  }
  return candidate;
}

async function readList(
  key: string,
  cap: number,
): Promise<{ items: string[]; total: number; truncated: boolean }> {
  const total = Number(await redis.llen(key)) || 0;
  const limit = Math.min(total, cap);
  const items: string[] = [];
  for (let i = 0; i < limit; i++) {
    const item = await redis.lindex(key, i);
    if (typeof item === "string") items.push(item);
  }
  return { items, total, truncated: total > limit };
}

/**
 * Збирає всі відомі шлюзу номери замовлень і їхні останні копії.
 * Джерела: DLQ (за весь час), індекс історії (останні 1000), відкладена черга,
 * черги очікування та обробки. Лише читання.
 */
async function collectCandidates(): Promise<{
  candidates: Map<string, Candidate>;
  scanned: BacklogReport["scanned"];
}> {
  const candidates = new Map<string, Candidate>();

  const dlq = await readList(REDIS_KEYS.DEAD_LETTER_QUEUE, MAX_DLQ_SCAN);
  for (const raw of dlq.items) {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const order = parseSiteOrder(raw);
    if (!order) continue;
    const id = String(order.externalOrderId);
    const candidate = ensureCandidate(candidates, id);
    candidate.sources.add("dlq");
    candidate.dlqEntries += 1;

    const failedAt = toMs(parsed?.failedAt);
    if (candidate.dlqFailedAt == null || (failedAt ?? 0) >= candidate.dlqFailedAt) {
      candidate.dlqFailedAt = failedAt;
      candidate.dlqRetryCount = Number(parsed?.retryCount ?? 0) || 0;
      candidate.dlqError = parsed?.errorMessage ? String(parsed.errorMessage) : null;
      candidate.order = pickPayload(order, candidate.order);
    }
  }

  const historyIds = (await redis.zrevrange(REDIS_KEYS.ORDER_HISTORY_INDEX, 0, -1)) as string[];
  for (const id of historyIds) {
    if (!id) continue;
    ensureCandidate(candidates, String(id)).sources.add("history");
  }

  const delayed = (await redis.zrange(
    REDIS_KEYS.DELAYED_QUEUE,
    0,
    MAX_DELAYED_SCAN - 1,
  )) as string[];
  for (const raw of delayed) {
    const order = parseSiteOrder(raw);
    if (!order) continue;
    const candidate = ensureCandidate(candidates, String(order.externalOrderId));
    candidate.sources.add("delayed");
    candidate.delayedPayloads.push(raw);
    candidate.order = pickPayload(order, candidate.order);
  }

  const pending = await readList(REDIS_KEYS.PENDING_QUEUE, MAX_QUEUE_SCAN);
  for (const raw of pending.items) {
    const order = parseSiteOrder(raw);
    if (!order) continue;
    const candidate = ensureCandidate(candidates, String(order.externalOrderId));
    candidate.sources.add("pending");
    candidate.pendingPayloads.push(raw);
    candidate.order = pickPayload(order, candidate.order);
  }

  const processing = await readList(REDIS_KEYS.PROCESSING_QUEUE, MAX_QUEUE_SCAN);
  for (const raw of processing.items) {
    const order = parseSiteOrder(raw);
    if (!order) continue;
    const candidate = ensureCandidate(candidates, String(order.externalOrderId));
    candidate.sources.add("processing");
    candidate.processingPayloads.push(raw);
    candidate.order = pickPayload(order, candidate.order);
  }

  return {
    candidates,
    scanned: {
      dlq_entries: dlq.total,
      dlq_truncated: dlq.truncated,
      history_index: historyIds.length,
      delayed: delayed.length,
      pending: pending.total,
      processing: processing.total,
    },
  };
}

async function readMapping(id: string): Promise<OrderMapping | null> {
  const raw = await redis.get(REDIS_KEYS.ORDER_MAPPING(id));
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as OrderMapping;
  } catch {
    return null;
  }
}

async function mapInChunks<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    results.push(...(await Promise.all(chunk.map(fn))));
  }
  return results;
}

export type BacklogOptions = {
  paidOnly?: boolean;
  includeKnown?: boolean;
  since?: number | null;
  until?: number | null;
  limit?: number;
};

/** Повний перелік замовлень без відомої картки CRM. Лише читання. */
export async function collectBacklog(options: BacklogOptions = {}): Promise<BacklogReport> {
  if (scanInProgress) {
    throw new Error("Сканування вже виконується, зачекайте кілька секунд і повторіть.");
  }
  scanInProgress = true;

  try {
    const { candidates, scanned } = await collectCandidates();
    const ids = [...candidates.keys()];

    const entries = await mapInChunks(ids, 100, async (id): Promise<BacklogEntry> => {
      const candidate = candidates.get(id)!;
      const mapping = await readMapping(id);
      const knownKey = await redis.get(REDIS_KEYS.CRM_ORDER_ID(id));
      const knownCrmId =
        (typeof knownKey === "string" && knownKey.length > 0 ? knownKey : null) ??
        orderIdFromMapping(id, mapping);

      // Копія з мапінгу найсвіжіша: сайт оновлює її при кожній події.
      const site = pickPayload(mapping?.site_order ?? null, candidate.order);
      const date = toMs(site?.date);
      const updatedAt = mapping?.updated_at ?? candidate.dlqFailedAt ?? null;

      return {
        id,
        paid: Number(site?.paymentStatus) === 1,
        order_status: site?.orderStatus != null ? Number(site.orderStatus) : null,
        total: Number(site?.totalCost ?? 0) || 0,
        currency: site?.currency ?? null,
        date,
        date_kyiv: kyivDay(date),
        current_status: mapping?.current_status ?? null,
        known_crm_id: knownCrmId,
        last_error: candidate.dlqError,
        dlq_entries: candidate.dlqEntries,
        dlq_retry_count: candidate.dlqRetryCount,
        sources: [...candidate.sources].sort(),
        has_payload: Boolean(site),
        updated_at: updatedAt,
      };
    });

    // Нижня межа за замовчуванням — 01.11. Старіші замовлення не чіпаємо взагалі.
    const since = options.since ?? parseDateParam(CONFIG.RECOVERY_SINCE);
    const until = options.until ?? null;
    const limit = Math.max(1, Math.min(options.limit ?? 5000, 20000));

    const inWindow = entries.filter(
      (entry) =>
        entry.date != null &&
        (since == null || entry.date >= since) &&
        (until == null || entry.date <= until),
    );

    const visible = inWindow
      .filter((entry) => options.includeKnown || entry.known_crm_id == null)
      .filter((entry) => !options.paidOnly || entry.paid)
      .sort((a, b) => (a.date ?? 0) - (b.date ?? 0));

    const withoutCard = inWindow.filter((entry) => entry.known_crm_id == null);
    const paidWithoutCard = withoutCard.filter((entry) => entry.paid);
    const unpaidWithoutCard = withoutCard.filter((entry) => !entry.paid);

    const byDay: Record<string, { count: number; total: number }> = {};
    for (const entry of paidWithoutCard) {
      const day = entry.date_kyiv ?? "без дати";
      const bucket = byDay[day] ?? { count: 0, total: 0 };
      bucket.count += 1;
      bucket.total += entry.total;
      byDay[day] = bucket;
    }

    const sum = (list: BacklogEntry[]) =>
      Math.round(list.reduce((acc, entry) => acc + entry.total, 0) * 100) / 100;

    return {
      generated_at: Date.now(),
      generated_at_kyiv: formatDateTimeKyiv(Date.now()),
      scanned,
      unique_orders: entries.length,
      window: {
        since,
        until,
        since_kyiv: since == null ? null : formatDateTimeKyiv(since),
        until_kyiv: until == null ? null : formatDateTimeKyiv(until),
      },
      in_window: inWindow.length,
      without_date: entries.filter((entry) => entry.date == null).length,
      with_known_card: inWindow.length - withoutCard.length,
      without_card: withoutCard.length,
      without_payload: withoutCard.filter((entry) => !entry.has_payload).length,
      paid_without_card: { count: paidWithoutCard.length, total: sum(paidWithoutCard) },
      unpaid_without_card: { count: unpaidWithoutCard.length, total: sum(unpaidWithoutCard) },
      paid_without_card_by_day: byDay,
      orders: visible.slice(0, limit),
    };
  } finally {
    scanInProgress = false;
  }
}

export type CheckResult = {
  id: string;
  current_status: string | null;
  paid: boolean;
  total: number;
  date_kyiv: string | null;
  known_crm_id: string | null;
  paid_synced: boolean;
  crm_check?: {
    state: "exists" | "absent" | "unknown";
    crm_id: string | null;
    error?: string;
    repaired?: boolean;
  };
};

/**
 * Звірка номерів із самою CRM. Один запит на номер, тому пакет обмежений.
 * repair=true додатково відновлює загублений зв'язок «сайт ↔ картка».
 */
export async function checkOrders(
  ids: string[],
  options: { crm?: boolean; repair?: boolean } = {},
): Promise<{ checked: number; results: CheckResult[]; truncated: boolean }> {
  const unique = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
  const cap = options.crm ? CONFIG.CHECK_MAX_BATCH : 1000;
  const selected = unique.slice(0, cap);

  const results = await mapInChunks(selected, 20, async (id): Promise<CheckResult> => {
    const mapping = await readMapping(id);
    const knownKey = await redis.get(REDIS_KEYS.CRM_ORDER_ID(id));
    const knownCrmId =
      (typeof knownKey === "string" && knownKey.length > 0 ? knownKey : null) ??
      orderIdFromMapping(id, mapping);
    const paidSynced = Boolean(await redis.get(REDIS_KEYS.ORDER_PAID_STATUS_SYNCED(id)));
    const site = mapping?.site_order ?? null;

    const result: CheckResult = {
      id,
      current_status: mapping?.current_status ?? null,
      paid: Number(site?.paymentStatus) === 1,
      total: Number(site?.totalCost ?? 0) || 0,
      date_kyiv: kyivDay(toMs(site?.date)),
      known_crm_id: knownCrmId,
      paid_synced: paidSynced,
    };

    if (options.crm) {
      try {
        const found = await findExistingCrmOrderIdBySourceUuid(id);
        result.crm_check = {
          state: found ? "exists" : "absent",
          crm_id: found,
        };
        if (found && options.repair && found !== knownCrmId) {
          await rememberCrmOrderId(id, found);
          await addStatusToHistory(id, "completed", {
            id: found,
            source_uuid: id,
            message: `Звірка з CRM: картку ${found} знайдено, зв'язок відновлено.`,
          });
          result.known_crm_id = found;
          result.crm_check.repaired = true;
        }
      } catch (error) {
        result.crm_check = {
          state: "unknown",
          crm_id: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return result;
  });

  return { checked: results.length, results, truncated: unique.length > selected.length };
}

export type ReplayOptions = {
  ids?: string[];
  paidOnly?: boolean;
  since?: number | null;
  until?: number | null;
  limit?: number;
  paceSec?: number;
  force?: boolean;
  dryRun?: boolean;
};

export type ReplayPlanItem = {
  id: string;
  paid: boolean;
  total: number;
  order_status: number | null;
  date_kyiv: string | null;
  run_at: number | null;
  reason: string;
};

export type ReplayReport = {
  dry_run: boolean;
  generated_at: number;
  window: { since: number | null; until: number | null };
  considered: number;
  selected: number;
  pace_sec: number;
  batch_limit: number;
  estimated_minutes: number;
  estimated_crm_requests: number;
  selected_total: number;
  scheduled: ReplayPlanItem[];
  skipped: ReplayPlanItem[];
  queue: { delayed_before: number; delayed_after: number | null };
  removed_duplicates: { delayed: number; pending: number; processing: number };
};

/** Відновлює номер картки з усіх локальних джерел, перш ніж щось очищувати. */
async function recoverKnownCardId(
  id: string,
  mapping: OrderMapping | null,
  persist: boolean,
): Promise<string | null> {
  const knownKey = await redis.get(REDIS_KEYS.CRM_ORDER_ID(id));
  if (typeof knownKey === "string" && knownKey.length > 0) return knownKey;

  const fromMapping = orderIdFromMapping(id, mapping);
  if (fromMapping) {
    if (persist) await rememberCrmOrderId(id, fromMapping);
    return fromMapping;
  }

  // Позначка «оброблено» могла зберегти номер картки, який мапінг загубив.
  for (const status of SITE_STATUSES) {
    const marker = await redis.get(REDIS_KEYS.ORDER_PROCESSED(id, status));
    if (typeof marker === "string" && /^\d+$/.test(marker)) {
      if (persist) await rememberCrmOrderId(id, marker);
      return marker;
    }
  }

  return null;
}

/** Прибирає захисні блоки й лічильники, які лишилися від невдалих спроб. */
async function clearStaleGuards(id: string): Promise<void> {
  await redis.del(REDIS_KEYS.CREATE_LOCK(id));
  for (const status of SITE_STATUSES) {
    await redis.del(REDIS_KEYS.ORDER_PROCESSED(id, status));
  }
  await redis.del(REDIS_KEYS.ORDER_STATUS_UPDATE_PROCESSED(id, PAID_STATUS_ID));
  await redis.del(REDIS_KEYS.ORDER_PAID_STATUS_SYNCED(id));
  await redis.del(REDIS_KEYS.RETRY_COUNT(id));
  await redis.del(REDIS_KEYS.RETRY_AT(id));
  await redis.del(REDIS_KEYS.RATE_LIMIT_DEFERS(id));
}

/**
 * Керована повторна відправка зі збережених копій.
 * За замовчуванням dryRun=true: лише план, жодних дій.
 */
export async function replayOrders(options: ReplayOptions = {}): Promise<ReplayReport> {
  if (scanInProgress) {
    throw new Error("Сканування вже виконується, зачекайте кілька секунд і повторіть.");
  }
  scanInProgress = true;
  try {
    return await buildReplay(options);
  } finally {
    scanInProgress = false;
  }
}

async function buildReplay(options: ReplayOptions): Promise<ReplayReport> {
  const dryRun = options.dryRun !== false;
  const force = options.force === true;
  const paceSec = Math.max(3, Math.min(Number(options.paceSec ?? CONFIG.REPLAY_PACE_SEC) || CONFIG.REPLAY_PACE_SEC, 120));
  const batchLimit = Math.max(1, Math.min(Number(options.limit ?? CONFIG.REPLAY_MAX_BATCH) || CONFIG.REPLAY_MAX_BATCH, CONFIG.REPLAY_MAX_BATCH));

  const { candidates } = await collectCandidates();
  const delayedBefore = Number(await redis.zcard(REDIS_KEYS.DELAYED_QUEUE)) || 0;

  const requestedIds = options.ids?.length
    ? [...new Set(options.ids.map((id) => String(id).trim()).filter(Boolean))]
    : [...candidates.keys()];

  // Нижня межа за замовчуванням — 01.11, навіть коли номери передано вручну.
  const since = options.since ?? parseDateParam(CONFIG.RECOVERY_SINCE);
  const until = options.until ?? null;
  const paidOnly = options.paidOnly !== false;

  const scheduled: ReplayPlanItem[] = [];
  const skipped: ReplayPlanItem[] = [];
  const chosen: Array<{ id: string; site: SiteOrder; candidate: Candidate }> = [];
  let considered = 0;

  for (const id of requestedIds) {
    const candidate = candidates.get(id);
    const mapping = await readMapping(id);

    if (!candidate && !mapping) {
      skipped.push({
        id, paid: false, total: 0, order_status: null, date_kyiv: null, run_at: null,
        reason: "немає збереженої копії на шлюзі",
      });
      continue;
    }

    const site = pickPayload(mapping?.site_order ?? null, candidate?.order ?? null);
    if (!site) {
      skipped.push({
        id, paid: false, total: 0, order_status: null, date_kyiv: null, run_at: null,
        reason: "копія пошкоджена, відправляти нема чого",
      });
      continue;
    }

    considered += 1;
    const paid = Number(site.paymentStatus) === 1;
    const date = toMs(site.date);
    const base: ReplayPlanItem = {
      id,
      paid,
      total: Number(site.totalCost ?? 0) || 0,
      order_status: Number(site.orderStatus ?? 0),
      date_kyiv: kyivDay(date),
      run_at: null,
      reason: "",
    };

    if (paidOnly && !paid && !force) {
      skipped.push({ ...base, reason: "неоплачене в збереженій копії" });
      continue;
    }
    if (since != null && (date == null || date < since)) {
      skipped.push({ ...base, reason: "старіше за заданий період" });
      continue;
    }
    if (until != null && (date == null || date > until)) {
      skipped.push({ ...base, reason: "новіше за заданий період" });
      continue;
    }

    const validation = validateSiteOrder(site);
    if (!validation.isValid) {
      skipped.push({ ...base, reason: `копія не проходить перевірку: ${validation.errors.join(", ")}` });
      continue;
    }

    const knownCardId = await recoverKnownCardId(id, mapping, !dryRun);
    const paidSynced = Boolean(await redis.get(REDIS_KEYS.ORDER_PAID_STATUS_SYNCED(id)));

    if (knownCardId && !force) {
      if (!paid || paidSynced) {
        skipped.push({ ...base, reason: `картка вже є (${knownCardId})${paidSynced ? ", оплату позначено" : ""}` });
        continue;
      }
      chosen.push({ id, site, candidate: candidate ?? ensureCandidate(candidates, id) });
      scheduled.push({ ...base, reason: `картка є (${knownCardId}), треба позначити оплату` });
      continue;
    }

    chosen.push({ id, site, candidate: candidate ?? ensureCandidate(candidates, id) });
    scheduled.push({ ...base, reason: knownCardId ? `примусово, картка ${knownCardId}` : "картки немає, створити" });
  }

  // Хронологічний порядок: спершу найстаріші гроші.
  const orderIndex = new Map<string, number>();
  chosen
    .map((item, index) => ({ item, index, date: toMs(item.site.date) ?? 0 }))
    .sort((a, b) => a.date - b.date || a.index - b.index)
    .forEach((entry, position) => orderIndex.set(entry.item.id, position));

  const batch = chosen
    .sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0))
    .slice(0, batchLimit);

  const batchIds = new Set(batch.map((item) => item.id));
  const planItems = scheduled.filter((item) => batchIds.has(item.id));
  const overflow = scheduled.filter((item) => !batchIds.has(item.id));
  for (const item of overflow) {
    skipped.push({ ...item, reason: `не ввійшло в пакет (ліміт ${batchLimit})` });
  }

  const removed = { delayed: 0, pending: 0, processing: 0 };
  const startAt = Date.now() + 5000;

  for (let position = 0; position < batch.length; position++) {
    const item = batch[position]!;
    const runAt = startAt + position * paceSec * 1000;
    const planItem = planItems.find((entry) => entry.id === item.id);
    if (planItem) planItem.run_at = runAt;

    if (dryRun) continue;

    // Прибираємо старі копії цього ж замовлення, щоб не обробляти його двічі
    // й не витрачати квоту CRM дарма.
    for (const raw of item.candidate.delayedPayloads) {
      removed.delayed += Number(await redis.zrem(REDIS_KEYS.DELAYED_QUEUE, raw)) || 0;
    }
    for (const raw of item.candidate.pendingPayloads) {
      removed.pending += Number(await redis.lrem(REDIS_KEYS.PENDING_QUEUE, 0, raw)) || 0;
    }
    for (const raw of item.candidate.processingPayloads) {
      removed.processing += Number(await redis.lrem(REDIS_KEYS.PROCESSING_QUEUE, 0, raw)) || 0;
    }

    await clearStaleGuards(item.id);
    await enqueueDelayed(REDIS_KEYS.DELAYED_QUEUE, JSON.stringify(item.site), runAt);
    await addStatusToHistory(item.id, "retry_scheduled", {
      message: `Повторна відправка зі збереженої копії: позиція ${position + 1}/${batch.length}, через ${Math.round((runAt - Date.now()) / 1000)} с.`,
    });
  }

  const selectedTotal = Math.round(planItems.reduce((acc, item) => acc + item.total, 0) * 100) / 100;
  const estimatedRequests = planItems.reduce((acc, item) => acc + (item.reason.startsWith("картка є") ? 3 : 10), 0);

  return {
    dry_run: dryRun,
    generated_at: Date.now(),
    window: { since, until },
    considered,
    selected: batch.length,
    pace_sec: paceSec,
    batch_limit: batchLimit,
    estimated_minutes: Math.round(((batch.length * paceSec) / 60) * 10) / 10,
    estimated_crm_requests: estimatedRequests,
    selected_total: selectedTotal,
    scheduled: planItems,
    skipped,
    queue: {
      delayed_before: delayedBefore,
      delayed_after: dryRun ? null : Number(await redis.zcard(REDIS_KEYS.DELAYED_QUEUE)) || 0,
    },
    removed_duplicates: removed,
  };
}