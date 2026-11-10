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
 * Запуск:
 *   check  — лише перевірити, що в CRM (нічого не створює);
 *   send   — відправити; dry-run якщо не передано --live.
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
  crm_card_ids: string[];
  paid: boolean;
  total: number;
  date: number;
};

type Outcome = {
  id: string;
  total: number;
  state: "exists" | "created" | "paid_only" | "skipped" | "failed" | "unknown";
  card_id: string | null;
  note: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function loadCopies(path: string): OrderCopy[] {
  const pack = JSON.parse(readFileSync(path, "utf8"));
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

  if (!live) return { ...base, state: "created", card_id: null, note: "картки немає — буде створено" };

  try {
    if (Number(order.paymentStatus) === 1) await moveDuplicateLeadToPaidStatus(order);
    const created = await createCard(order);
    let note = "створено";
    if (Number(order.paymentStatus) === 1) {
      note = (await markPaid(created)) ? "створено й позначено оплату" : "створено, оплату позначити не вдалося";
    }
    return { ...base, state: "created", card_id: created, note };
  } catch (error) {
    return { ...base, state: "failed", card_id: null, note: String(error).slice(0, 120) };
  }
}

async function main() {
  const args = Bun.argv.slice(2);
  const mode = args.includes("check") ? "check" : "send";
  const live = args.includes("--live");
  const limitArg = args.find((arg) => /^--limit=\d+$/.test(arg));
  const idsArg = args.find((arg) => arg.startsWith("--ids="));
  const packPath = "/tmp/recovery_pack.json";
  const statePath = "/tmp/send_state.json";

  let copies = loadCopies(packPath);
  if (idsArg) {
    const wanted = new Set(idsArg.replace("--ids=", "").split(",").map((id) => id.trim()));
    copies = copies.filter((copy) => wanted.has(copy.id));
  }
  const limit = limitArg ? Number(limitArg.split("=")[1]) : copies.length;
  copies = copies.slice(0, limit);

  console.log(`режим: ${mode}${live ? " (жива відправка)" : " (без записів)"} | замовлень: ${copies.length}`);
  const outcomes: Outcome[] = [];
  const started = Date.now();

  for (const [index, copy] of copies.entries()) {
    const outcome = await processOne(copy, mode === "send" && live);
    outcomes.push(outcome);
    console.log(
      `${index + 1}/${copies.length}  ${copy.id}  ${Math.round(outcome.total)} грн  → ${outcome.state}` +
        `${outcome.card_id ? " (" + outcome.card_id + ")" : ""}  ${outcome.note}`,
    );
    writeFileSync(statePath, JSON.stringify({ updated: Date.now(), outcomes }, null, 0));
    if (mode === "send" && outcome.state === "failed") {
      const failed = outcomes.filter((item) => item.state === "failed").length;
      if (failed >= 10 && failed / outcomes.length > 0.3) {
        console.log("⛔ забагато відмов поспіль — зупиняюсь, щоб не палити квоту");
        break;
      }
    }
    await sleep(REQUEST_PAUSE_MS);
  }

  const summary: Record<string, number> = {};
  for (const outcome of outcomes) summary[outcome.state] = (summary[outcome.state] ?? 0) + 1;
  console.log("\nпідсумок:", JSON.stringify(summary));
  console.log(`рівень запитів: ${JSON.stringify(getCrmRequestRate())} | ${Math.round((Date.now() - started) / 1000)} с`);
}

main().catch((error) => {
  console.error("❌", error);
  process.exit(1);
});
