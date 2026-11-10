export const CONFIG = {
  MAX_RETRIES: 2,
  INITIAL_BACKOFF: 1000, // 1 секунда
  MAX_BACKOFF: 60000, // 1 хвилина
  BACKOFF_MULTIPLIER: 2,
  WEBHOOK_PORT: 3000,
  PROCESSING_INTERVAL: 5000, // Перевірка черги кожні 5 секунд
  FISCALIZATION_PROCESSING_INTERVAL: 5000, // Перевірка fiscalization-черги кожні 5 секунд
  LEAD_DELAY_MS: 10 * 60 * 1000, // 10 хвилин перед створенням ліда
  ORDER_LOCK_TTL_SEC: 5 * 60,
  CREATE_LOCK_TTL_SEC: 15 * 60,
  PROCESSED_MARKER_TTL_SEC: 15 * 60,
  LEAD_HASH_TTL_SEC: 24 * 60 * 60,
  FISCALIZATION_WATCH_TTL_SEC: 48 * 60 * 60,
  FISCALIZATION_MAX_RETRIES: 30,
  FISCALIZATION_INITIAL_BACKOFF_MS: 60 * 1000, // Першу перевірку статусу фіскалізації робимо через 1 хвилину
  FISCALIZATION_MAX_BACKOFF_MS: 15 * 60 * 1000,
  // Відмова ліміту CRM — не «готово», а відкладення з паузою, щоб не спалити квоту дарма.
  RATE_LIMIT_RETRY_MS: 60 * 1000,
  // Захисний блок створення ще тримає інший воркер — пробуємо пізніше, а не звітуємо успіх.
  LOCK_BUSY_RETRY_MS: 30 * 1000,
  MAX_RATE_LIMIT_DEFERS: 30,
  // Повторна відправка зі збережених копій: темп і максимальний пакет за один виклик.
  REPLAY_PACE_SEC: 10,
  REPLAY_MAX_BATCH: 100,
  // Жорстка нижня межа відновлення: замовлення, створені раніше цієї дати, не чіпаємо.
  RECOVERY_SINCE: "2026-11-01",
  // Скільки замовлень можна звірити з CRM за один виклик (1 запит на замовлення).
  CHECK_MAX_BATCH: 100,
  // Спільний ліміт ключа CRM — 120 запитів/хв. Тримаємо запас, щоб не ловити відмови.
  CRM_MAX_REQUESTS_PER_MIN: 100,
  // Завислий запит не має блокувати чергу назавжди.
  CRM_REQUEST_TIMEOUT_MS: 30 * 1000,
};

export const REDIS_KEYS = {
  PENDING_QUEUE: "orders:pending",
  PROCESSING_QUEUE: "orders:processing",
  DEAD_LETTER_QUEUE: "orders:dlq",
  ORDER_MAPPING: (siteOrderId: string) => `order:mapping:${siteOrderId}`,
  ORDER_HISTORY: "orders:history",
  ORDER_HISTORY_INDEX: "orders:history:index", // Sorted set for order IDs by timestamp
  ORDER_STATUS_HISTORY: (orderId: string) => `order:status_history:${orderId}`, // Hash for status history
  RETRY_COUNT: (orderId: string) => `orders:retry:${orderId}`,
  RETRY_AT: (orderId: string) => `orders:retry_at:${orderId}`,
  LEAD_HASH: (hash: string) => `leads:hash:${hash}`,
  CRM_ORDER_ID: (orderId: string) => `orders:crm_id:${orderId}`,
  CRM_ORDER_SITE_ORDER_ID: (crmOrderId: string) => `orders:site_order_id_by_crm:${crmOrderId}`,
  ORDER_PROCESSED: (orderId: string, status: number) => `orders:processed:${orderId}:status_${status}`,
  ORDER_STATUS_UPDATE_PROCESSED: (orderId: string, statusId: number) => `orders:processed:${orderId}:crm_status_${statusId}`,
  ORDER_PAID_STATUS_SYNCED: (orderId: string) => `orders:paid_status_synced:${orderId}`,
  ORDER_ENQUEUE_GUARD: (orderId: string) => `orders:enqueue_guard:${orderId}`,
  DELAYED_QUEUE: "orders:delayed",
  FISCALIZATION_QUEUE: "orders:fiscalization:queue",
  FISCALIZATION_WATCH: (crmOrderId: string) => `orders:fiscalization:watch:${crmOrderId}`,
  FISCALIZATION_DONE: (crmOrderId: string) => `orders:fiscalization:done:${crmOrderId}`,
  FISCALIZATION_RETRY_COUNT: (crmOrderId: string) => `orders:fiscalization:retry:${crmOrderId}`,
  FISCALIZATION_RETRY_AT: (crmOrderId: string) => `orders:fiscalization:retry_at:${crmOrderId}`,
  FISCALIZATION_DELAYED_QUEUE: "orders:fiscalization:delayed",
  FISCALIZATION_DEAD_LETTER_QUEUE: "orders:fiscalization:dlq",
  ORDER_LOCK: (orderId: string) => `orders:lock:${orderId}`,
  CREATE_LOCK: (orderId: string) => `orders:create_lock:${orderId}`,
  RATE_LIMIT_DEFERS: (orderId: string) => `orders:rate_limit_defers:${orderId}`,
  WORKER_STATS: (worker: string) => `workers:stats:${worker}`,
};
