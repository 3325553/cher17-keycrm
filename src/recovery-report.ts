/**
 * Підсумковий звіт: таблиця «було / створено / вже було / лишилось» у кількості
 * й у гривнях — без запитів до CRM. Джерела:
 *   /tmp/recovery_pack.json — копії замовлень зі шлюзу (усе вікно з 01.11);
 *   /tmp/send_state.json    — що зробив відправник (створено / вже було / збій);
 *   /tmp/crm_ids.json       — що вже було в CRM до відправки (за звіркою).
 *
 * Замовлення, яких немає в копіях шлюзу, показуються окремим списком:
 * їх можна підняти лише з боку сайту.
 */
import { existsSync, readFileSync } from "fs";
import { normalizeCopy } from "./send-orders";

const PACK = "/tmp/recovery_pack.json";
const STATE = "/tmp/send_state.json";
const CRM_BEFORE = "/tmp/crm_ids.json";

type Outcome = { id: string; total: number; state: string; card_id: string | null; note: string };

function readJson(path: string): any {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

const money = (value: number) => Math.round(value).toLocaleString("uk-UA");

/** Скільки знаків у числі — з урахуванням мінуса й розрядів. */
const width = (value: number) => money(value).length;

function table(rows: Array<[string, number, number]>): void {
  const countWidth = Math.max(...rows.map(([, count]) => String(count).length));
  const sumWidth = Math.max(...rows.map(([, , sum]) => width(sum)));
  for (const [name, count, sum] of rows) {
    console.log(
      `  ${name.padEnd(26)} ${String(count).padStart(countWidth)}   ${money(sum).padStart(sumWidth)} грн`,
    );
  }
}

function main(): void {
  const pack = readJson(PACK);
  if (!pack) {
    console.log(`немає ${PACK}: спершу запустіть check або send — вони знімають копії зі шлюзу`);
    return;
  }

  const rows: Array<{ id: string; site_order: any; paid: boolean; total: number }> = pack.rows ?? [];
  const paid = rows.filter((row) => Number(row.site_order?.paymentStatus) === 1);
  const state = readJson(STATE);
  const outcomes: Outcome[] = state?.outcomes ?? [];
  const byId = new Map(outcomes.map((item) => [item.id, item]));
  const hadBefore = new Set<string>(
    (readJson(CRM_BEFORE)?.ids ?? []).map((id: string | number) => String(id)),
  );

  console.log(`Копії замовлень з 01.11: ${rows.length}, з них оплачених: ${paid.length} на ${money(
    paid.reduce((acc, row) => acc + (Number(normalizeCopy(row.site_order).totalCost) || 0), 0),
  )} грн`);
  console.log(state ? `Відправка: ${state.live ? "жива" : "без записів"}, ${new Date(state.updated).toLocaleString("uk-UA")}` : "Відправку ще не запускали");
  if (hadBefore.size > 0) console.log(`До відправки картка вже була в CRM: ${hadBefore.size}`);

  const groups = {
    created: [] as typeof paid,
    had: [] as typeof paid,
    leadPaid: [] as typeof paid,
    left: [] as typeof paid,
    untouched: [] as typeof paid,
  };

  for (const row of paid) {
    const outcome = byId.get(row.id);
    const stateOf = outcome?.state ?? (hadBefore.has(row.id) ? "exists" : null);
    if (!stateOf) groups.untouched.push(row);
    else if (stateOf === "created") groups.created.push(row);
    else if (stateOf === "lead_paid") groups.leadPaid.push(row);
    else if (["exists", "paid_only"].includes(stateOf)) groups.had.push(row);
    else groups.left.push(row);
  }

  const sum = (list: typeof paid) =>
    list.reduce((acc, row) => acc + (Number(normalizeCopy(row.site_order).totalCost) || 0), 0);

  console.log("\nОплачені замовлення — підсумок:");
  table([
    ["було всього", paid.length, sum(paid)],
    ["картка вже була", groups.had.length, sum(groups.had)],
    ["на лічі, оплату добрано", groups.leadPaid.length, sum(groups.leadPaid)],
    ["створено зараз", groups.created.length, sum(groups.created)],
    ["не оброблено ще", groups.untouched.length, sum(groups.untouched)],
    ["лишилось без картки", groups.left.length, sum(groups.left)],
  ]);

  const reasons = new Map<string, { count: number; sum: number; note: string }>();
  for (const row of groups.left) {
    const outcome = byId.get(row.id);
    const note = outcome?.note ?? "не оброблено";
    const key = `${outcome?.state ?? "не оброблено"}: ${note.slice(0, 60)}`;
    const entry = reasons.get(key) ?? { count: 0, sum: 0, note };
    entry.count += 1;
    entry.sum += Number(normalizeCopy(row.site_order).totalCost) || 0;
    reasons.set(key, entry);
  }
  if (reasons.size > 0) {
    console.log("\nЧому лишились без картки:");
    for (const [key, entry] of [...reasons.entries()].sort((a, b) => b[1].count - a[1].count)) {
      console.log(`  ${String(entry.count).padStart(4)}  ${money(entry.sum).padStart(11)} грн  ${key}`);
    }
    console.log("\nПоіменно:");
    for (const row of groups.left) {
      const outcome = byId.get(row.id);
      const order = normalizeCopy(row.site_order);
      console.log(`  ${row.id}  ${money(Number(order.totalCost) || 0)} грн  ${outcome?.state ?? "—"}  ${outcome?.note ?? ""}`);
    }
  }

  const suspicious = paid.filter(
    (row) =>
      Number(row.site_order?.paymentStatus) === 1 &&
      /при отриманні/i.test(String(row.site_order?.paymentMethod ?? "")),
  );
  if (suspicious.length > 0) {
    console.log(`\nВарто глянути очима: ${suspicious.length} оплачених із способом «Оплата при отриманні» на ${money(sum(suspicious))} грн`);
    console.log(`  ${suspicious.slice(0, 15).map((row) => row.id).join(", ")}${suspicious.length > 15 ? " …" : ""}`);
  }
}

main();
