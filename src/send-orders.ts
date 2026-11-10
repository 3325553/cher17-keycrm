/**
 * Відправка замовлень у CRM зі збережених копій — без перезбирання шлюзу.
 *
 * Порядок роботи (два проходи, щоб не палити квоту CRM):
 *   прохід 1 — звірка: питаємо CRM про номер сайту одним списком карток за
 *              період, а не по запиту на замовлення;
 *   прохід 2 — для решти (перед створенням, по одному запиту):
 *              зняти дубль-лід → створити замовлення → позначити оплату.
 *
 * Запуск (усе — одна команда, ключ CRM не покидає сервер):
 *   check   — лише перевірити, що в CRM (нічого не створює);
 *   send    — відправити; без --live тільки показує план;
 *   report  — підсумок із файлу стану, без жодного запиту до CRM.
 *
 * Копії бере не з файлу, а з самого шлюзу: замовлення з 01.11, у яких є товари.
 * Так відправка працює одразу, без перезбирання і без передачі файлів.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { SDK } from "./sdk.generated";
import { convertSiteOrderToCRM, formatPhoneNumber, validateSiteOrder } from "./utils";
import { isCrmRejection, getCrmRequestRate } from "./crm-guard";

const PAID_ORDER_STATUS_ID = 4;
const DUPLICATE_LEAD_STATUS_ID = 45;
const LEAD_SEARCH_PAGE_SIZE = 50;
const LEAD_SEARCH_MAX_PAGES = 5;
const REQUEST_PAUSE_MS = 250;
const MAX_ATTEMPTS = 3;
/** Скільки карток забираємо за один запит під час звірки (стеля KeyCRM — 50). */
const CARD_SCAN_PAGE = 50;
/** Межа карток, які переглядаємо за період: 900 карток ≈ 18 запитів ≈ 1 хвилина. */
const CARD_SCAN_MAX_PAGES = 900 / CARD_SCAN_PAGE;

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

/** Картка, яку CRM уже має за період: або замовлення, або лід.
 *  Запит за номером сайту повертає номер лише для справжнього замовлення,
 *  тому лід теж треба бачити — інакше по ньому створиться дубль. */
export type CrmCard = {
  id: string;
  source_uuid: string | null;
  is_order: boolean;
  status_id: number;
  phone: string;
  email: string;
  order_refs: string[];
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

/**
 * Знімає всі картки CRM з початку листопада (замовлення й ліди) — по 50 за запит.
 * Одна така звірка замінює сотні запитів «чи є картка за цим номером».
 */
async function scanCrmCards(sinceIso: string): Promise<CrmCard[]> {
  const cards: CrmCard[] = [];

  for (let page = 1; page <= CARD_SCAN_MAX_PAGES; page++) {
    const response: any = await api.pipelines.getPaginatedListOfPipelinesCards({
      limit: CARD_SCAN_PAGE,
      page,
      include: "contact.client,status",
      filter: { created_at: `from ${sinceIso}` },
    });
    if (isCrmRejection(response)) {
      // Обірвана звірка — це не порожній CRM: не можна вважати, що карток немає.
      throw new Error(`звірка з CRM обірвалася на сторінці ${page}: ${String(response?.message ?? "відмова")}`);
    }
    const batch: any[] = Array.isArray(response?.data) ? response.data : [];
    const oldest = batch.at(-1)?.created_at;

    for (const card of batch) {
      if (!card?.id) continue;
      const title = String(card.title ?? "").toLowerCase();
      const comment = String(card.manager_comment ?? "").toLowerCase();
      const orderRefs = [title, comment]
        .flatMap((text) => text.match(/\d{5,}/g) ?? [])
        .map((ref) => String(Number(ref)));
      cards.push({
        id: String(card.id),
        source_uuid: card.source_uuid != null ? String(card.source_uuid) : null,
        is_order: String(card.target_type ?? "").toLowerCase() === "order",
        status_id: Number(card.status_id) || 0,
        phone: phoneDigits(card.contact?.phone ?? card.contact?.client?.phone),
        email: String(card.contact?.email ?? card.contact?.client?.email ?? "").trim().toLowerCase(),
        order_refs: orderRefs,
      });
    }

    if (batch.length < CARD_SCAN_PAGE) break;
    // Гортаємо назад у часі й спиняємось, щойно зайшли за межу періоду.
    if (oldest && Date.parse(String(oldest)) < SINCE_MS) break;
  }

  return cards;
}

/** Телефон у вигляді цифр для порівняння — без будь-яких перетворень. */
function phoneDigits(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

/** Чи ця картка за нашим номером: за номером сайту, номером замовлення, телефоном або поштою. */
function cardMatches(card: CrmCard, sourceUuid: string, order: any): boolean {
  if (card.source_uuid && card.source_uuid === String(sourceUuid)) return true;
  if (card.order_refs.includes(String(Number(sourceUuid)))) return true;
  const phone = phoneDigits(order.phone);
  const email = String(order.email ?? "").trim().toLowerCase();
  if (phone && card.phone === phone) return true;
  return Boolean(email) && card.email === email;
}

/** Розкладає збіги на справжнє замовлення і лід: замовлення має перевагу. */
export function matchCards(
  cards: CrmCard[],
  sourceUuid: string,
  order: any,
): { order: CrmCard | null; lead: CrmCard | null } {
  const known = cards.filter((card) => cardMatches(card, sourceUuid, order));
  return {
    order: known.find((card) => card.is_order) ?? null,
    lead: known.find((card) => !card.is_order) ?? null,
  };
}

/** Запит за номером сайту: єдине надійне джерело для справжнього замовлення. */
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
  const targetPhone = phoneDigits(order.phone);
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
 * Такий лід видно ще на звірці (картки за період), тож окремого пошуку не робимо.
 */
async function processOne(copy: OrderCopy, live: boolean, cards: CrmCard[]): Promise<Outcome> {
  const order = normalizeCopy(copy.site_order);
  const base = { id: copy.id, total: Number(order.totalCost) || 0 };

  const validation = validateSiteOrder(order);
  if (!validation.isValid) {
    return { ...base, state: "skipped", card_id: null, note: validation.errors.join(", ") };
  }

  // Прохід 1 — звірка за вже знятим списком карток: жодного запиту на замовлення.
  const { order: knownOrder, lead: knownLead } = matchCards(cards, copy.id, order);

  if (knownOrder) {
    const shouldPay = Number(order.paymentStatus) === 1;
    if (!live || !shouldPay) return { ...base, state: "exists", card_id: knownOrder.id, note: "картка вже є" };
    const paid = await markPaid(knownOrder.id);
    return {
      ...base,
      state: "paid_only",
      card_id: knownOrder.id,
      note: paid ? "оплату позначено" : "номер є, оплату позначити не вдалося",
    };
  }

  // Перед створенням — один точний запит за номером сайту (вартість: 1 запит).
  const card = await findCard(copy.id);
  if (card) {
    const shouldPay = Number(order.paymentStatus) === 1;
    if (!live || !shouldPay) return { ...base, state: "exists", card_id: card, note: "картка вже є" };
    const paid = await markPaid(card);
    return {
      ...base,
      state: "paid_only",
      card_id: card,
      note: paid ? "оплату позначено" : "номер є, оплату позначити не вдалося",
    };
  }

  // Копія могла осісти в CRM лише лідом: замовлення тоді не існує, а повтор відхиляється.
  if (!live) {
    return knownLead
      ? { ...base, state: "exists", card_id: knownLead.id, note: `є лише лід ${knownLead.id} — буде переведено в замовлення` }
      : { ...base, state: "created", card_id: null, note: "картки немає — буде створено" };
  }

  if (knownLead && knownLead.status_id === DUPLICATE_LEAD_STATUS_ID) {
    return {
      ...base,
      state: "lead_only",
      card_id: knownLead.id,
      note: "лід позначено як дубль — творення замовлення може відхилятися, потрібен ручний розбір",
    };
  }

  try {
    // Оплачене замовлення знімає дубль-лід у 45: інакше CRM вважає його дублем.
    if (Number(order.paymentStatus) === 1 && !knownLead) await moveDuplicateLeadToPaidStatus(order);
    const created = await createCard(order);
    let note = "створено";
    if (Number(order.paymentStatus) === 1) {
      note = (await markPaid(created)) ? "створено й позначено оплату" : "створено, оплату позначити не вдалося";
    }
    return { ...base, state: "created", card_id: created, note };
  } catch (error) {
    return { ...base, state: "failed", card_id: knownLead?.id ?? null, note: String(error).slice(0, 120) };
  }
}

/** Підсумок зі файлу стану: що сталося з кожним номером і що лишилося без картки. */
function printReport(): void {
  if (!existsSync(STATE_PATH)) {
    console.log("файлу стану ще немає — відправку не запускали");
    return;
  }
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  const outcomes: Outcome[] = state.outcomes ?? [];
  const sum = (list: Outcome[]) => Math.round(list.reduce((acc, item) => acc + item.total, 0));
  const by = (states: string[]) => outcomes.filter((item) => states.includes(item.state));

  console.log(`стан на ${new Date(state.updated).toLocaleString("uk-UA")}, режим: ${state.mode}${state.live ? " (живий)" : ""}`);
  console.log(`перевірено номерів: ${outcomes.length} на ${sum(outcomes)} грн`);
  console.log(`  • створено зараз:            ${by(["created"]).length} на ${sum(by(["created"]))} грн`);
  console.log(`  • картка вже була:          ${by(["exists", "paid_only"]).length} на ${sum(by(["exists", "paid_only"]))} грн`);
  console.log(`  • осіли лише лідом:          ${by(["lead_only"]).length} на ${sum(by(["lead_only"]))} грн`);
  console.log(`  • не вийшло:                 ${by(["failed"]).length} на ${sum(by(["failed"]))} грн`);
  console.log(`  • не перевірили (CRM мовчала): ${by(["unknown"]).length}`);
  console.log(`  • відсіяно до відправки:      ${by(["skipped"]).length}`);

  const left = by(["failed", "lead_only", "unknown"]);
  if (left.length > 0) {
    console.log("\nбез картки після відправки:");
    for (const item of left) console.log(`  ${item.id}  ${Math.round(item.total)} грн  ${item.state}  ${item.note}`);
  }
}

async function main() {
  const args = Bun.argv.slice(2);
  const mode = args.includes("check") ? "check" : args.includes("report") ? "report" : "send";
  const live = args.includes("--live");
  const paidOnly = !args.includes("--all");
  const limitArg = args.find((arg) => /^--limit=\d+$/.test(arg));
  const idsArg = args.find((arg) => arg.startsWith("--ids="));

  // Підсумок беремо зі збереженого стану: без запитів до CRM і до шлюзу.
  if (mode === "report") {
    printReport();
    return;
  }

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

  // Одна звірка замість запиту на кожне замовлення — так витрата квоти в межах норми.
  const sinceIso = new Date(SINCE_MS).toISOString().slice(0, 10);
  console.log(`звірка з CRM: беру картки з ${sinceIso} по ${CARD_SCAN_PAGE} за запит…`);
  const cards = await scanCrmCards(sinceIso);
  console.log(`у CRM за період карток: ${cards.length} (замовлень: ${cards.filter((c) => c.is_order).length})`);

  const outcomes: Outcome[] = [];
  const started = Date.now();
  const progress = () => {
    writeFileSync(STATE_PATH, JSON.stringify({ updated: Date.now(), mode, live, outcomes }, null, 0));
  };

  for (const [index, copy] of copies.entries()) {
    if (stopRequested) break;
    let outcome = await processOne(copy, mode === "send" && live, cards);
    if (outcome.state === "unknown") {
      // Невідомий стан не вважаємо втратою: пробуємо ще раз після паузи.
      await sleep(2000);
      outcome = await processOne(copy, mode === "send" && live, cards);
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
      const again = await processOne(copy, false, cards);
      console.log(`  ${item.id}: ${again.state}${again.card_id ? " (" + again.card_id + ")" : ""} — ${item.note}`);
      await sleep(REQUEST_PAUSE_MS);
    }
    progress();
  }
}

// Імпорт із тестів не має нічого запускати.
if (import.meta.main) {
  main().catch((error) => {
    console.error("❌", error);
    process.exit(1);
  });
}
