import redis from "./redis";
import { SDK } from "./sdk.generated";
import { CONFIG, REDIS_KEYS } from "./config";
import type { SiteOrder, OrderMapping } from "./types";
import {
  calculateBackoff,
  convertSiteOrderToCRM,
  convertSiteOrderToPipelineCard,
  createLeadDedupHash,
  formatPhoneNumber,
  validateSiteOrder,
  calculateOrderTotal,
} from "./utils";
import { enqueueDelayed } from "./delayed-queue";
import { CrmUnavailableError, isCrmRejection } from "./crm-guard";
import {
  createOrUpdateOrderMapping,
  addStatusToHistory,
  getOrderMapping,
} from "./order-mapping-service";

const api = new SDK("https://openapi.keycrm.app/v1", Bun.env["KEYCRM_KEY"]);
const DUPLICATE_LEAD_STATUS_ID = 45;
const PAID_ORDER_STATUS_ID = 4;
const LEAD_SEARCH_PAGE_SIZE = 50;
const LEAD_SEARCH_MAX_PAGES = 5;

function shouldDelayLeadCreation(order: SiteOrder): boolean {
  return Number(order.orderStatus) === 0 && Number(order.paymentStatus) !== 1;
}

function getCrmOrderIdKey(orderId: string): string {
  return REDIS_KEYS.CRM_ORDER_ID(orderId);
}

/**
 * Шукає картку в CRM за номером замовлення сайту.
 * Повертає null лише коли CRM справді віддала порожній список;
 * відмову або незрозумілу відповідь перетворює на виняток, щоб не створити дубль.
 */
export async function findExistingCrmOrderIdBySourceUuid(
  sourceUuid: string,
): Promise<string | null> {
  let res: any;
  try {
    res = await api.order.getOrdersBySourceUuid(sourceUuid);
  } catch (e) {
    throw new CrmUnavailableError(
      `пошук замовлення ${sourceUuid} у CRM недоступний: ${e instanceof Error ? e.message : e}`,
    );
  }

  if (isCrmRejection(res)) {
    throw new CrmUnavailableError(
      `CRM відхилила пошук замовлення ${sourceUuid}: ${String(res?.message ?? "відмова")}`,
    );
  }

  const orders: any[] = Array.isArray(res?.data)
    ? res.data
    : Array.isArray(res?.orders)
      ? res.orders
      : Array.isArray(res)
        ? res
        : [];

  // Відповідь не є списком — стан невідомий, створення відкладаємо.
  if (orders.length === 0 && !Array.isArray(res?.data) && !Array.isArray(res?.orders) && !Array.isArray(res)) {
    throw new CrmUnavailableError(
      `CRM віддала не список замовлень для ${sourceUuid}: ${String(res?.message ?? "невідома відповідь")}`,
    );
  }

  const match = orders.find((o) => String(o?.source_uuid) === String(sourceUuid));
  const id = match?.id;
  return id != null ? String(id) : null;
}

/** Результат спроби створення: картка є, щойно створена, або обробку відкладено. */
type CreateOutcome = "created" | "exists" | "deferred";

/**
 * Відкладає замовлення на пізніше замість того, щоб звітувати «готово».
 * Використовується при відмові ліміту та коли блок створення ще тримає інший воркер.
 */
async function deferOrder(
  siteOrder: SiteOrder,
  orderId: string,
  delayMs: number,
  reason: string,
): Promise<"deferred"> {
  const deferKey = REDIS_KEYS.RATE_LIMIT_DEFERS(orderId);
  const count = Number((await redis.get(deferKey)) ?? 0) + 1;

  if (count > CONFIG.MAX_RATE_LIMIT_DEFERS) {
    await redis.del(deferKey);
    throw new Error(
      `Замовлення ${orderId} відкладено ${count} разів поспіль (${reason}). Далі — звичайна черга повторів.`,
    );
  }

  await redis.set(deferKey, String(count));
  await redis.expire(deferKey, 60 * 60);

  const runAt = Date.now() + delayMs;
  await redis.set(REDIS_KEYS.RETRY_AT(orderId), String(runAt));
  await enqueueDelayed(REDIS_KEYS.DELAYED_QUEUE, JSON.stringify(siteOrder), runAt);

  await addStatusToHistory(orderId, "retry_scheduled", {
    message: `${reason} Повтор через ${Math.round(delayMs / 1000)} с (відкладення ${count}/${CONFIG.MAX_RATE_LIMIT_DEFERS}).`,
  });

  console.log(`⏳ Замовлення ${orderId} відкладено на ${Math.round(delayMs / 1000)} с: ${reason}`);
  return "deferred";
}

function normalizeDigits(value?: string | null): string {
  return (value ?? "").replace(/\D/g, "");
}

function normalizeEmail(value?: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function getPipelineCardIdFromCrmResponse(crmResponse: any): string | null {
  if (!crmResponse || typeof crmResponse !== "object") return null;
  const id = crmResponse.id;
  const hasPipelineCardShape =
    crmResponse.contact_id != null ||
    crmResponse.contact?.id != null ||
    crmResponse.target_type != null;
  if (!hasPipelineCardShape || id == null) return null;
  return String(id);
}

async function findDuplicateLeadCardByApi(
  siteOrder: SiteOrder,
  orderId: string,
): Promise<any | null> {
  const orderRef = String(orderId).toLowerCase();
  const targetPhone = normalizeDigits(formatPhoneNumber(siteOrder.phone ?? ""));
  const targetEmail = normalizeEmail(siteOrder.email);

  for (let page = 1; page <= LEAD_SEARCH_MAX_PAGES; page++) {
    const response = await api.pipelines.getPaginatedListOfPipelinesCards({
      limit: LEAD_SEARCH_PAGE_SIZE,
      page,
      include: "contact.client,status",
    });
    const cards: any[] = Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response)
        ? response
        : [];

    // Відмова CRM під час перебору — це не «дублів немає», а невідомий стан.
    if (isCrmRejection(response)) {
      throw new CrmUnavailableError(
        `CRM відхилила пошук карток для замовлення ${orderId}: ${String(response?.message ?? "відмова")}`,
      );
    }

    if (cards.length === 0) {
      return null;
    }

    const matched = cards.find((card) => {
      if (!card || card.id == null) return false;

      const targetType = String(card.target_type ?? "").toLowerCase();
      if (targetType === "order") return false;

      const title = String(card.title ?? "").toLowerCase();
      const managerComment = String(card.manager_comment ?? "").toLowerCase();
      const byOrderRef = orderRef.length > 0 &&
        (title.includes(orderRef) || managerComment.includes(orderRef));

      const contactPhone = normalizeDigits(
        card.contact?.phone ?? card.contact?.client?.phone ?? "",
      );
      const contactEmail = normalizeEmail(
        card.contact?.email ?? card.contact?.client?.email ?? "",
      );
      const byPhone = targetPhone.length > 0 && contactPhone === targetPhone;
      const byEmail = targetEmail.length > 0 && contactEmail === targetEmail;

      return byOrderRef || byPhone || byEmail;
    });

    if (matched) {
      return matched;
    }

    if (cards.length < LEAD_SEARCH_PAGE_SIZE) {
      return null;
    }
  }

  return null;
}

async function moveDuplicateLeadToPaidStatus(
  siteOrder: SiteOrder,
  orderId: string,
): Promise<void> {
  if (Number(siteOrder.paymentStatus) !== 1) {
    return;
  }

  // Спочатку пробуємо знайти лід із локального mapping для цього замовлення.
  const existingMapping = await getOrderMapping(orderId);
  const mappedCardId = getPipelineCardIdFromCrmResponse(existingMapping?.crm_order);

  let leadCard: any | null = null;
  if (mappedCardId) {
    leadCard = await api.pipelines.getPipelinesCard(mappedCardId);
  } else {
    leadCard = await findDuplicateLeadCardByApi(siteOrder, orderId);
  }

  if (!leadCard || leadCard.id == null) {
    console.log(`ℹ️ Для оплаченого замовлення ${orderId} не знайдено дубль-лід.`);
    return;
  }

  const leadCardId = String(leadCard.id);
  const currentStatusId = Number(leadCard.status_id);

  if (currentStatusId === DUPLICATE_LEAD_STATUS_ID) {
    console.log(
      `ℹ️ Лід-дубль ${leadCardId} для замовлення ${orderId} вже має status_id=${DUPLICATE_LEAD_STATUS_ID}.`,
    );
    return;
  }

  const updateResult = await api.pipelines.updatePipelinesCard(leadCardId, {
    status_id: DUPLICATE_LEAD_STATUS_ID,
  });

  if (isCrmRejection(updateResult)) {
    throw new CrmUnavailableError(
      `CRM відхилила переведення ліда ${leadCardId} для замовлення ${orderId}: ${String(updateResult?.message ?? "відмова")}`,
    );
  }

  console.log(
    `✅ Лід-дубль ${leadCardId} переведено у status_id=${DUPLICATE_LEAD_STATUS_ID} для замовлення ${orderId}.`,
  );
}

function createDlqPayload(order: SiteOrder, reason: string, retryCount: number, errorMessage?: string) {
  return JSON.stringify({
    order,
    reason,
    retryCount,
    errorMessage,
    failedAt: Date.now(),
  });
}

/**
 * Додавання замовлення в чергу обробки
 * Створює початковий запис в історії зі статусом 'pending'
 */
export async function enqueueOrder(order: SiteOrder): Promise<void> {
  // Валідація даних замовлення
  const validation = validateSiteOrder(order);
  if (!validation.isValid) {
    const errorMsg = `❌ Помилка валідації замовлення ${order.externalOrderId}: ${validation.errors.join(", ")}`;
    console.error(errorMsg);

    // Створюємо запис з помилкою
    await createOrUpdateOrderMapping(order, "failed");
    await addStatusToHistory(
      order.externalOrderId,
      "failed",
      undefined,
      errorMsg,
    );

    throw new Error(errorMsg);
  }

  // Перевірка суми замовлення
  const calculatedTotal = calculateOrderTotal(order);
  if (Math.abs(calculatedTotal - order.totalCost) > 0.01) {
    console.warn(
      `⚠️ Невідповідність суми в замовленні ${order.externalOrderId}: заявлено ${order.totalCost}, розраховано ${calculatedTotal}`,
    );
  }

  const orderData = JSON.stringify(order);
  const enqueueGuardKey = REDIS_KEYS.ORDER_ENQUEUE_GUARD(order.externalOrderId);
  const isFirstEnqueue = (await redis.setnx(enqueueGuardKey, orderData)) === 1;

  if (!isFirstEnqueue) {
    await redis.set(enqueueGuardKey, orderData);
  }
  await redis.expire(enqueueGuardKey, CONFIG.PROCESSED_MARKER_TTL_SEC);

  if (!shouldDelayLeadCreation(order)) {
    await redis.del(REDIS_KEYS.RETRY_AT(order.externalOrderId));
  }

  if (shouldDelayLeadCreation(order)) {
    const retryAt = Date.now() + CONFIG.LEAD_DELAY_MS;
    await redis.set(REDIS_KEYS.RETRY_AT(order.externalOrderId), retryAt.toString());
    await enqueueDelayed(REDIS_KEYS.DELAYED_QUEUE, orderData, retryAt);

    // Створюємо початковий запис в історії
    await createOrUpdateOrderMapping(order, "pending");

    console.log(`⏳ Лід-кандидат ${order.externalOrderId} відкладено на ${Math.round(CONFIG.LEAD_DELAY_MS / 60000)} хвилин`);
    return;
  }

  await redis.rpush(REDIS_KEYS.PENDING_QUEUE, orderData);

  // Створюємо початковий запис в історії
  await createOrUpdateOrderMapping(order, "pending");

  console.log(`✅ Замовлення ${order.externalOrderId} додано в чергу`);
}

/**
 * Створення картки воронки продаж (лід)
 */
async function createPipelineCard(
  siteOrder: SiteOrder,
  orderId: string,
): Promise<void> {
  let leadHashKey: string | null = null;
  try {
    console.log(`🎯 Створення картки воронки для замовлення ${orderId}...`);

    // Оплачені замовлення не мають потрапляти в ліди
    if (Number(siteOrder.paymentStatus) === 1) {
      const message = `💡 Замовлення ${orderId} оплачене, пропускаємо створення ліда.`;
      console.log(message);
      await addStatusToHistory(orderId, "completed", { message });
      return;
    }

    // Якщо замовлення вже існує в CRM, лід не створюємо
    const existingCrmOrderId = (await redis.get(
      getCrmOrderIdKey(siteOrder.externalOrderId),
    )) as string | null;
    if (existingCrmOrderId) {
      const message = `💡 Замовлення ${orderId} вже існує в CRM (ID: ${existingCrmOrderId}), пропускаємо створення ліда.`;
      console.log(message);
      await addStatusToHistory(orderId, "completed", {
        message,
        orderId: existingCrmOrderId,
      });
      return;
    }

    const foundCrmOrderId = await findExistingCrmOrderIdBySourceUuid(orderId);
    if (foundCrmOrderId) {
      await rememberCrmOrderId(siteOrder.externalOrderId, foundCrmOrderId);
      const message = `💡 Замовлення ${orderId} знайдено в CRM (ID: ${foundCrmOrderId}), пропускаємо створення ліда.`;
      console.log(message);
      await addStatusToHistory(orderId, "completed", {
        message,
        id: foundCrmOrderId,
        orderId: foundCrmOrderId,
      });
      return;
    }

    const leadHash = createLeadDedupHash(siteOrder);
    leadHashKey = REDIS_KEYS.LEAD_HASH(leadHash);
    const acquired = (await redis.setnx(leadHashKey, orderId)) === 1;
    if (acquired) {
      await redis.expire(leadHashKey, CONFIG.LEAD_HASH_TTL_SEC);
    }
    if (!acquired) {
      const message = `♻️ Дубль ліда, пропускаємо створення картки для ${orderId}.`;
      console.log(message);
      await addStatusToHistory(orderId, "completed", {
        message,
        lead_hash: leadHash,
      });
      return;
    }

    const crmMappingBeforeCreate = await redis.get(getCrmOrderIdKey(siteOrder.externalOrderId));
    if (crmMappingBeforeCreate) {
      const message = `💡 Перед створенням ліда вже з'явився CRM mapping (${crmMappingBeforeCreate}), пропускаємо.`;
      console.log(message);
      await addStatusToHistory(orderId, "completed", { message, orderId: crmMappingBeforeCreate });
      return;
    }

    const sourceUuidOrderBeforeCreate = await findExistingCrmOrderIdBySourceUuid(orderId);
    if (sourceUuidOrderBeforeCreate) {
      await rememberCrmOrderId(siteOrder.externalOrderId, sourceUuidOrderBeforeCreate);
      const message = `💡 Перед створенням ліда замовлення вже знайдено в CRM (${sourceUuidOrderBeforeCreate}), пропускаємо.`;
      console.log(message);
      await addStatusToHistory(orderId, "completed", { message, id: sourceUuidOrderBeforeCreate, orderId: sourceUuidOrderBeforeCreate });
      return;
    }

    const crmPipelineData = convertSiteOrderToPipelineCard(siteOrder);
    // Відмова CRM приходить як тіло з message, а не як картка — тому any.
    const crmResponse: any =
      await api.pipelines.createNewPipelineCard(crmPipelineData);

    if (isCrmRejection(crmResponse) || crmResponse?.id == null) {
      // Відмова — не успіх: знімаємо хеш ліда, щоб повтор не вважався дублем.
      if (leadHashKey) {
        await redis.del(leadHashKey);
        leadHashKey = null;
      }
      const message = `CRM не створила картку воронки для ${orderId}: ${String(crmResponse?.message ?? "порожня відповідь")}`;
      await addStatusToHistory(orderId, "failed", crmResponse, message);
      throw new CrmUnavailableError(message);
    }

    console.log(`📋 Картка воронки створена:`, crmResponse);

    // Оновлюємо історію з відповіддю CRM
    await addStatusToHistory(orderId, "completed", crmResponse);
  } catch (error) {
    const errorMessage = `Помилка створення картки воронки: ${error instanceof Error ? error.message : error}`;
    console.error(`❌ ${errorMessage}`);

    if (leadHashKey) {
      await redis.del(leadHashKey);
    }

    await addStatusToHistory(orderId, "failed", undefined, errorMessage);
    throw error;
  }
}

/** Запам'ятовує зв'язок «замовлення сайту ↔ картка CRM» в обидва боки. */
export async function rememberCrmOrderId(siteOrderId: string, crmOrderId: string): Promise<void> {
  await redis.set(getCrmOrderIdKey(siteOrderId), crmOrderId);
  await redis.set(REDIS_KEYS.CRM_ORDER_SITE_ORDER_ID(crmOrderId), siteOrderId);
}

/**
 * Створення нового замовлення в CRM
 */
async function createNewOrder(
  siteOrder: SiteOrder,
  orderId: string,
): Promise<CreateOutcome> {
  let orderProcessedKey: string | null = null;
  let createLockKey: string | null = null;
  let lockAcquired = false;
  try {
    console.log(`🛒 Створення замовлення в CRM для ${orderId}...`);

    if (Number(siteOrder.paymentStatus) === 1) {
      await moveDuplicateLeadToPaidStatus(siteOrder, orderId);
    }

    // Якщо CRM ID вже є в Redis, значить замовлення вже створено (навіть якщо подія прийшла з іншим orderStatus)
    const existingCrmOrderId = (await redis.get(
      getCrmOrderIdKey(siteOrder.externalOrderId),
    )) as string | null;
    if (existingCrmOrderId) {
      const message = `♻️ Замовлення вже існує в CRM (ID: ${existingCrmOrderId}), пропускаємо створення для ${orderId}.`;
      console.log(message);
      await addStatusToHistory(orderId, "completed", {
        message,
        id: existingCrmOrderId,
        orderId: existingCrmOrderId,
      });
      return "exists";
    }

    // Якщо Redis мапінг загубився (падіння між create та set), спробуємо знайти по source_uuid в CRM
    const foundCrmOrderId = await findExistingCrmOrderIdBySourceUuid(orderId);
    if (foundCrmOrderId) {
      await rememberCrmOrderId(siteOrder.externalOrderId, foundCrmOrderId);
      const message = `♻️ Замовлення вже існує в CRM (ID: ${foundCrmOrderId}), відновили мапінг і пропускаємо створення для ${orderId}.`;
      console.log(message);
      await addStatusToHistory(orderId, "completed", {
        message,
        id: foundCrmOrderId,
        orderId: foundCrmOrderId,
      });
      return "exists";
    }

    // Додатковий захист від дублювання створення (на випадок повторних вебхуків/ретраїв)
    createLockKey = REDIS_KEYS.CREATE_LOCK(orderId);
    lockAcquired = (await redis.setnx(createLockKey, "1")) === 1;
    if (lockAcquired) {
      await redis.expire(createLockKey, CONFIG.CREATE_LOCK_TTL_SEC);
    }
    if (!lockAcquired) {
      // Блок тримає інша спроба. Це НЕ успіх: картки ще може не бути,
      // тому відкладаємо, а не звітуємо «готово».
      return await deferOrder(
        siteOrder,
        orderId,
        CONFIG.LOCK_BUSY_RETRY_MS,
        `🔒 Створення замовлення ${orderId} ще виконується іншою спробою.`,
      );
    }

    const crmMappingBeforeCreate = await redis.get(getCrmOrderIdKey(siteOrder.externalOrderId));
    if (crmMappingBeforeCreate) {
      const message = `♻️ Після взяття create-lock уже є CRM mapping (${crmMappingBeforeCreate}), створення не потрібне.`;
      console.log(message);
      await addStatusToHistory(orderId, "completed", { message, id: crmMappingBeforeCreate, orderId: crmMappingBeforeCreate });
      return "exists";
    }

    const sourceUuidOrderBeforeCreate = await findExistingCrmOrderIdBySourceUuid(orderId);
    if (sourceUuidOrderBeforeCreate) {
      await rememberCrmOrderId(siteOrder.externalOrderId, sourceUuidOrderBeforeCreate);
      const message = `♻️ Після взяття create-lock замовлення вже знайдено в CRM (${sourceUuidOrderBeforeCreate}), створення не потрібне.`;
      console.log(message);
      await addStatusToHistory(orderId, "completed", { message, id: sourceUuidOrderBeforeCreate, orderId: sourceUuidOrderBeforeCreate });
      return "exists";
    }

    orderProcessedKey = REDIS_KEYS.ORDER_PROCESSED(orderId, siteOrder.orderStatus);
    const existingOrder = await redis.get(orderProcessedKey);

    if (existingOrder && existingOrder !== "processing") {
      // Позначка містить номер уже створеної картки — відновлюємо мапінг, щоб оплата не впала.
      await rememberCrmOrderId(siteOrder.externalOrderId, String(existingOrder));
      const message = `♻️ Дубль замовлення, картка вже створена (ID: ${existingOrder}), пропускаємо створення для ${orderId}.`;
      console.log(message);
      await addStatusToHistory(orderId, "completed", {
        message,
        id: String(existingOrder),
        orderId: String(existingOrder),
      });
      return "exists";
    }

    if (existingOrder === "processing") {
      return await deferOrder(
        siteOrder,
        orderId,
        CONFIG.LOCK_BUSY_RETRY_MS,
        `⏳ Попередня спроба створення замовлення ${orderId} ще не завершена.`,
      );
    }

    await redis.set(orderProcessedKey, "processing");
    await redis.expire(orderProcessedKey, CONFIG.PROCESSED_MARKER_TTL_SEC);

    const crmOrderData = convertSiteOrderToCRM(siteOrder);
    const orderResponse: any = await api.order.createNewOrder(crmOrderData);

    if (!orderResponse?.id) {
      // Будь-яка невдача створення знімає блок і позначку. Інакше всі повтори
      // всередині 15 хвилин звітують «готово», нічого не створивши.
      await redis.del(orderProcessedKey);
      orderProcessedKey = null;
      await redis.del(createLockKey);
      createLockKey = null;
      lockAcquired = false;

      if (isCrmRejection(orderResponse)) {
        return await deferOrder(
          siteOrder,
          orderId,
          CONFIG.RATE_LIMIT_RETRY_MS,
          `🚦 CRM відхилила створення замовлення ${orderId}: ${String(orderResponse?.message ?? "відмова")}.`,
        );
      }

      const message = `CRM не створила замовлення ${orderId}: ${String(orderResponse?.message ?? "порожня відповідь")}`;
      await addStatusToHistory(orderId, "failed", orderResponse, message);
      throw new Error(message);
    }

    const { id } = orderResponse;
    const crmOrderId = String(id);

    // Зберігаємо зв'язок ID замовлення з CRM
    await rememberCrmOrderId(siteOrder.externalOrderId, crmOrderId);
    await redis.set(orderProcessedKey!, crmOrderId);
    await redis.expire(orderProcessedKey!, CONFIG.PROCESSED_MARKER_TTL_SEC);

    // Картка створена — блок більше не потрібен, реальний захист тепер мапінг.
    await redis.del(createLockKey);
    createLockKey = null;
    lockAcquired = false;

    console.log(`📦 Замовлення створено в CRM з ID: ${crmOrderId}`);

    // Отримуємо повні дані замовлення з CRM
    let fullOrderData = orderResponse;
    try {
      fullOrderData = await api.order.getOrderById(crmOrderId);
      if (isCrmRejection(fullOrderData)) fullOrderData = orderResponse;
    } catch (fetchError) {
      console.warn(`⚠️ Не вдалося отримати повні дані замовлення:`, fetchError);
    }

    // Формуємо розширену відповідь для історії
    const enhancedCrmResponse = {
      ...fullOrderData,
      id: crmOrderId,
      payment_method: siteOrder.paymentMethod,
      payment_amount: siteOrder.totalCost,
    };

    // Оновлюємо історію з повною відповіддю CRM
    await addStatusToHistory(orderId, "completed", enhancedCrmResponse);
    return "created";
  } catch (error) {
    const errorMessage = `Помилка створення замовлення: ${error instanceof Error ? error.message : error}`;
    console.error(`❌ ${errorMessage}`);

    if (orderProcessedKey) {
      await redis.del(orderProcessedKey);
    }

    if (lockAcquired && createLockKey) {
      await redis.del(createLockKey);
    }

    await addStatusToHistory(orderId, "failed", undefined, errorMessage);
    throw error;
  }
}

/**
 * Оновлення статусу існуючого замовлення
 */
async function updateExistingOrder(
  siteOrder: SiteOrder,
  orderId: string,
  statusId: number,
): Promise<void> {
  let orderProcessedKey: string | null = null;
  try {
    // Отримуємо CRM ID замовлення
    let crmOrderId = (await redis.get(getCrmOrderIdKey(siteOrder.externalOrderId))) as string | null;

    if (!crmOrderId) {
      // Мапінг міг загубитися, хоча картка в CRM існує — відновлюємо за номером замовлення сайту.
      const restored = await findExistingCrmOrderIdBySourceUuid(orderId);
      if (restored) {
        await rememberCrmOrderId(siteOrder.externalOrderId, restored);
        crmOrderId = restored;
        console.log(`💡 Мапінг замовлення ${orderId} відновлено з CRM (ID: ${restored}).`);
      }
    }

    if (!crmOrderId) {
      throw new Error(`CRM ID не знайдено для замовлення ${orderId}`);
    }

    orderProcessedKey = REDIS_KEYS.ORDER_STATUS_UPDATE_PROCESSED(orderId, statusId);
    const existingUpdate = await redis.get(orderProcessedKey);

    if (existingUpdate) {
      const message = `♻️ Дубль оновлення статусу, пропускаємо для ${orderId}.`;
      console.log(message);
      await addStatusToHistory(orderId, "completed", {
        message,
        statusId: existingUpdate,
      });
      return;
    }

    await redis.set(orderProcessedKey, String(statusId));
    await redis.expire(orderProcessedKey, CONFIG.PROCESSED_MARKER_TTL_SEC);

    console.log(
      `🔄 Оновлення статусу замовлення ${crmOrderId} на ${statusId}...`,
    );

    const updateResponse = await api.order.updateExistingOrder(crmOrderId, {
      status_id: statusId,
    });

    if (isCrmRejection(updateResponse)) {
      throw new CrmUnavailableError(
        `CRM відхилила оновлення статусу замовлення ${orderId}: ${String(updateResponse?.message ?? "відмова")}`,
      );
    }

    console.log(`✅ Статус замовлення оновлено:`, updateResponse);

    // Оновлюємо історію з відповіддю про оновлення (номер картки не губимо)
    await addStatusToHistory(orderId, "completed", {
      ...(updateResponse ?? {}),
      id: updateResponse?.id ?? crmOrderId,
    });
  } catch (error) {
    const errorMessage = `Помилка оновлення замовлення: ${error instanceof Error ? error.message : error}`;
    console.error(`❌ ${errorMessage}`);

    if (orderProcessedKey) {
      await redis.del(orderProcessedKey);
    }

    await addStatusToHistory(orderId, "failed", undefined, errorMessage);
    throw error;
  }
}

async function syncPaidStatusOnce(
  siteOrder: SiteOrder,
  orderId: string,
): Promise<void> {
  const paidStatusSyncKey = REDIS_KEYS.ORDER_PAID_STATUS_SYNCED(orderId);
  const alreadySynced = await redis.get(paidStatusSyncKey);

  if (alreadySynced) {
    const message = `💡 Paid status для замовлення ${orderId} вже синхронізували раніше, повторний апдейт не потрібен.`;
    console.log(message);
    await addStatusToHistory(orderId, "completed", {
      message,
      statusId: Number(alreadySynced),
    });
    return;
  }

  await updateExistingOrder(siteOrder, orderId, PAID_ORDER_STATUS_ID);
  await redis.set(paidStatusSyncKey, String(PAID_ORDER_STATUS_ID));
}

/**
 * Основна функція обробки замовлення
 * Розподіляє обробку залежно від типу статусу замовлення
 */
export async function processOrder(orderData: string): Promise<boolean> {
  const siteOrder: SiteOrder = JSON.parse(orderData);
  const orderId = siteOrder.externalOrderId;
  const lockKey = REDIS_KEYS.ORDER_LOCK(orderId);

  const orderStatus = Number(siteOrder.orderStatus);
  const paymentStatus = Number(siteOrder.paymentStatus);

  let lockAcquired = false;

  try {
    lockAcquired = (await redis.setnx(lockKey, "1")) === 1;
    if (lockAcquired) {
      await redis.expire(lockKey, CONFIG.ORDER_LOCK_TTL_SEC);
    }

    if (!lockAcquired) {
      // Блок тримає інша спроба. Раніше ми звітували «готово» і губили завдання
      // назавжди. Тепер відкладаємо, щоб обробка точно відбулася.
      console.log(`🔒 Замовлення ${orderId} вже обробляється іншим воркером, відкладаємо`);
      await deferOrder(
        siteOrder,
        orderId,
        CONFIG.LOCK_BUSY_RETRY_MS,
        `🔒 Замовлення ${orderId} ще обробляється іншим воркером.`,
      );
      return true;
    }

    console.log(
      `🚀 Початок обробки замовлення ${orderId} (статус: ${orderStatus}, оплата: ${paymentStatus})`,
    );

    // Оновлюємо статус на 'processing'
    await addStatusToHistory(orderId, "processing");

    // Визначаємо тип обробки залежно від статусу замовлення
    /*
      orderStatus → 0/1/2/3 (Cart/New/Sent/Delivered)
      paymentStatus → 0/1 (Not paid/Paid)
    */
    let deferred = false;

    switch (orderStatus) {
      case 0:
        if (paymentStatus === 1) {
          // Оплачені замовлення не мають потрапляти в ліди
          deferred = (await createNewOrder(siteOrder, orderId)) === "deferred";
        } else {
          // Створення картки воронки продаж (лід)
          await createPipelineCard(siteOrder, orderId);
        }
        break;

      case 1:
        // Створення нового замовлення
        deferred = (await createNewOrder(siteOrder, orderId)) === "deferred";
        break;

      case 2:
      case 3:
        // Статуси "Відправлено"/"Доставлено" самі по собі не синхронізуємо.
        // Але ОПЛАЧЕНЕ замовлення без картки в CRM — це втрачені гроші:
        // таке треба створити, інакше позначка оплати назавжди падає.
        if (paymentStatus === 1) {
          const knownCardId = await redis.get(getCrmOrderIdKey(orderId));
          if (!knownCardId) {
            deferred = (await createNewOrder(siteOrder, orderId)) === "deferred";
          }
        }
        break;

      default:
        throw new Error(
          `Невідомий статус замовлення: ${siteOrder.orderStatus}`,
        );
    }

    // Відкладене замовлення ще не має картки — позначку оплати нема на чому ставити.
    if (deferred) {
      console.log(`⏳ Замовлення ${orderId} відкладено, обробку продовжить черга повторів`);
      return true;
    }

    if (paymentStatus === 1) {
      await syncPaidStatusOnce(siteOrder, orderId);
    }

    // Очищуємо лічильники повторних спроб
    await redis.del(REDIS_KEYS.RETRY_COUNT(orderId));
    await redis.del(REDIS_KEYS.RETRY_AT(orderId));
    await redis.del(REDIS_KEYS.RATE_LIMIT_DEFERS(orderId));

    console.log(`✅ Замовлення ${orderId} успішно оброблено`);
    return true;
  } catch (error) {
    const errorMessage = `Помилка обробки замовлення ${orderId}: ${error instanceof Error ? error.message : error}`;
    console.error(`❌ ${errorMessage}`);

    // Додаємо інформацію про помилку в історію
    await addStatusToHistory(orderId, "failed", undefined, errorMessage);

    return false;
  } finally {
    if (lockAcquired) {
      await redis.del(lockKey);
    }
  }
}

/**
 * Обробка невдалих замовлень з логікою повторних спроб
 */
export async function handleFailedOrder(orderData: string): Promise<void> {
  const siteOrder: SiteOrder = JSON.parse(orderData);
  const orderId = siteOrder.externalOrderId;

  // Отримуємо поточну кількість спроб
  const retryCountStr = await redis.get(REDIS_KEYS.RETRY_COUNT(orderId));
  const retryCount = retryCountStr ? parseInt(retryCountStr as string) : 0;

  if (retryCount >= CONFIG.MAX_RETRIES) {
    // Переміщаємо в Dead Letter Queue після максимальної кількості спроб
    console.log(
      `💀 Замовлення ${orderId} переміщено в DLQ після ${retryCount} спроб`,
    );
    const existingMapping = await getOrderMapping(orderId);
    const latestError = [...(existingMapping?.status_history || [])]
      .reverse()
      .find((entry) => entry.error_message)?.error_message;
    await redis.rpush(
      REDIS_KEYS.DEAD_LETTER_QUEUE,
      createDlqPayload(siteOrder, "max_retries_exceeded", retryCount, latestError),
    );
    await redis.del(REDIS_KEYS.RETRY_COUNT(orderId));
    await redis.del(REDIS_KEYS.RETRY_AT(orderId));
    await addStatusToHistory(orderId, "failed", undefined, `Переміщено в DLQ після ${retryCount} спроб.`, retryCount);
    return;
  }

  // Збільшуємо лічильник спроб
  const newRetryCount = retryCount + 1;
  await redis.set(REDIS_KEYS.RETRY_COUNT(orderId), newRetryCount.toString());

  // Розраховуємо час наступної спроби з експоненційною затримкою
  const backoffMs = calculateBackoff(retryCount);
  const retryAt = Date.now() + backoffMs;
  await redis.set(REDIS_KEYS.RETRY_AT(orderId), retryAt.toString());

  // Повертаємо в delayed-чергу обробки
  await enqueueDelayed(REDIS_KEYS.DELAYED_QUEUE, orderData, retryAt);

  await addStatusToHistory(
    orderId,
    "retry_scheduled",
    { message: `Retry scheduled in ${Math.round(backoffMs / 1000)}s` },
    undefined,
    newRetryCount,
  );

  console.log(
    `🔁 Замовлення ${orderId} буде повторно оброблено через ${Math.round(backoffMs / 1000)}с (спроба ${newRetryCount}/${CONFIG.MAX_RETRIES})`,
  );
}
