import { Elysia, t } from "elysia";
import { CONFIG, REDIS_KEYS } from "./config";
import type { SiteOrder, OrderMapping } from "./types";
import { enqueueOrder } from "./queue-service";
import {
  collectBacklog,
  buildSnapshot,
  backlogToCsv,
  checkOrders,
  replayOrders,
  parseDateParam,
} from "./recovery-service";
import { getCrmRequestRate } from "./crm-guard";
import {
  readCrmCallCounts,
  readFiscalizationEvents,
  recordFiscalizationEvent,
} from "./crm-observability";
import {
  getOrderHistory,
  getOrderHistoryLegacy,
  getOrderHistoryCount,
  getOrderMappingsByStatus,
  getOrderMapping,
  cleanHistory,
  getHistoryStats,
} from "./order-mapping-service";
import { renderHistoryPage } from "./history-ui.tsx";
import historyAppScript from "./history-app.js" with { type: "text" };
import historyStyles from "./history.generated.css" with { type: "text" };
import redis from "./redis";
import { handleFiscalizationWebhook, enqueueFiscalizationWatch } from "./fiscalization-service";
import { getDelayedQueueCount, getNextDelayedRunAt } from "./delayed-queue";
import { getWorkerStats } from "./worker-observability";

export function createWebhookServer() {
  const HISTORY_SEARCH_LIMIT = 1000;
  const DEFAULT_PAGE_SIZE = 10;
  const MAX_PAGE_SIZE = 100;
  const HISTORY_BASIC_AUTH_USERNAME = Bun.env["HISTORY_USERNAME"] || "dev";
  const HISTORY_BASIC_AUTH_PASSWORD = Bun.env["HISTORY_PASSWORD"] || "dev";

  function isAuthorizedHistoryRequest(headers: Record<string, string | undefined>) {
    const authorization = headers.authorization || headers.Authorization;
    if (!authorization || !authorization.startsWith("Basic ")) {
      return false;
    }

    try {
      const encoded = authorization.slice("Basic ".length);
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const [username, ...rest] = decoded.split(":");
      const password = rest.join(":");
      return username === HISTORY_BASIC_AUTH_USERNAME && password === HISTORY_BASIC_AUTH_PASSWORD;
    } catch {
      return false;
    }
  }

  function logWebhookReceipt(type: string, payload: Record<string, unknown>) {
    console.log(`📥 ${type}: ${JSON.stringify(payload)}`);
  }

  function summarizeSiteOrder(order: Partial<SiteOrder> | undefined) {
    return {
      externalOrderId: order?.externalOrderId ?? null,
      orderStatus: order?.orderStatus ?? null,
      paymentStatus: order?.paymentStatus ?? null,
      source: order?.source ?? null,
      totalCost: order?.totalCost ?? null,
    };
  }

  function summarizeWebhookOrders(orders: unknown[]) {
    const normalizedOrders = Array.isArray(orders) ? orders : [];
    return {
      count: normalizedOrders.length,
      orders: normalizedOrders.slice(0, 10).map((order) => summarizeSiteOrder(order as Partial<SiteOrder>)),
      truncated: normalizedOrders.length > 10,
    };
  }

  function summarizeFiscalizationPayload(body: any) {
    return {
      event: body?.event ?? null,
      id: body?.context?.id ?? null,
      source_id: body?.context?.source_id ?? null,
      source_uuid: body?.context?.source_uuid ?? null,
      status_id: body?.context?.status_id ?? null,
      fiscal_status: body?.context?.fiscal_status ?? null,
      payment_status: body?.context?.payment_status ?? null,
      updated_at: body?.context?.updated_at ?? null,
    };
  }

  async function getQueueMeta(order: OrderMapping) {
    const retryAtRaw = await redis.get(REDIS_KEYS.RETRY_AT(order._rowid));
    const retryAt = retryAtRaw ? Number(retryAtRaw) : null;
    const isDelayedLead = Boolean(
      retryAt &&
      retryAt > Date.now() &&
      Number(order.site_order?.orderStatus) === 0 &&
      Number(order.site_order?.paymentStatus) !== 1,
    );

    return {
      retry_at: retryAt,
      is_delayed_lead: isDelayedLead,
      delay_minutes: isDelayedLead && retryAt ? Math.max(0, Math.ceil((retryAt - Date.now()) / 60000)) : null,
    };
  }

  function getLatestHistorySummary(order: OrderMapping) {
    const latest = [...(order.status_history || [])].reverse().find((entry) =>
      entry.error_message || entry.crm_response || entry.status,
    );

    return latest
      ? {
          status: latest.status,
          date: latest.date,
          error_message: latest.error_message,
          retry_count: latest.retry_count,
          crm_message: latest.crm_response?.message,
          crm_status: latest.crm_response?.status,
          fiscal_status: latest.crm_response?.fiscal_status,
        }
      : null;
  }

  async function normalizeOrderListItem(order: OrderMapping) {
    const queueMeta = await getQueueMeta(order);
    const site = order.site_order || ({} as OrderMapping["site_order"]);
    const crm = order.crm_order || {};
    const itemNames = (site.items || []).map((item) => item.name).filter(Boolean);

    return {
      _rowid: order._rowid,
      current_status: order.current_status,
      created_at: order.created_at,
      updated_at: order.updated_at,
      queue_meta: queueMeta,
      latest_history: getLatestHistorySummary(order),
      site_order: {
        externalOrderId: site.externalOrderId,
        externalCustomerId: site.externalCustomerId,
        date: site.date,
        firstName: site.firstName,
        lastName: site.lastName,
        email: site.email,
        phone: site.phone,
        totalCost: site.totalCost,
        currency: site.currency,
        status: site.status,
        statusDescription: site.statusDescription,
        paymentMethod: site.paymentMethod,
        deliveryMethod: site.deliveryMethod,
        items_count: (site.items || []).length,
        items_preview: itemNames.slice(0, 2),
      },
      crm_order: {
        id: crm.id,
        status: crm.status,
        state: crm.state,
        message: crm.message,
        source_uuid: crm.source_uuid,
      },
    };
  }

  async function normalizeOrderDetail(order: OrderMapping) {
    return {
      _rowid: order._rowid,
      site_order: order.site_order,
      crm_order: order.crm_order,
      status_history: order.status_history,
      current_status: order.current_status,
      created_at: order.created_at,
      updated_at: order.updated_at,
      queue_meta: await getQueueMeta(order),
      latest_history: getLatestHistorySummary(order),
    };
  }

  function buildOrderSearchText(order: OrderMapping) {
    const site = order.site_order || ({} as OrderMapping["site_order"]);
    const crm = order.crm_order || {};
    const itemBits = (site.items || []).flatMap((item) => [
      item.name,
      item.category,
      item.description,
      item.sku,
      item.externalItemId,
    ]);
    const historyBits = (order.status_history || []).flatMap((entry) => [
      entry.status,
      entry.error_message,
      entry.crm_response?.message,
      entry.crm_response?.id,
      entry.crm_response?.status,
    ]);

    return [
      order._rowid,
      order.current_status,
      site.externalOrderId,
      site.externalCustomerId,
      site.firstName,
      site.lastName,
      site.email,
      site.phone,
      site.status,
      site.statusDescription,
      site.paymentMethod,
      site.deliveryMethod,
      site.deliveryAddress,
      site.additionalInfo,
      crm.id,
      crm.status,
      crm.state,
      crm.message,
      crm.source_uuid,
      ...itemBits,
      ...historyBits,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  async function buildHistoryResponse(query: {
    status?: string;
    limit?: string;
    page?: string;
    pageSize?: string;
    search?: string;
    q?: string;
  }) {
    const { status, limit, page, pageSize, search, q } = query;
    const parsedLimit = limit ? parseInt(limit) : 100;
    const pageNumber = page ? parseInt(page) : 1;
    const resolvedPageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, pageSize ? parseInt(pageSize) : DEFAULT_PAGE_SIZE),
    );
    const searchQuery = (search || q || "").trim().toLowerCase();
    const shouldPaginate = Boolean(page || (!limit && !status));

    let orders: OrderMapping[];
    let totalCount: number;

    if (searchQuery) {
      const searchSource = status
        ? await getOrderMappingsByStatus(
            status as OrderMapping["current_status"],
            HISTORY_SEARCH_LIMIT,
            false,
          )
        : await getOrderHistoryLegacy(HISTORY_SEARCH_LIMIT, false);

      const filteredOrders = searchSource.filter((order) =>
        buildOrderSearchText(order).includes(searchQuery),
      );

      totalCount = filteredOrders.length;
      if (shouldPaginate) {
        const offset = (pageNumber - 1) * resolvedPageSize;
        orders = filteredOrders.slice(offset, offset + resolvedPageSize);
      } else {
        orders = filteredOrders.slice(0, parsedLimit);
      }
    } else if (status) {
      const limitForStatus = shouldPaginate
        ? resolvedPageSize * pageNumber
        : parsedLimit;
      const scopedOrders = await getOrderMappingsByStatus(
        status as OrderMapping["current_status"],
        limitForStatus,
        false,
      );
      totalCount = scopedOrders.length;
      orders = shouldPaginate
        ? scopedOrders.slice((pageNumber - 1) * resolvedPageSize, pageNumber * resolvedPageSize)
        : scopedOrders;
    } else if (page) {
      orders = await getOrderHistory(pageNumber, resolvedPageSize, false);
      totalCount = await getOrderHistoryCount();
    } else {
      orders = await getOrderHistoryLegacy(parsedLimit, false);
      totalCount = orders.length;
    }

    const normalizedOrders = await Promise.all(orders.map(normalizeOrderListItem));

    if (shouldPaginate) {
      const totalPages = Math.ceil(totalCount / resolvedPageSize);
      return {
        success: true,
        query: {
          search: searchQuery || null,
          status: status || null,
        },
        pagination: {
          current_page: pageNumber,
          per_page: resolvedPageSize,
          total_count: totalCount,
          total_pages: totalPages,
          has_next: pageNumber < totalPages,
          has_prev: pageNumber > 1,
        },
        orders: normalizedOrders,
      };
    }

    return {
      success: true,
      query: {
        search: searchQuery || null,
        status: status || null,
      },
      total: orders.length,
      orders: normalizedOrders,
    };
  }

  // History router group
  const historyRouter = new Elysia({ prefix: "/history" })
    .get("/", async ({ headers, query, set }) => {
      if (!isAuthorizedHistoryRequest(headers)) {
        set.status = 401;
        set.headers["www-authenticate"] = 'Basic realm="cher17-history"';
        return "Unauthorized";
      }

      const accept = headers.accept || "";
      const wantsHtml = accept.includes("text/html") && query.format !== "json";

      if (wantsHtml) {
        set.headers["content-type"] = "text/html; charset=utf-8";
        return renderHistoryPage();
      }

      try {
        return await buildHistoryResponse(query);
      } catch (error) {
        console.error("Error fetching order history:", error);
        return {
          success: false,
          error: "Failed to fetch order history",
        };
      }
    },
    {
      query: t.Object({
        status: t.Optional(
          t.Union([
            t.Literal("pending"),
            t.Literal("processing"),
            t.Literal("completed"),
            t.Literal("failed"),
          ]),
        ),
        limit: t.Optional(t.String()),
        page: t.Optional(t.String()),
        pageSize: t.Optional(t.String()),
        search: t.Optional(t.String()),
        q: t.Optional(t.String()),
        format: t.Optional(t.String()),
      }),
    })
    .get(
      "/data",
      async ({ headers, query, set }) => {
        if (!isAuthorizedHistoryRequest(headers)) {
          set.status = 401;
          set.headers["www-authenticate"] = 'Basic realm="cher17-history"';
          return {
            success: false,
            error: "Unauthorized",
          };
        }

        try {
          return await buildHistoryResponse(query);
        } catch (error) {
          console.error("Error fetching order history:", error);
          return {
            success: false,
            error: "Failed to fetch order history",
          };
        }
      },
      {
        query: t.Object({
          status: t.Optional(
            t.Union([
              t.Literal("pending"),
              t.Literal("processing"),
              t.Literal("completed"),
              t.Literal("failed"),
            ]),
          ),
          limit: t.Optional(t.String()),
          page: t.Optional(t.String()),
          pageSize: t.Optional(t.String()),
          search: t.Optional(t.String()),
          q: t.Optional(t.String()),
          format: t.Optional(t.String()),
        }),
      },
    )
    .get(
      "/order/:rowid",
      async ({ headers, params, set }) => {
        if (!isAuthorizedHistoryRequest(headers)) {
          set.status = 401;
          set.headers["www-authenticate"] = 'Basic realm="cher17-history"';
          return {
            success: false,
            error: "Unauthorized",
          };
        }

        const order = await getOrderMapping(params.rowid, true);
        if (!order) {
          set.status = 404;
          return {
            success: false,
            error: "Order not found",
          };
        }

        return {
          success: true,
          order: await normalizeOrderDetail(order),
        };
      },
      {
        params: t.Object({
          rowid: t.String(),
        }),
      },
    )
    .get("/backlog", async ({ headers, query, set, server, request }) => {
      if (!isAuthorizedHistoryRequest(headers)) {
        set.status = 401;
        set.headers["www-authenticate"] = 'Basic realm="cher17-history"';
        return { success: false, error: "Unauthorized" };
      }

      // Сканування всього сховища може тривати кілька секунд.
      server?.timeout(request, 255);

      try {
        const collect = query.mode === "snapshot" ? buildSnapshot : collectBacklog;
        const report = await collect({
          paidOnly: query.mode === "snapshot" ? false : query.paid === "1",
          includeKnown: query.known === "1",
          since: parseDateParam(query.since),
          until: parseDateParam(query.until, true),
          limit: query.limit ? parseInt(query.limit) : undefined,
        });

        if (query.format === "csv") {
          set.headers["content-type"] = "text/csv; charset=utf-8";
          return backlogToCsv(report);
        }

        return { success: true, ...report };
      } catch (error) {
        console.error("Помилка збору переліку без картки:", error);
        set.status = 409;
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to collect backlog",
        };
      }
    }, {
      query: t.Object({
        paid: t.Optional(t.String()),
        known: t.Optional(t.String()),
        since: t.Optional(t.String()),
        until: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        format: t.Optional(t.String()),
        mode: t.Optional(t.String()),
      }),
    })
    .post("/check", async ({ headers, body, set, server, request }) => {
      if (!isAuthorizedHistoryRequest(headers)) {
        set.status = 401;
        set.headers["www-authenticate"] = 'Basic realm="cher17-history"';
        return { success: false, error: "Unauthorized" };
      }

      // Звірка з CRM — це один запит на номер, тож пакет може чекати на ліміт.
      server?.timeout(request, 255);

      try {
        const result = await checkOrders(body.ids, {
          crm: body.crm === true,
          repair: body.repair === true,
          useCache: body.useCache === true,
        });

        const withCrm = result.results.filter((item) => item.crm_check);
        const absent = withCrm.filter((item) => item.crm_check?.state === "absent");
        return {
          success: true,
          ...result,
          summary: {
            exists: withCrm.filter((item) => item.crm_check?.state === "exists").length,
            absent: absent.length,
            unknown: withCrm.filter((item) => item.crm_check?.state === "unknown").length,
            absent_paid_count: absent.filter((item) => item.paid).length,
            absent_paid_total: Math.round(
              absent.filter((item) => item.paid).reduce((acc, item) => acc + item.total, 0) * 100,
            ) / 100,
          },
        };
      } catch (error) {
        console.error("Помилка звірки замовлень:", error);
        set.status = 500;
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to check orders",
        };
      }
    }, {
      body: t.Object({
        ids: t.Array(t.String()),
        crm: t.Optional(t.Boolean()),
        repair: t.Optional(t.Boolean()),
        useCache: t.Optional(t.Boolean()),
      }),
    })
    .post("/replay", async ({ headers, body, set, server, request }) => {
      if (!isAuthorizedHistoryRequest(headers)) {
        set.status = 401;
        set.headers["www-authenticate"] = 'Basic realm="cher17-history"';
        return { success: false, error: "Unauthorized" };
      }

      server?.timeout(request, 255);

      try {
        const report = await replayOrders({
          ids: body.ids,
          paidOnly: body.paidOnly,
          since: parseDateParam(body.since),
          until: parseDateParam(body.until, true),
          limit: body.limit,
          paceSec: body.paceSec,
          force: body.force,
          dryRun: body.dryRun,
          payloads: body.payloads?.map((entry) => ({
            id: entry.id,
            site_order: typeof entry.site_order === "string"
              ? JSON.parse(entry.site_order)
              : entry.site_order,
          })),
        });
        return { success: true, ...report };
      } catch (error) {
        console.error("Помилка повторної відправки:", error);
        set.status = 409;
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to replay orders",
        };
      }
    }, {
      body: t.Object({
        ids: t.Optional(t.Array(t.String())),
        paidOnly: t.Optional(t.Boolean()),
        since: t.Optional(t.String()),
        until: t.Optional(t.String()),
        limit: t.Optional(t.Number()),
        paceSec: t.Optional(t.Number()),
        force: t.Optional(t.Boolean()),
        dryRun: t.Optional(t.Boolean()),
        // Повні копії замовлень (або рядок JSON) — коли в пам'яті лишилися лише скорочені картки.
        payloads: t.Optional(
          t.Array(
            t.Object({
              id: t.String(),
              site_order: t.Union([t.String(), t.Record(t.String(), t.Any())]),
            }),
          ),
        ),
      }),
    })
    .get("/styles.css", ({ headers, set }) => {
      if (!isAuthorizedHistoryRequest(headers)) {
        set.status = 401;
        set.headers["www-authenticate"] = 'Basic realm="cher17-history"';
        return "Unauthorized";
      }

      set.headers["content-type"] = "text/css; charset=utf-8";
      return historyStyles;
    })
    .get("/app.js", ({ headers, set }) => {
      if (!isAuthorizedHistoryRequest(headers)) {
        set.status = 401;
        set.headers["www-authenticate"] = 'Basic realm="cher17-history"';
        return "Unauthorized";
      }

      set.headers["content-type"] = "application/javascript; charset=utf-8";
      return historyAppScript;
    })
    .get(
      "/:page",
      async ({ headers, params, query, set }) => {
        if (!isAuthorizedHistoryRequest(headers)) {
          set.status = 401;
          set.headers["www-authenticate"] = 'Basic realm="cher17-history"';
          return {
            success: false,
            error: "Unauthorized",
          };
        }

        const { page } = params;
        const { status } = query;
        const pageNumber = parseInt(page);

        if (isNaN(pageNumber) || pageNumber < 1) {
          return {
            success: false,
            error: "Invalid page number",
          };
        }

        try {
          const pageSize = 10; // Fixed 10 orders per page
          let orders: OrderMapping[];
          let totalCount: number;

          if (status) {
            orders = await getOrderMappingsByStatus(
              status as OrderMapping["current_status"],
              pageSize * pageNumber, // Get enough items for pagination
              false,
            );
            totalCount = orders.length; // Approximate for status filter
            // Apply pagination manually for status filter
            const startIndex = (pageNumber - 1) * pageSize;
            orders = orders.slice(startIndex, startIndex + pageSize);
          } else {
            orders = await getOrderHistory(pageNumber, pageSize, false);
            totalCount = await getOrderHistoryCount();
          }

          const totalPages = Math.ceil(totalCount / pageSize);

          return {
            success: true,
            pagination: {
              current_page: pageNumber,
              per_page: pageSize,
              total_count: totalCount,
              total_pages: totalPages,
              has_next: pageNumber < totalPages,
              has_prev: pageNumber > 1,
            },
            orders: await Promise.all(orders.map(normalizeOrderListItem)),
          };
        } catch (error) {
          console.error("Error fetching paginated order history:", error);
          return {
            success: false,
            error: "Failed to fetch order history",
          };
        }
      },
      {
        params: t.Object({
          page: t.String(),
        }),
        query: t.Object({
          status: t.Optional(
            t.Union([
              t.Literal("pending"),
              t.Literal("processing"),
              t.Literal("completed"),
              t.Literal("failed"),
            ]),
          ),
        }),
      },
    )
    .get("/stats", async ({ headers, set }) => {
      if (!isAuthorizedHistoryRequest(headers)) {
        set.status = 401;
        set.headers["www-authenticate"] = 'Basic realm="cher17-history"';
        return {
          success: false,
          error: "Unauthorized",
        };
      }

      try {
        const stats = await getHistoryStats();
        return {
          success: true,
          ...stats,
          formatted: {
            total: stats.total,
            oldestRecord: stats.oldestRecord
              ? new Intl.DateTimeFormat("uk-UA", {
                  dateStyle: "short",
                  timeStyle: "medium",
                  timeZone: "Europe/Kyiv",
                }).format(new Date(stats.oldestRecord))
              : null,
            newestRecord: stats.newestRecord
              ? new Intl.DateTimeFormat("uk-UA", {
                  dateStyle: "short",
                  timeStyle: "medium",
                  timeZone: "Europe/Kyiv",
                }).format(new Date(stats.newestRecord))
              : null,
            byStatus: stats.byStatus,
          },
        };
      } catch (error) {
        console.error("Error fetching history stats:", error);
        return {
          success: false,
          error: "Failed to fetch history statistics",
        };
      }
    })
    .get("/clean", async ({ headers, set }) => {
      if (!isAuthorizedHistoryRequest(headers)) {
        set.status = 401;
        set.headers["www-authenticate"] = 'Basic realm="cher17-history"';
        return {
          success: false,
          error: "Unauthorized",
        };
      }

      try {
        const result = await cleanHistory();

        return {
          success: true,
          ...result,
        };
      } catch (error) {
        console.error("Error cleaning history:", error);
        set.status = 500;
        return {
          success: false,
          error: "Failed to clean history",
        };
      }
    })
    .get(
      "/fiscalization-events",
      async ({ headers, query, set }) => {
        if (!isAuthorizedHistoryRequest(headers)) {
          set.status = 401;
          set.headers["www-authenticate"] = 'Basic realm="cher17-history"';
          return { success: false, error: "Unauthorized" };
        }

        const limit = Math.min(Number(query.limit) || 50, 500);
        const crmOrderId = query.card?.trim();
        let events = await readFiscalizationEvents(limit);

        if (crmOrderId) {
          events = events.filter((event) => String(event?.crm_order_id ?? "") === crmOrderId);
        }

        return { success: true, count: events.length, events };
      },
      {
        query: t.Object({
          limit: t.Optional(t.String()),
          card: t.Optional(t.String()),
        }),
      },
    )
    .get(
      "/crm-calls",
      async ({ headers, query, set }) => {
        if (!isAuthorizedHistoryRequest(headers)) {
          set.status = 401;
          set.headers["www-authenticate"] = 'Basic realm="cher17-history"';
          return { success: false, error: "Unauthorized" };
        }

        const days = Math.min(Number(query.days) || 3, 30);
        return { success: true, ...(await readCrmCallCounts(days)) };
      },
      {
        query: t.Object({
          days: t.Optional(t.String()),
        }),
      },
    );

  // DLQ router group
  const dlqRouter = new Elysia({ prefix: "/dlq" })
    .get("/", async () => {
      const dlqCount = await redis.llen(REDIS_KEYS.DEAD_LETTER_QUEUE);
      const items: Array<{ order: SiteOrder; reason?: string; retryCount?: number; errorMessage?: string; failedAt?: number }> = [];

      for (let i = 0; i < Math.min(dlqCount, 100); i++) {
        const item = await redis.lindex(REDIS_KEYS.DEAD_LETTER_QUEUE, i);
        if (!item) continue;
        const parsed = JSON.parse(item as string);
        items.push(parsed.order ? parsed : { order: parsed });
      }

      return {
        count: dlqCount,
        items,
      };
    })
    .post(
      "/retry",
      async ({ body, set }) => {
        const dlqCount = await redis.llen(REDIS_KEYS.DEAD_LETTER_QUEUE);

        for (let i = 0; i < dlqCount; i++) {
          const item = await redis.lindex(REDIS_KEYS.DEAD_LETTER_QUEUE, i);
          if (!item) continue;

          const parsed = JSON.parse(item as string);
          const order: SiteOrder = parsed.order ? parsed.order : parsed;
          if (order.externalOrderId !== body.orderId) continue;

          await redis.lrem(REDIS_KEYS.DEAD_LETTER_QUEUE, 1, item);
          await redis.del(REDIS_KEYS.RETRY_COUNT(body.orderId));
          await redis.del(REDIS_KEYS.RETRY_AT(body.orderId));
          await redis.rpush(REDIS_KEYS.PENDING_QUEUE, JSON.stringify(order));

          return {
            success: true,
            message: "Замовлення повернуто в чергу",
          };
        }

        set.status = 404;
        return { error: "Замовлення не знайдено в DLQ" };
      },
      {
        body: t.Object({
          orderId: t.String(),
        }),
      },
    );

  return (
    new Elysia()
      .use(historyRouter)
      .use(dlqRouter)
      // POST /webhook - прийом замовлень з сайту
      .post(
        "/webhook",
        async ({ body }) => {
          logWebhookReceipt("/webhook received", summarizeWebhookOrders(body.orders));

          for (const order of body.orders) {
            await enqueueOrder(order);
          }

          return {
            success: true,
            queued: body.orders.length,
            message: `${body.orders.length} замовлень додано в чергу`,
          };
        },
        {
          body: t.Object({
            orders: t.Array(t.Any()),
          }),
          response: {
            202: t.Object({
              success: t.Boolean(),
              queued: t.Number(),
              message: t.String(),
            }),
          },
          error({ code, error, set }) {
            console.error("Помилка обробки webhook:", {
              code,
              message: error instanceof Error ? error.message : String(error),
            });
            set.status = 500;
            return { error: "Internal server error" };
          },
        },
      )

      // POST /fiscalization - прийом подій фіскалізації з CRM.
      // Стукіт тут рівно один: будь-яка внутрішня помилка означає втрачену
      // картку, тому обробка всередині себе ставить повтор, а не «відбиває» 400.
      .post(
        "/fiscalization",
        async ({ body, set }) => {
          const payloadSummary = summarizeFiscalizationPayload(body);
          logWebhookReceipt("/fiscalization received", payloadSummary);

          try {
            const result = await handleFiscalizationWebhook(body as any);
            logWebhookReceipt("/fiscalization handled", {
              ...payloadSummary,
              success: result.success,
              action: result.action,
              crmOrderId: result.crmOrderId ?? null,
            });
            set.status = 200;
            return {
              ...result,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("Помилка обробки fiscalization webhook:", {
              ...payloadSummary,
              message,
            });

            const crmOrderId = String(payloadSummary.id ?? "").trim();
            await recordFiscalizationEvent({
              crmOrderId: crmOrderId || null,
              direction: "out",
              action: "handler_error_retry_scheduled",
              detail: message,
            });

            // Навіть якщо впала сама обробка — картка йде під нагляд і буде
            // перенесена, як тільки CRM відповість нормально.
            if (crmOrderId) {
              try {
                await enqueueFiscalizationWatch(crmOrderId, payloadSummary.source_uuid, undefined, {
                  runInMs: CONFIG.FISCALIZATION_CRM_DOWN_RETRY_MS,
                });
                set.status = 200;
                return { success: true, action: "retry_scheduled", crmOrderId };
              } catch (watchError) {
                console.error("Не вдалося поставити картку під нагляд після помилки:", watchError);
              }
            }

            set.status = 400;
            return {
              success: false,
              error: message || "Invalid fiscalization webhook",
            };
          }
        },
        {
          body: t.Object({
            event: t.Optional(t.String()),
            context: t.Object({
              id: t.Union([t.String(), t.Number()]),
              source_uuid: t.Optional(t.Union([t.String(), t.Null()])),
              status_id: t.Optional(t.Union([t.String(), t.Number()])),
              fiscal_status: t.Optional(t.Union([t.String(), t.Null()])),
            }, { additionalProperties: true }),
          }, { additionalProperties: true }),
          error({ code, error, set }) {
            console.error("Помилка валідації fiscalization webhook:", {
              code,
              message: error instanceof Error ? error.message : String(error),
            });
            set.status = 400;
            return {
              success: false,
              error: error instanceof Error ? error.message : "Invalid fiscalization webhook",
            };
          },
        },
      )

      // GET /health - статус черг
      .get("/health", async () => {
        const pendingCount = await redis.llen(REDIS_KEYS.PENDING_QUEUE);
        const processingCount = await redis.llen(REDIS_KEYS.PROCESSING_QUEUE);
        const delayedCount = await getDelayedQueueCount(REDIS_KEYS.DELAYED_QUEUE);
        const dlqCount = await redis.llen(REDIS_KEYS.DEAD_LETTER_QUEUE);
        const fiscalizationCount = await redis.llen(REDIS_KEYS.FISCALIZATION_QUEUE);
        const fiscalizationDelayedCount = await getDelayedQueueCount(REDIS_KEYS.FISCALIZATION_DELAYED_QUEUE);
        const fiscalizationDlqCount = await redis.llen(REDIS_KEYS.FISCALIZATION_DEAD_LETTER_QUEUE);
        const nextOrderRunAt = await getNextDelayedRunAt(REDIS_KEYS.DELAYED_QUEUE);
        const nextFiscalizationRunAt = await getNextDelayedRunAt(REDIS_KEYS.FISCALIZATION_DELAYED_QUEUE);
        const workers = {
          orders: await getWorkerStats("orders"),
          fiscalization: await getWorkerStats("fiscalization"),
        };
        const calls = await readCrmCallCounts(1);

        return {
          status: "healthy",
          crmRate: getCrmRequestRate(),
          crmCallsToday: calls.perDay,
          queues: {
            pending: pendingCount,
            processing: processingCount,
            delayed: delayedCount,
            fiscalization: fiscalizationCount,
            fiscalizationDelayed: fiscalizationDelayedCount,
            deadLetter: dlqCount,
            fiscalizationDeadLetter: fiscalizationDlqCount,
          },
          nextRuns: {
            orderDelayedAt: nextOrderRunAt,
            fiscalizationDelayedAt: nextFiscalizationRunAt,
          },
          workers,
          fiscalizationEvents: await readFiscalizationEvents(10),
        };
      })

      .listen(CONFIG.WEBHOOK_PORT)
  );
}
