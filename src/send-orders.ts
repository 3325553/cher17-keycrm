/**
 * Відправка замовлень у CRM зі збережених копій — без перезбирання шлюзу.
 *
 * Для кожного номера повторює той самий захищений порядок, що й робітник:
 *   1) пошук картки в CRM за номером сайту (filter[source_uuid]);
 *   2) оплата → зняти дубль ліда в оплачений статус (щоб не створити дубль);
 *   3) створити замовлення;
 *   4) перевести оплачене в статус «оплачено»;
 *   5) доповісти, що саме сталося.
 *
 * Запуск (усе — одна команда, ключ CRM не покидає сервер):
 *   check   — лише перевірити, що в CRM (нічого не створює);
 *   send    — відправити; без --live тільки показує план;
 *   report  — підсумок: скільком замовленням змінили результат.
 *
 * Копії бере не з файлу, а з самого шлюзу: замовлення з 01.11, у яких є товари.
 * Так відправка працює одразу, без перезбирання і без передачі файлів.
 */
import { readFileSync, writeFileSync } from "fs";
import { SDK } from "./sdk.generated";
import { convertSiteOrderToCRM, formatPhoneNumber, validateSiteOrder } from "./utils";
import { isCrmRejection, getCrmRequestRate } from "./crm-guard";

const PAID_ORDER_STATUS_ID = 4;
const DUPLICATE_LEAD_STATUS_ID = 45;
const LEAD_SEARCH_PAGE_SIZE = 50;
const LEAD_SEARCH_MAX_PAGES = 5;
const REQUEST_PAUSE_MS = 250;
const MAX_ATTEMPTS = 3;

const api = new SDK("https://openapi.keycrm.app/v1", Bun.env["KEYCRM_KEY"]);

type OrderCopy = {
  id: string;
  site_order: any;
  paid: boolean;
  total: number;
  date: number;
};

type Outcome = {
  id: string;
  total: number;
  state: "exists" | "created" | "paid_only" | "skipped" | "failed" | "unknown" | "lead_only";
  card_id: string | null;
  note: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const GW = Bun.env["GATEWAY_URL"] ?? "http://127.0.0.1:3000";
const GW_AUTH = `Basic ${btoa(`${Bun.env["HISTORY_USER"] ?? "dev"}:${Bun.env["HISTORY_PASS"] ?? "dev"}`)}`;
const PACK_PATH = "/tmp/recovery_pack.json";
const STATE_PATH = "/tmp/send_state.json";
/** 01.11 за Києвом — межа, нижче якої замовлення не чіпаємо. */
const SINCE_MS = Date.parse("2026-10-31T22:00:00Z");

async function gwGet(path: string): Promise<any> {
  const res = await fetch(GW + path, { headers: { Authorization: GW_AUTH } });
  if (res.ok) return res.json();
  const cached = await Bun.file(PACK_PATH).exists();
  if (!cached) throw new Error(`шлюз віддав HTTP ${res.status} на ${path}`);
  return JSON.parse(await Bun.file(PACK_PATH).text());
}

/** Усі копії з 01.11, які шлюз ще пам'ятає (список + повна копія по кожному). */
async function pullCopies(): Promise<OrderCopy[]> {
  const seen = new Map<string, any>();
  for (const status of ["completed", "failed"]) {
    const page = await gwGet(`/history?status=${status}&limit=50000`);
    for (const order of page.orders ?? []) {
      const date = Number(order?.site_order?.date ?? 0);
      if (!date || date < SINCE_MS) continue;
      seen.set(String(order._rowid), order.site_order ?? {});
    }
  }

  const ids = [...seen.keys()];
  console.log(`у вікні з 01.11: ${ids.length}; знімаю повні копії…`);
  const copies: OrderCopy[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]!;
    try {
      const detail = await gwGet(`/history/order/${id}`);
      const site = detail?.order?.site_order ?? null;
      if (!site?.items?.length) continue;
      copies.push({
        id,
        site_order: site,
        paid: String(site.paymentStatus) === "1",
        total: Number(site.totalCost) || 0,
        date: Number(site.date) || 0,
      });
    } catch (error) {
      console.log(`  ${id}: копію не взято (${String(error).slice(0, 60)})`);
    }
    if ((index + 1) % 100 === 0) console.log(`  ${index + 1}/${ids.length}…`);
  }

  copies.sort((a, b) => a.date - b.date);
  writeFileSync(PACK_PATH, JSON.stringify({ generated_at: Date.now(), rows: copies }));
  return copies;
}

function loadCopies(): OrderCopy[] {
  const pack = JSON.parse(readFileSync(PACK_PATH, "utf8"));
  return (pack.rows as OrderCopy[])
    .filter((row) => row.site_order && row.id)
    .sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
}

/** Сума замовлення має збігатися з сумою позицій, інакше CRM відхилить картку. */
function normalizeCopy(order: any): any {
  const items = Array.isArray(order.items) ? order.items : [];
  const fromItems = items.reduce(
    (acc: number, item: any) => acc + (Number(item.cost) || 0) * (Number(item.quantity) || 0),
    0,
  );
  const discount = Number(order.discount) || 0;
  const total = Number(order.totalCost) || 0;
  if (total > 0) return order;
  if (fromItems <= 0) return order;
  return { ...order, discount: discount >= fromItems ? 0 : discount, totalCost: fromItems };
}

/** Пошук картки в CRM за номером сайту. Повертає null лише на справді порожню відповідь. */
async function findCard(sourceUuid: string): Promise<string | null> {
  let lastError = "CRM не відповіла";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res: any = await api.order.getOrdersBySourceUuid(sourceUuid);
      if (isCrmRejection(res)) {
        lastError = String(res?.message ?? "відмова CRM");
      } else {
        const list: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        const match = list.find((order) => String(order?.source_uuid) === String(sourceUuid));
        if (match?.id) return String(match.id);
        if (Array.isArray(res?.data) || Array.isArray(res)) return null;
        lastError = "незрозуміла відповідь CRM";
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(REQUEST_PAUSE_MS * attempt * 4);
  }
  throw new Error(lastError);
}

/** Знімає дубль ліда в статус 45 — без цього CRM відмовляє створювати оплачене замовлення. */
async function moveDuplicateLeadToPaidStatus(order: any): Promise<void> {
  const orderRef = String(order.externalOrderId).toLowerCase();
  const targetPhone = formatPhoneNumber(String(order.phone ?? "")).replace(/\D/g, "");
  const targetEmail = String(order.email ?? "").trim().toLowerCase();

  for (let page = 1; page <= LEAD_SEARCH_MAX_PAGES; page++) {
    const response: any = await api.pipelines.getPaginatedListOfPipelinesCards({
      limit: LEAD_SEARCH_PAGE_SIZE,
      page,
      include: "contact.client,status",
    });
    if (isCrmRejection(response)) return;
    const cards: any[] = Array.isArray(response?.data) ? response.data : [];
    if (cards.length === 0) return;

    const match = cards.find((card: any) => {
      if (!card || card.id == null) return false;
      if (String(card.target_type ?? "").toLowerCase() === "order") return false;
      const title = String(card.title ?? "").toLowerCase();
      const comment = String(card.manager_comment ?? "").toLowerCase();
      const byOrderRef = title.includes(orderRef) || comment.includes(orderRef);
      const cardPhone = formatPhoneNumber(String(card.contact?.phone ?? card.contact?.client?.phone ?? "")).replace(/\D/g, "");
      const cardEmail = String(card.contact?.email ?? card.contact?.client?.email ?? "").trim().toLowerCase();
      return (
        byOrderRef ||
        (targetPhone.length > 0 && cardPhone === targetPhone) ||
        (targetEmail.length > 0 && cardEmail === targetEmail)
      );
    });

    if (match) {
      if (Number(match.status_id) === DUPLICATE_LEAD_STATUS_ID) return;
      const updated: any = await api.pipelines.updatePipelinesCard(String(match.id), {
        status_id: DUPLICATE_LEAD_STATUS_ID,
      });
      if (!isCrmRejection(updated)) return;
    }
    if (cards.length < LEAD_SEARCH_PAGE_SIZE) return;
  }
}

async function markPaid(cardId: string): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res: any = await api.order.updateExistingOrder(cardId, { status_id: PAID_ORDER_STATUS_ID });
    if (!isCrmRejection(res)) return true;
    await sleep(REQUEST_PAUSE_MS * attempt * 4);
  }
  return false;
}

async function createCard(order: any): Promise<string> {
  let lastError = "CRM не прийняла замовлення";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const body = convertSiteOrderToCRM(order);
    const res: any = await api.order.createNewOrder(body as any);
    if (res?.id) return String(res.id);
    if (isCrmRejection(res)) {
      lastError = String(res?.message ?? "відмова CRM");
    } else {
      lastError = String(res?.message ?? JSON.stringify(res).slice(0, 160));
      // CRM відповіла змістовною помилкою — повторювати те саме немає сенсу.
      if (!/too many|timeout|network|unavailable/i.test(lastError)) break;
    }
    await sleep(REQUEST_PAUSE_MS * attempt * 4);
  }
  throw new Error(lastError);
}

/**
 * Замовлення могло потрапити в CRM лише як картка воронки (лід).
 * Тоді замовлення «не існує», хоча картка є — і CRM його більше не прийме.
 * Знаходимо таку картку за номером замовлення, телефоном або поштою.
 */
async function findLeadCard(order: any): Promise<{ id: string; status_id: number } | null> {
  const orderRef = String(order.externalOrderId).toLowerCase();
  const targetPhone = formatPhoneNumber(String(order.phone ?? "")).replace(/\D/g, "");
  const targetEmail = String(order.email ?? "").trim().toLowerCase();

  for (let page = 1; page <= LEAD_SEARCH_MAX_PAGES; page++) {
    const response: any = await api.pipelines.getPaginatedListOfPipelinesCards({
      limit: LEAD_SEARCH_PAGE_SIZE,
      page,
      include: "contact.client,status",
    });
    if (isCrmRejection(response)) return null;
    const cards: any[] = Array.isArray(response?.data) ? response.data : [];
    if (cards.length === 0) return null;

    const match = cards.find((card: any) => {
      if (!card || card.id == null) return false;
      if (String(card.target_type ?? "").toLowerCase() === "order") return false;
      const title = String(card.title ?? "").toLowerCase();
      const comment = String(card.manager_comment ?? "").toLowerCase();
      const byOrderRef = title.includes(orderRef) || comment.includes(orderRef);
      const cardPhone = formatPhoneNumber(String(card.contact?.phone ?? card.contact?.client?.phone ?? "")).replace(/\D/g, "");
      const cardEmail = String(card.contact?.email ?? card.contact?.client?.email ?? "").trim().toLowerCase();
      return (
        byOrderRef ||
        (targetPhone.length > 0 && cardPhone === targetPhone) ||
        (targetEmail.length > 0 && cardEmail === targetEmail)
      );
    });

    if (match) return { id: String(match.id), status_id: Number(match.status_id) };
    if (cards.length < LEAD_SEARCH_PAGE_SIZE) return null;
  }
  return null;
}

async function processOne(copy: OrderCopy, live: boolean): Promise<Outcome> {
  const order = normalizeCopy(copy.site_order);
  const base = { id: copy.id, total: Number(order.totalCost) || 0 };

  const validation = validateSiteOrder(order);
  if (!validation.isValid) {
    return { ...base, state: "skipped", card_id: null, note: validation.errors.join(", ") };
  }

  let card: string | null;
  try {
    card = await findCard(copy.id);
  } catch (error) {
    return { ...base, state: "unknown", card_id: null, note: `перевірка неможлива: ${String(error).slice(0, 80)}` };
  }

  if (card) {
    const shouldPay = Number(order.paymentStatus) === 1;
    if (!live) return { ...base, state: "exists", card_id: card, note: "картка вже є" };
    if (shouldPay) {
      const paid = await markPaid(card);
      return { ...base, state: "paid_only", card_id: card, note: paid ? "оплату позначено" : "номер є, оплату позначити не вдалося" };
    }
    return { ...base, state: "exists", card_id: card, note: "картка вже є" };
  }

  // Копія могла осісти в CRM лише лідом: замовлення тоді не існує, а повтор відхиляється.
  let lead: { id: string; status_id: number } | null = null;
  try {
    lead = await findLeadCard(order);
  } catch {
    lead = null;
  }

  if (!live) {
    return lead
      ? { ...base, state: "exists", card_id: null, note: `є лише лід ${lead.id} — буде переведено в замовлення` }
      : { ...base, state: "created", card_id: null, note: "картки немає — буде створено" };
  }

  if (lead && lead.status_id === DUPLICATE_LEAD_STATUS_ID) {
    return {
      ...base,
      state: "lead_only",
      card_id: lead.id,
      note: "лід позначено як дубль — творення замовлення може відхилятися, потрібен ручний розбір",
    };
  }

  try {
    // Оплачене замовлення знімає дубль-лід у 45: інакше CRM вважає його дублем.
    if (Number(order.paymentStatus) === 1) await moveDuplicateLeadToPaidStatus(order);
    const created = await createCard(order);
    let note = "створено";
    if (Number(order.paymentStatus) === 1) {
      note = (await markPaid(created)) ? "створено й позначено оплату" : "створено, оплату позначити не вдалося";
    }
    return { ...base, state: "created", card_id: created, note };
  } catch (error) {
    return { ...base, state: "failed", card_id: lead?.id ?? null, note: String(error).slice(0, 120) };
  }
}

async function main() {
  const args = Bun.argv.slice(2);
  const mode = args.includes("check") ? "check" : args.includes("report") ? "report" : "send";
  const live = args.includes("--live");
  const paidOnly = !args.includes("--all");
  const limitArg = args.find((arg) => /^--limit=\d+$/.test(arg));
  const idsArg = args.find((arg) => arg.startsWith("--ids="));

  // Переривання з клавіатури не має лишати нас без підсумку.
  let stopRequested = false;
  process.on("SIGINT", () => {
    stopRequested = true;
    console.log("\n⏹  зупинка після поточного замовлення…");
  });

  const pulled = await pullCopies();
  let copies = pulled;
  if (paidOnly) copies = copies.filter((copy) => copy.paid);
  if (idsArg) {
    const wanted = new Set(idsArg.replace("--ids=", "").split(",").map((id) => id.trim()));
    copies = copies.filter((copy) => wanted.has(copy.id));
  }
  const limit = limitArg ? Number(limitArg.split("=")[1]) : copies.length;
  copies = copies.slice(0, limit);

  const total = copies.reduce((acc, copy) => acc + (Number(copy.site_order.totalCost) || 0), 0);
  console.log(
    `режим: ${mode}${live ? " (жива відправка)" : " (без записів)"} | замовлень: ${copies.length} на ${Math.round(total)} грн`,
  );

  const outcomes: Outcome[] = [];
  const started = Date.now();
  const progress = () => {
    writeFileSync(STATE_PATH, JSON.stringify({ updated: Date.now(), mode, live, outcomes }, null, 0));
  };

  for (const [index, copy] of copies.entries()) {
    if (stopRequested) break;
    let outcome = await processOne(copy, mode === "send" && live);
    if (outcome.state === "unknown") {
      // Невідомий стан не вважаємо втратою: пробуємо ще раз після паузи.
      await sleep(2000);
      outcome = await processOne(copy, mode === "send" && live);
    }
    outcomes.push(outcome);
    console.log(
      `${index + 1}/${copies.length}  ${copy.id}  ${Math.round(outcome.total)} грн  → ${outcome.state}` +
        `${outcome.card_id ? " (" + outcome.card_id + ")" : ""}  ${outcome.note}`,
    );
    progress();

    if (mode === "send" && live) {
      const failed = outcomes.filter((item) => item.state === "failed").length;
      if (failed >= 10 && failed / outcomes.length > 0.3) {
        console.log("⛔ забагато відмов — зупиняюсь, щоб не палити квоту");
        break;
      }
    }
    await sleep(REQUEST_PAUSE_MS);
  }

  const summary: Record<string, number> = {};
  for (const outcome of outcomes) summary[outcome.state] = (summary[outcome.state] ?? 0) + 1;
  const created = outcomes.filter((item) => item.state === "created");
  const exists = outcomes.filter((item) => item.state === "exists" || item.state === "paid_only");
  console.log("\nпідсумок:", JSON.stringify(summary));
  console.log(
    `отримали картку: ${created.length} на ${Math.round(created.reduce((acc, item) => acc + item.total, 0))} грн` +
      ` | картка вже була: ${exists.length} | не вийшло: ${summary.failed ?? 0}`,
  );
  console.log(`рівень запитів: ${JSON.stringify(getCrmRequestRate())} | ${Math.round((Date.now() - started) / 1000)} с`);

  if (mode === "send" && live) {
    console.log("\nконтрольний прохід по номерах, які не отримали картку…");
    const leftover = outcomes.filter((item) => item.state === "failed");
    for (const item of leftover) {
      const copy = copies.find((entry) => entry.id === item.id)!;
      const again = await processOne(copy, false);
      console.log(`  ${item.id}: ${again.state}${again.card_id ? " (" + again.card_id + ")" : ""} — ${item.note}`);
      await sleep(REQUEST_PAUSE_MS);
    }
  }
}

main().catch((error) => {
  console.error("❌", error);
  process.exit(1);
});
