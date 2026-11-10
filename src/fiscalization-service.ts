import redis from "./redis";
import { SDK } from "./sdk.generated";
import { CONFIG, REDIS_KEYS } from "./config";
import { addStatusToHistory, getOrderMapping } from "./order-mapping-service";
import { calculateBackoff } from "./utils";
import { enqueueDelayed } from "./delayed-queue";
import { CrmUnavailableError, isCrmRejection } from "./crm-guard";

const api = new SDK("https://openapi.keycrm.app/v1", Bun.env["KEYCRM_KEY"]);
const BAS_STATUS_ID = 4;
const FISCALIZATION_STATUS_ID = 2;

export interface FiscalizationWebhookPayload {
  event?: string;
  context?: {
    id?: number | string;
    source_uuid?: string | null;
    status_id?: number | string;
    fiscal_status?: string | null;
    updated_at?: string | null;
    [key: string]: any;
  };
}

function normalizeFiscalStatus(value?: string | null): string {
  return String(value ?? "").trim().toLowerCase();
}

function resolveRetryDelay(retryCount: number): number {
  return Math.min(
    CONFIG.FISCALIZATION_MAX_BACKOFF_MS,
    Math.max(
      CONFIG.FISCALIZATION_INITIAL_BACKOFF_MS,
      calculateBackoff(retryCount),
    ),
  );
}

async function resolveSiteOrderId(
  crmOrderId: string,
  sourceUuid?: string | null,
): Promise<string> {
  if (sourceUuid) {
    return String(sourceUuid);
  }

  const mapped = await redis.get(REDIS_KEYS.CRM_ORDER_SITE_ORDER_ID(crmOrderId));
  if (mapped) {
    return String(mapped);
  }

  try {
    const order: any = await api.order.getOrderById(crmOrderId);
    // Відмова CRM — не «замовлення без source_uuid», зв'язок не псуємо.
    if (isCrmRejection(order)) {
      return crmOrderId;
    }
    const derivedSiteOrderId = String(order?.source_uuid || crmOrderId);

    if (derivedSiteOrderId && derivedSiteOrderId !== "null") {
      await redis.set(REDIS_KEYS.CRM_ORDER_SITE_ORDER_ID(crmOrderId), derivedSiteOrderId);
      await redis.set(REDIS_KEYS.CRM_ORDER_ID(derivedSiteOrderId), crmOrderId);
      return derivedSiteOrderId;
    }
  } catch (error) {
    console.warn(`⚠️ Не вдалося підтягнути order ${crmOrderId} для визначення source_uuid`, error);
  }

  return crmOrderId;
}

async function appendFiscalizationHistory(
  crmOrderId: string,
  status: string,
  sourceUuid?: string | null,
  crmResponse?: any,
  errorMessage?: string,
  retryCount?: number,
): Promise<void> {
  const siteOrderId = await resolveSiteOrderId(crmOrderId, sourceUuid);
  await addStatusToHistory(siteOrderId, status, crmResponse, errorMessage, retryCount);
}

function createFiscalizationDlqPayload(
  crmOrderId: string,
  sourceUuid: string | null | undefined,
  reason: string,
  retryCount: number,
  errorMessage?: string,
) {
  return JSON.stringify({
    crmOrderId,
    sourceUuid: sourceUuid ?? null,
    reason,
    retryCount,
    errorMessage,
    failedAt: Date.now(),
  });
}

export async function enqueueFiscalizationWatch(
  crmOrderId: string,
  sourceUuid?: string | null,
  crmResponse?: any,
): Promise<{ queued: boolean; reason?: string }> {
  const doneMarker = await redis.get(REDIS_KEYS.FISCALIZATION_DONE(crmOrderId));
  if (doneMarker) {
    await appendFiscalizationHistory(
      crmOrderId,
      "fiscalization_skip_done",
      sourceUuid,
      { message: `Замовлення ${crmOrderId} вже передано в BAS раніше.` },
    );
    return { queued: false, reason: "already_done" };
  }

  const watchKey = REDIS_KEYS.FISCALIZATION_WATCH(crmOrderId);
  const inserted = (await redis.setnx(watchKey, "1")) === 1;

  if (!inserted) {
    await appendFiscalizationHistory(
      crmOrderId,
      "fiscalization_watch_exists",
      sourceUuid,
      { message: `Замовлення ${crmOrderId} вже стоїть у watch.` },
    );
    return { queued: false, reason: "already_watching" };
  }

  await redis.expire(watchKey, CONFIG.FISCALIZATION_WATCH_TTL_SEC);
  await redis.del(REDIS_KEYS.FISCALIZATION_RETRY_COUNT(crmOrderId));
  await redis.del(REDIS_KEYS.FISCALIZATION_RETRY_AT(crmOrderId));
  const payload = JSON.stringify({ crmOrderId, sourceUuid: sourceUuid ?? null });
  const firstRunAt = Date.now() + CONFIG.FISCALIZATION_INITIAL_BACKOFF_MS;
  await redis.set(REDIS_KEYS.FISCALIZATION_RETRY_AT(crmOrderId), String(firstRunAt));
  await enqueueDelayed(
    REDIS_KEYS.FISCALIZATION_DELAYED_QUEUE,
    payload,
    firstRunAt,
  );

  await appendFiscalizationHistory(
    crmOrderId,
    "fiscalization_watch_started",
    sourceUuid,
    crmResponse || { message: `Запущено watch для фіскалізації замовлення ${crmOrderId}.` },
  );

  return { queued: true };
}

export async function moveFiscalizedOrderToBas(
  crmOrderId: string,
  sourceUuid?: string | null,
  crmResponse?: any,
): Promise<{ moved: boolean; reason?: string }> {
  const doneKey = REDIS_KEYS.FISCALIZATION_DONE(crmOrderId);
  const doneMarker = await redis.get(doneKey);
  if (doneMarker) {
    return { moved: false, reason: "already_done" };
  }

  const order: any = await api.order.getOrderById(crmOrderId);
  if (isCrmRejection(order)) {
    // Інакше відмова ліміту виглядала б як «статус змінився» і watch закрився назавжди.
    throw new CrmUnavailableError(
      `CRM відхилила читання замовлення ${crmOrderId}: ${String(order?.message ?? "відмова")}`,
    );
  }
  const currentStatusId = Number(order?.status_id);
  const fiscalStatus = normalizeFiscalStatus(order?.fiscal_status);

  if (currentStatusId !== FISCALIZATION_STATUS_ID) {
    await appendFiscalizationHistory(
      crmOrderId,
      "fiscalization_stop_status_changed",
      sourceUuid ?? order?.source_uuid,
      { message: `Фіскалізація завершена/неактуальна: поточний status_id=${currentStatusId}.` },
    );
    await clearFiscalizationWatch(crmOrderId);
    return { moved: false, reason: "status_changed" };
  }

  if (fiscalStatus !== "done") {
    return { moved: false, reason: "not_done" };
  }

  const updateResponse = await api.order.updateExistingOrder(crmOrderId, {
    status_id: BAS_STATUS_ID,
  });

  if (isCrmRejection(updateResponse)) {
    throw new CrmUnavailableError(
      `CRM відхилила переведення замовлення ${crmOrderId} в BAS: ${String(updateResponse?.message ?? "відмова")}`,
    );
  }

  await redis.set(doneKey, String(BAS_STATUS_ID));
  await clearFiscalizationWatch(crmOrderId);
  await appendFiscalizationHistory(
    crmOrderId,
    "fiscalization_moved_to_bas",
    sourceUuid ?? order?.source_uuid,
    updateResponse,
  );

  return { moved: true };
}

export async function handleFiscalizationWebhook(
  payload: FiscalizationWebhookPayload,
): Promise<{ success: boolean; action: string; crmOrderId?: string }> {
  const crmOrderId = String(payload?.context?.id ?? "").trim();
  if (!crmOrderId) {
    throw new Error("Fiscalization webhook: context.id is required");
  }

  const sourceUuid = payload.context?.source_uuid ?? null;
  const statusId = Number(payload.context?.status_id);
  const fiscalStatus = normalizeFiscalStatus(payload.context?.fiscal_status);

  await appendFiscalizationHistory(
    crmOrderId,
    "fiscalization_webhook_received",
    sourceUuid,
    payload.context,
  );

  if (statusId !== FISCALIZATION_STATUS_ID) {
    await appendFiscalizationHistory(
      crmOrderId,
      "fiscalization_ignored_status",
      sourceUuid,
      { message: `Webhook проігноровано: status_id=${statusId}` },
    );
    return { success: true, action: "ignored", crmOrderId };
  }

  if (fiscalStatus === "done") {
    const result = await moveFiscalizedOrderToBas(crmOrderId, sourceUuid, payload.context);
    return { success: true, action: result.moved ? "moved_to_bas" : String(result.reason || "noop"), crmOrderId };
  }

  const result = await enqueueFiscalizationWatch(crmOrderId, sourceUuid, payload.context);
  return { success: true, action: result.queued ? "watch_started" : String(result.reason || "noop"), crmOrderId };
}

export async function clearFiscalizationWatch(crmOrderId: string): Promise<void> {
  await redis.del(REDIS_KEYS.FISCALIZATION_WATCH(crmOrderId));
  await redis.del(REDIS_KEYS.FISCALIZATION_RETRY_COUNT(crmOrderId));
  await redis.del(REDIS_KEYS.FISCALIZATION_RETRY_AT(crmOrderId));
}

export async function requeueFiscalizationWatch(
  crmOrderId: string,
  sourceUuid?: string | null,
): Promise<void> {
  const retryKey = REDIS_KEYS.FISCALIZATION_RETRY_COUNT(crmOrderId);
  const retryCount = Number((await redis.get(retryKey)) || 0) + 1;

  if (retryCount > CONFIG.FISCALIZATION_MAX_RETRIES) {
    const timeoutMessage = `Перевищено ліміт перевірок фіскалізації (${CONFIG.FISCALIZATION_MAX_RETRIES}).`;
    await appendFiscalizationHistory(
      crmOrderId,
      "fiscalization_watch_timeout",
      sourceUuid,
      undefined,
      timeoutMessage,
      retryCount,
    );
    await redis.rpush(
      REDIS_KEYS.FISCALIZATION_DEAD_LETTER_QUEUE,
      createFiscalizationDlqPayload(
        crmOrderId,
        sourceUuid,
        "max_retries_exceeded",
        retryCount,
        timeoutMessage,
      ),
    );
    await clearFiscalizationWatch(crmOrderId);
    return;
  }

  const backoffMs = resolveRetryDelay(retryCount - 1);
  const retryAt = Date.now() + backoffMs;

  await redis.set(retryKey, String(retryCount));
  await redis.set(REDIS_KEYS.FISCALIZATION_RETRY_AT(crmOrderId), String(retryAt));
  await enqueueDelayed(
    REDIS_KEYS.FISCALIZATION_DELAYED_QUEUE,
    JSON.stringify({ crmOrderId, sourceUuid: sourceUuid ?? null }),
    retryAt,
  );

  await appendFiscalizationHistory(
    crmOrderId,
    "fiscalization_watch_retry",
    sourceUuid,
    { message: `Фіскалізація ще не завершена, повторна перевірка через ${Math.round(backoffMs / 1000)}с.` },
    undefined,
    retryCount,
  );
}

export async function processFiscalizationWatchItem(
  rawItem: string,
): Promise<void> {
  const { crmOrderId, sourceUuid } = JSON.parse(rawItem) as {
    crmOrderId: string;
    sourceUuid?: string | null;
  };

  const doneMarker = await redis.get(REDIS_KEYS.FISCALIZATION_DONE(crmOrderId));
  if (doneMarker) {
    await clearFiscalizationWatch(crmOrderId);
    return;
  }

  const watchMarker = await redis.get(REDIS_KEYS.FISCALIZATION_WATCH(crmOrderId));
  if (!watchMarker) {
    return;
  }

  const retryAtValue = await redis.get(REDIS_KEYS.FISCALIZATION_RETRY_AT(crmOrderId));
  if (retryAtValue && Date.now() < Number(retryAtValue)) {
    await enqueueDelayed(
      REDIS_KEYS.FISCALIZATION_DELAYED_QUEUE,
      rawItem,
      Number(retryAtValue),
    );
    return;
  }

  try {
    const order: any = await api.order.getOrderById(crmOrderId);
    if (isCrmRejection(order)) {
      throw new CrmUnavailableError(
        `CRM відхилила перевірку фіскалізації ${crmOrderId}: ${String(order?.message ?? "відмова")}`,
      );
    }
    const currentStatusId = Number(order?.status_id);
    const fiscalStatus = normalizeFiscalStatus(order?.fiscal_status);
    const resolvedSourceUuid = sourceUuid ?? order?.source_uuid ?? null;

    await appendFiscalizationHistory(
      crmOrderId,
      "fiscalization_poll_checked",
      resolvedSourceUuid,
      {
        id: order?.id,
        status_id: order?.status_id,
        fiscal_status: order?.fiscal_status,
        updated_at: order?.updated_at,
      },
    );

    if (currentStatusId !== FISCALIZATION_STATUS_ID) {
      await appendFiscalizationHistory(
        crmOrderId,
        "fiscalization_stop_status_changed",
        resolvedSourceUuid,
        { message: `Watch зупинено: status_id змінився на ${currentStatusId}.` },
      );
      await clearFiscalizationWatch(crmOrderId);
      return;
    }

    if (fiscalStatus === "done") {
      await moveFiscalizedOrderToBas(crmOrderId, resolvedSourceUuid, order);
      return;
    }

    await requeueFiscalizationWatch(crmOrderId, resolvedSourceUuid);
  } catch (error) {
    const message = `Помилка перевірки фіскалізації: ${error instanceof Error ? error.message : error}`;
    await appendFiscalizationHistory(
      crmOrderId,
      "fiscalization_watch_error",
      sourceUuid,
      undefined,
      message,
    );
    await requeueFiscalizationWatch(crmOrderId, sourceUuid);
  }
}
