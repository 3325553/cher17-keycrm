import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Локальна перевірка логіки відновлення без жодного звернення до живої CRM.
 * Redis підмінено пам'яттю, HTTP-виклики CRM — керованими відповідями.
 */

const store = new Map<string, string>();
const lists = new Map<string, string[]>();
const zsets = new Map<string, Map<string, number>>();
const hashes = new Map<string, Map<string, string>>();
let writes = 0;

function list(key: string): string[] {
  let value = lists.get(key);
  if (!value) {
    value = [];
    lists.set(key, value);
  }
  return value;
}

function zset(key: string): Map<string, number> {
  let value = zsets.get(key);
  if (!value) {
    value = new Map();
    zsets.set(key, value);
  }
  return value;
}

function hash(key: string): Map<string, string> {
  let value = hashes.get(key);
  if (!value) {
    value = new Map();
    hashes.set(key, value);
  }
  return value;
}

function sortedMembers(key: string, reverse = false): string[] {
  const entries = [...zset(key).entries()].sort((a, b) => a[1] - b[1]);
  if (reverse) entries.reverse();
  return entries.map((entry) => entry[0]);
}

const fakeRedis = {
  async get(key: string) {
    return store.get(key) ?? null;
  },
  async set(key: string, value: string) {
    writes++;
    store.set(key, String(value));
    return "OK";
  },
  async setnx(key: string, value: string) {
    if (store.has(key)) return 0;
    writes++;
    store.set(key, String(value));
    return 1;
  },
  async del(...keys: string[]) {
    let removed = 0;
    for (const key of keys) {
      if (store.delete(key)) removed++;
      if (lists.delete(key)) removed++;
      if (zsets.delete(key)) removed++;
      if (hashes.delete(key)) removed++;
    }
    if (removed > 0) writes++;
    return removed;
  },
  async expire() {
    return 1;
  },
  async llen(key: string) {
    return list(key).length;
  },
  async lindex(key: string, index: number) {
    return list(key)[index] ?? null;
  },
  async rpush(key: string, ...values: string[]) {
    writes++;
    list(key).push(...values.map(String));
    return list(key).length;
  },
  async lpop(key: string) {
    const value = list(key).shift() ?? null;
    if (value != null) writes++;
    return value;
  },
  async lrem(key: string, count: number, element: string) {
    const items = list(key);
    let removed = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i] === element) {
        items.splice(i, 1);
        removed++;
        if (count !== 0 && removed >= Math.abs(count)) break;
      }
    }
    if (removed > 0) writes++;
    return removed;
  },
  async zadd(key: string, score: number, member: string) {
    writes++;
    const existed = zset(key).has(member);
    zset(key).set(String(member), Number(score));
    return existed ? 0 : 1;
  },
  async zrem(key: string, member: string) {
    const removed = zset(key).delete(String(member));
    if (removed) writes++;
    return removed ? 1 : 0;
  },
  async zcard(key: string) {
    return zset(key).size;
  },
  async zrange(key: string, start: number, stop: number, ...options: any[]) {
    const members = sortedMembers(key);
    const end = stop < 0 ? members.length + stop : stop;
    const slice = members.slice(start, end + 1);
    if (options.includes("WITHSCORES")) {
      return slice.map((member) => [member, zset(key).get(member)!]);
    }
    return slice;
  },
  async zrevrange(key: string, start: number, stop: number) {
    const members = sortedMembers(key, true);
    const end = stop < 0 ? members.length + stop : stop;
    return members.slice(start, end + 1);
  },
  async zrangebyscore(key: string, min: number, max: number, ...options: any[]) {
    const members = sortedMembers(key).filter((member) => {
      const score = zset(key).get(member)!;
      return score >= Number(min) && score <= Number(max);
    });
    const limitIndex = options.indexOf("LIMIT");
    if (limitIndex >= 0) {
      const offset = Number(options[limitIndex + 1] ?? 0);
      const count = Number(options[limitIndex + 2] ?? members.length);
      return members.slice(offset, offset + count);
    }
    return members;
  },
  async zremrangebyrank(key: string, start: number, stop: number) {
    const members = sortedMembers(key);
    const end = stop < 0 ? members.length + stop : stop;
    const doomed = members.slice(start, end + 1);
    for (const member of doomed) zset(key).delete(member);
    if (doomed.length > 0) writes++;
    return doomed.length;
  },
  async hset(key: string, field: string, value: string) {
    writes++;
    hash(key).set(field, String(value));
    return 1;
  },
  async hgetall(key: string) {
    const value = hashes.get(key);
    if (!value || value.size === 0) return null;
    return Object.fromEntries(value.entries());
  },
  async hkeys(key: string) {
    return [...hash(key).keys()];
  },
  async hdel(key: string, ...fields: string[]) {
    let removed = 0;
    for (const field of fields) if (hash(key).delete(field)) removed++;
    if (removed > 0) writes++;
    return removed;
  },
  async hincrby(key: string, field: string, amount: number) {
    writes++;
    const next = Number(hash(key).get(field) ?? 0) + Number(amount);
    hash(key).set(field, String(next));
    return next;
  },
};

mock.module("./redis", () => ({ default: fakeRedis }));

const { REDIS_KEYS } = await import("./config");
const { collectBacklog, replayOrders, parseDateParam, checkOrders } = await import("./recovery-service");
const { processOrder } = await import("./queue-service");
const { createOrUpdateOrderMapping, addStatusToHistory, getOrderMapping } = await import("./order-mapping-service");
const { isCrmRejection } = await import("./crm-guard");

type FetchCall = { method: string; path: string };
let fetchCalls: FetchCall[] = [];
let createMode: "throttle" | "ok" | "empty" = "ok";
const CREATED_ID = 55501;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetchStub() {
  fetchCalls = [];
  (globalThis as any).fetch = async (url: any, init?: any) => {
    const parsed = new URL(String(url));
    const method = String(init?.method ?? "GET").toUpperCase();
    const path = parsed.pathname + parsed.search;
    fetchCalls.push({ method, path });

    if (parsed.pathname.startsWith("/v1/pipelines/cards")) {
      return json(200, { data: [] });
    }
    if (parsed.pathname === "/v1/order" && method === "GET") {
      return json(200, { data: [] });
    }
    if (parsed.pathname === "/v1/order" && method === "POST") {
      if (createMode === "throttle") return json(429, { message: "Too Many Attempts." });
      if (createMode === "empty") return json(200, { message: "щось пішло не так" });
      return json(200, { id: CREATED_ID, source_uuid: "555" });
    }
    if (/^\/v1\/order\/\d+$/.test(parsed.pathname)) {
      const id = Number(parsed.pathname.split("/").pop());
      if (method === "GET") return json(200, { id, status_id: 1 });
      return json(200, { id, status_id: 4 });
    }
    return json(404, { message: `не очікуваний виклик ${method} ${path}` });
  };
}

function siteOrder(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    externalOrderId: id,
    externalCustomerId: `c${id}`,
    orderStatus: 1,
    paymentStatus: 1,
    totalCost: 1000,
    status: "new",
    date: Date.parse("2026-11-05T10:00:00Z"),
    email: "client@example.com",
    phone: "+380501234567",
    firstName: "Ім'я",
    lastName: "Прізвище",
    currency: "UAH",
    shipping: null,
    discount: 0,
    statusDescription: "",
    deliveryMethod: "Нова пошта",
    paymentMethod: "Оплата при отриманні",
    deliveryAddress: "Київ, відділення 1",
    additionalInfo: "",
    items: [
      {
        name: "Товар",
        category: "Категорія",
        quantity: 1,
        cost: 1000,
        url: "",
        imageUrl: "",
        description: "",
      },
    ],
    ...overrides,
  };
}

async function seedDlq(order: any, failedAt: number) {
  await fakeRedis.rpush(
    REDIS_KEYS.DEAD_LETTER_QUEUE,
    JSON.stringify({
      order,
      reason: "max_retries_exceeded",
      retryCount: 3,
      errorMessage: "CRM ID не знайдено для замовлення",
      failedAt,
    }),
  );
}

beforeEach(() => {
  store.clear();
  lists.clear();
  zsets.clear();
  hashes.clear();
  writes = 0;
  createMode = "ok";
  installFetchStub();
});

describe("межа відновлення 01.11", () => {
  test("дата без часу трактується як початок доби за Києвом", () => {
    expect(parseDateParam("2026-11-01")).toBe(Date.parse("2026-10-31T22:00:00Z"));
    expect(parseDateParam("2026-11-01", true)).toBe(Date.parse("2026-10-31T22:00:00Z") + 86399999);
    expect(parseDateParam("")).toBeNull();
  });

  test("замовлення до 01.11 не потрапляють ні в перелік, ні в підсумки", async () => {
    const old = siteOrder("900001", { date: Date.parse("2026-10-20T10:00:00Z"), totalCost: 5000 });
    const paid = siteOrder("900002", { date: Date.parse("2026-11-03T10:00:00Z"), totalCost: 1500 });
    const withCard = siteOrder("900003", { date: Date.parse("2026-11-05T10:00:00Z"), totalCost: 2000 });
    const unpaid = siteOrder("900004", {
      date: Date.parse("2026-11-06T10:00:00Z"),
      paymentStatus: 0,
      orderStatus: 0,
    });

    for (const order of [old, paid, withCard, unpaid]) {
      await seedDlq(order, Date.parse("2026-11-09T10:00:00Z"));
      await createOrUpdateOrderMapping(order, "failed");
    }
    await fakeRedis.set(REDIS_KEYS.CRM_ORDER_ID("900003"), "42646");
    await fakeRedis.set(REDIS_KEYS.ORDER_PAID_STATUS_SYNCED("900003"), "4");

    const report = await collectBacklog();

    expect(report.unique_orders).toBe(4);
    expect(report.in_window).toBe(3);
    expect(report.without_card).toBe(2);
    expect(report.with_known_card).toBe(1);
    expect(report.paid_without_card).toEqual({ count: 1, total: 1500 });
    expect(report.unpaid_without_card).toEqual({ count: 1, total: 1000 });
    expect(report.orders.map((entry) => entry.id)).toEqual(["900002", "900004"]);
    expect(Object.keys(report.paid_without_card_by_day)).toEqual(["2026-11-03"]);
    expect(report.window.since_kyiv?.startsWith("2026-11-01")).toBe(true);
  });
});

describe("керована повторна відправка", () => {
  test("dry-run нічого не записує і показує лише тих, кого нема в CRM", async () => {
    const paid = siteOrder("900002", { date: Date.parse("2026-11-03T10:00:00Z"), totalCost: 1500 });
    const withCard = siteOrder("900003", { totalCost: 2000 });
    const old = siteOrder("900001", { date: Date.parse("2026-10-20T10:00:00Z") });
    for (const order of [paid, withCard, old]) {
      await seedDlq(order, Date.now());
      await createOrUpdateOrderMapping(order, "failed");
    }
    await fakeRedis.set(REDIS_KEYS.CRM_ORDER_ID("900003"), "42646");
    await fakeRedis.set(REDIS_KEYS.ORDER_PAID_STATUS_SYNCED("900003"), "4");
    const writesBefore = writes;

    const report = await replayOrders({ dryRun: true });

    expect(writes).toBe(writesBefore);
    expect(report.dry_run).toBe(true);
    expect(report.selected).toBe(1);
    expect(report.scheduled[0]?.id).toBe("900002");
    expect(report.skipped.some((item) => item.id === "900001")).toBe(true);
    expect(report.skipped.some((item) => item.id === "900003")).toBe(true);
    expect(fetchCalls.length).toBe(0);
  });

  test("виконання знімає старі блоки, прибирає дублі й розкладає в часі", async () => {
    const paid = siteOrder("900002", { orderStatus: 2, totalCost: 1500 });
    await seedDlq(paid, Date.now());
    await createOrUpdateOrderMapping(paid, "failed");
    await fakeRedis.set(REDIS_KEYS.CREATE_LOCK("900002"), "1");
    await fakeRedis.set(REDIS_KEYS.ORDER_PROCESSED("900002", 2), "processing");
    await fakeRedis.set(REDIS_KEYS.ORDER_PAID_STATUS_SYNCED("900002"), "4");
    await fakeRedis.set(REDIS_KEYS.RETRY_COUNT("900002"), "3");
    const stale = JSON.stringify(paid);
    await fakeRedis.zadd(REDIS_KEYS.DELAYED_QUEUE, Date.now() - 1000, stale);

    const report = await replayOrders({ dryRun: false, ids: ["900002"], paceSec: 10 });

    expect(report.selected).toBe(1);
    expect(report.removed_duplicates.delayed).toBe(1);
    expect(await fakeRedis.get(REDIS_KEYS.CREATE_LOCK("900002"))).toBeNull();
    expect(await fakeRedis.get(REDIS_KEYS.ORDER_PROCESSED("900002", 2))).toBeNull();
    expect(await fakeRedis.get(REDIS_KEYS.ORDER_PAID_STATUS_SYNCED("900002"))).toBeNull();
    expect(await fakeRedis.get(REDIS_KEYS.RETRY_COUNT("900002"))).toBeNull();

    const queued = await fakeRedis.zrange(REDIS_KEYS.DELAYED_QUEUE, 0, -1, "WITHSCORES") as any[];
    expect(queued.length).toBe(1);
    expect(Number(queued[0][1])).toBeGreaterThan(Date.now());
    expect(report.scheduled[0]?.run_at).toBe(Number(queued[0][1]));
    expect(fetchCalls.length).toBe(0);
  });

  test("номер картки з позначки відновлюється, а не стирається", async () => {
    const paid = siteOrder("900005", { orderStatus: 2 });
    await createOrUpdateOrderMapping(paid, "failed");
    await fakeRedis.set(REDIS_KEYS.ORDER_PROCESSED("900005", 1), "42700");

    const report = await replayOrders({ dryRun: false, ids: ["900005"] });

    expect(await fakeRedis.get(REDIS_KEYS.CRM_ORDER_ID("900005"))).toBe("42700");
    expect(report.scheduled[0]?.reason).toContain("42700");
  });
});

describe("відмова CRM — це не успіх", () => {
  test("відмову ліміту розпізнано", () => {
    expect(isCrmRejection({ message: "Too Many Attempts.", __httpStatus: 429 })).toBe(true);
    expect(isCrmRejection({ message: "Unauthenticated." })).toBe(true);
    expect(isCrmRejection({ data: [] })).toBe(false);
    expect(isCrmRejection({ id: 1 })).toBe(false);
  });

  test("оплачене «відправлено» без картки: відмова лишає замовлення в черзі", async () => {
    createMode = "throttle";
    const order = siteOrder("900010", { orderStatus: 2 });
    await createOrUpdateOrderMapping(order, "failed");

    const success = await processOrder(JSON.stringify(order));

    expect(success).toBe(true);
    expect(await fakeRedis.get(REDIS_KEYS.CRM_ORDER_ID("900010"))).toBeNull();
    expect(await fakeRedis.get(REDIS_KEYS.ORDER_PROCESSED("900010", 2))).toBeNull();
    expect(await fakeRedis.get(REDIS_KEYS.CREATE_LOCK("900010"))).toBeNull();
    expect(await fakeRedis.get(REDIS_KEYS.ORDER_PAID_STATUS_SYNCED("900010"))).toBeNull();
    expect(await fakeRedis.zcard(REDIS_KEYS.DELAYED_QUEUE)).toBe(1);
    expect(fetchCalls.some((call) => call.method === "PUT")).toBe(false);

    const mapping = await getOrderMapping("900010");
    expect(mapping?.status_history.at(-1)?.status).toBe("retry_scheduled");
  });

  test("порожня відповідь без номера теж знімає блок і позначку", async () => {
    createMode = "empty";
    const order = siteOrder("900011", { orderStatus: 1 });
    await createOrUpdateOrderMapping(order, "failed");

    const success = await processOrder(JSON.stringify(order));

    expect(success).toBe(false);
    expect(await fakeRedis.get(REDIS_KEYS.ORDER_PROCESSED("900011", 1))).toBeNull();
    expect(await fakeRedis.get(REDIS_KEYS.CREATE_LOCK("900011"))).toBeNull();
    expect(await fakeRedis.zcard(REDIS_KEYS.DELAYED_QUEUE)).toBe(0);
  });

  test("оплачене «відправлено» без картки створюється й отримує позначку оплати", async () => {
    const order = siteOrder("900012", { orderStatus: 3 });
    await createOrUpdateOrderMapping(order, "failed");

    const success = await processOrder(JSON.stringify(order));

    expect(success).toBe(true);
    expect(await fakeRedis.get(REDIS_KEYS.CRM_ORDER_ID("900012"))).toBe(String(CREATED_ID));
    expect(await fakeRedis.get(REDIS_KEYS.ORDER_PROCESSED("900012", 3))).toBe(String(CREATED_ID));
    expect(await fakeRedis.get(REDIS_KEYS.ORDER_PAID_STATUS_SYNCED("900012"))).toBe("4");
    expect(await fakeRedis.get(REDIS_KEYS.CREATE_LOCK("900012"))).toBeNull();
    expect(fetchCalls.some((call) => call.method === "POST" && call.path === "/v1/order")).toBe(true);
    expect(fetchCalls.some((call) => call.method === "PUT")).toBe(true);

    const mapping = await getOrderMapping("900012");
    expect(String(mapping?.crm_order?.id)).toBe(String(CREATED_ID));
  });

  test("службове повідомлення не затеряє номер уже створеної картки", async () => {
    const order = siteOrder("900013");
    await createOrUpdateOrderMapping(order, "failed");
    await fakeRedis.set(REDIS_KEYS.CRM_ORDER_ID("900013"), "42646");
    await addStatusToHistory("900013", "completed", { id: 42646, source_uuid: "900013" });

    await addStatusToHistory("900013", "completed", { message: "♻️ Дубль замовлення" });

    const mapping = await getOrderMapping("900013");
    expect(String(mapping?.crm_order?.id)).toBe("42646");
    expect(mapping?.crm_order?.message).toContain("Дубль");
  });

  test("картка є, оплати нема — лише позначка оплати, без повторного створення", async () => {
    const order = siteOrder("900014", { orderStatus: 2 });
    await createOrUpdateOrderMapping(order, "failed");
    await fakeRedis.set(REDIS_KEYS.CRM_ORDER_ID("900014"), "42646");

    const success = await processOrder(JSON.stringify(order));

    expect(success).toBe(true);
    expect(fetchCalls.some((call) => call.method === "POST")).toBe(false);
    expect(await fakeRedis.get(REDIS_KEYS.ORDER_PAID_STATUS_SYNCED("900014"))).toBe("4");
  });
});

describe("звірка з CRM", () => {
  test("порожній список означає «картки немає», а відмова — «невідомо»", async () => {
    const order = siteOrder("900020");
    await createOrUpdateOrderMapping(order, "failed");

    const absent = await checkOrders(["900020"], { crm: true });
    expect(absent.results[0]?.crm_check?.state).toBe("absent");

    (globalThis as any).fetch = async () => json(429, { message: "Too Many Attempts." });
    const unknown = await checkOrders(["900020"], { crm: true });
    expect(unknown.results[0]?.crm_check?.state).toBe("unknown");
    expect(await fakeRedis.get(REDIS_KEYS.CRM_ORDER_ID("900020"))).toBeNull();
  });
});