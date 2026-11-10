/**
 * Відправник не має права створити дубль: звірка мусить узгоджувати номер сайту,
 * номер у заголовку картки й контакти. Перевіряємо це без мережі.
 */
import { describe, test, expect } from "bun:test";
import { matchCards, normalizeCopy, type CrmCard } from "./send-orders";

function card(overrides: Partial<CrmCard>): CrmCard {
  return {
    id: "1",
    source_uuid: null,
    is_order: false,
    status_id: 1,
    phone: "",
    email: "",
    order_refs: [],
    ...overrides,
  };
}

describe("звірка з готовим списком карток CRM", () => {
  test("замовлення знаходиться за номером сайту", () => {
    const cards = [card({ id: "10", source_uuid: "381162", is_order: true })];
    const found = matchCards(cards, "381162", { phone: "+380501112233", email: "a@b.c" });
    expect(found.order?.id).toBe("10");
    expect(found.lead).toBeNull();
  });

  test("лід знаходиться за номером замовлення в заголовку", () => {
    const cards = [card({ id: "11", order_refs: ["381162"] })];
    const found = matchCards(cards, "381162", { phone: "", email: "" });
    expect(found.lead?.id).toBe("11");
    expect(found.order).toBeNull();
  });

  test("збіг за телефоном не приховує картку іншого номера", () => {
    // У картці телефон уже нормалізований сканером — той самий номер, отже картка наша.
    const cards = [card({ id: "12", order_refs: ["381163"], phone: "380501112233" })];
    const found = matchCards(cards, "381162", { phone: "+380501112233", email: "" });
    expect(found.lead?.id).toBe("12");
  });

  test("стороння картка без збігів не вважається нашою", () => {
    const cards = [card({ id: "13", order_refs: ["111111"], phone: "+380509999999", email: "x@y.z" })];
    const found = matchCards(cards, "381162", { phone: "+380501112233", email: "a@b.c" });
    expect(found.order).toBeNull();
    expect(found.lead).toBeNull();
  });

  test("справжнє замовлення важливіше за лід того ж номера", () => {
    const cards = [
      card({ id: "20", order_refs: ["381162"] }),
      card({ id: "21", source_uuid: "381162", is_order: true }),
    ];
    const found = matchCards(cards, "381162", { phone: "", email: "" });
    expect(found.order?.id).toBe("21");
    expect(found.lead?.id).toBe("20");
  });
});

describe("сума замовлення перед створенням картки", () => {
  const certificate = {
    externalOrderId: "379491",
    paymentStatus: 1,
    paymentMethod: "Оплата сертифікатом",
    totalCost: 0,
    discount: 1799,
    items: [{ name: "Боді", cost: 1799, quantity: 1 }],
  };

  test("оплата сертифікатом: сума береться з позицій, знижка знімається", () => {
    const fixed = normalizeCopy(certificate);
    expect(fixed.totalCost).toBe(1799);
    expect(fixed.discount).toBe(0);
  });

  test("оплата при отриманні з нульовою сумою не вигадує грошей", () => {
    const cash = { ...certificate, paymentStatus: 0, paymentMethod: "Оплата при отриманні" };
    expect(normalizeCopy(cash).totalCost).toBe(0);
  });

  test("замовлення зі справжньою сумою не змінюється", () => {
    const normal = { ...certificate, totalCost: 3609, discount: 190 };
    expect(normalizeCopy(normal)).toBe(normal);
  });
});
