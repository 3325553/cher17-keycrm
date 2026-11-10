import redis from "./redis";
import { REDIS_KEYS } from "./config";
import type { SiteOrder, OrderMapping, OrderStatusHistoryEntry } from "./types";

/**
 * Відповідь CRM без номера картки (відмова ліміту, порожній апдейт, службове
 * повідомлення) не має затирати вже відомий номер. Інакше історія виглядає так,
 * ніби картки немає, хоча вона створена — і оплата падає з «CRM ID не знайдено».
 */
function mergeCrmOrder(previous: any, next: any): any {
  if (next == null) return previous;
  if (previous == null || typeof previous !== "object" || typeof next !== "object") return next;

  const merged: any = { ...next };
  if (merged.id == null && previous.id != null) merged.id = previous.id;
  if (merged.source_uuid == null && previous.source_uuid != null) {
    merged.source_uuid = previous.source_uuid;
  }
  return merged;
}

// Helper function to efficiently store status history in Redis hash
async function addStatusToHistoryHash(
  rowid: string,
  status: OrderStatusHistoryEntry["status"],
  crmResponse?: any,
  errorMessage?: string,
  retryCount?: number,
): Promise<void> {
  const now = Date.now();
  const statusKey = `${now}_${status}`;
  const statusEntry = JSON.stringify({
    status,
    date: now,
    crm_response: crmResponse,
    error_message: errorMessage,
    retry_count: retryCount,
  });

  // Store in hash with timestamp-based key for ordering
  await redis.hset(REDIS_KEYS.ORDER_STATUS_HISTORY(rowid), statusKey, statusEntry);
  
  // Keep only last 50 status entries per order
  const allStatuses = await redis.hkeys(REDIS_KEYS.ORDER_STATUS_HISTORY(rowid));
  if (allStatuses.length > 50) {
    const sortedKeys = allStatuses.sort();
    const keysToDelete = sortedKeys.slice(0, allStatuses.length - 50);
    if (keysToDelete.length > 0) {
      for (const key of keysToDelete) {
        await redis.hdel(REDIS_KEYS.ORDER_STATUS_HISTORY(rowid), key);
      }
    }
  }
}

// Helper function to update history index efficiently
async function updateHistoryIndex(rowid: string, timestamp: number): Promise<void> {
  // Add to sorted set with timestamp as score
  await redis.zadd(REDIS_KEYS.ORDER_HISTORY_INDEX, timestamp, rowid);
  
  // Keep only last 1000 orders in index
  await redis.zremrangebyrank(REDIS_KEYS.ORDER_HISTORY_INDEX, 0, -1001);
}

// Helper function to get status history from hash
async function getStatusHistoryFromHash(rowid: string): Promise<OrderMapping["status_history"]> {
  const statusData = await redis.hgetall(REDIS_KEYS.ORDER_STATUS_HISTORY(rowid));
  if (!statusData) return [];

  const entries = Object.entries(statusData)
    .map(([key, value]) => JSON.parse(value as string))
    .sort((a, b) => a.date - b.date);

  return entries;
}

export async function createOrUpdateOrderMapping(
  siteOrder: SiteOrder,
  status: OrderMapping["current_status"] = "pending",
  crmResponse?: any,
): Promise<void> {
  const rowid = siteOrder.externalOrderId;
  const now = Date.now();

  // Check if order mapping already exists
  const existingData = await redis.get(REDIS_KEYS.ORDER_MAPPING(rowid));

  if (existingData) {
    // Update existing order mapping
    const existing: OrderMapping = JSON.parse(existingData as string);

    const isDuplicatePending =
      status === 'pending' &&
      existing.current_status === 'pending' &&
      !crmResponse;

    if (!isDuplicatePending) {
      // Add new status to history using efficient hash storage
      // Store CRM response for error states, retries, or if order ID is missing
      const shouldStoreCrmInHistory = status === 'failed' || 
        status === 'processing' || 
        (crmResponse && !crmResponse.id);
      await addStatusToHistoryHash(rowid, status, shouldStoreCrmInHistory ? crmResponse : undefined);
    }
    
    existing.current_status = status;
    existing.updated_at = now;
    existing.site_order = siteOrder;

    // Update CRM data if provided (номер картки не губимо)
    if (crmResponse) {
      existing.crm_order = mergeCrmOrder(existing.crm_order, crmResponse);
    }

    const updatedData = JSON.stringify(existing);
    await redis.set(REDIS_KEYS.ORDER_MAPPING(rowid), updatedData);

    // Update history index (efficient O(log n) operation)
    await updateHistoryIndex(rowid, now);
  } else {
    // Create new order mapping
    const newMapping: OrderMapping = {
      _rowid: rowid,
      site_order: siteOrder,
      status_history: [], // Will be stored separately in hash
      current_status: status,
      created_at: now,
      updated_at: now,
    };

    // Add CRM response if provided
    if (crmResponse) {
      newMapping.crm_order = crmResponse;
    }

    const mappingData = JSON.stringify(newMapping);
    await redis.set(REDIS_KEYS.ORDER_MAPPING(rowid), mappingData);

    // Add initial status to history hash (without CRM response to avoid duplication)
    await addStatusToHistoryHash(rowid, status);

    // Add to history index
    await updateHistoryIndex(rowid, now);
  }
}

export async function addStatusToHistory(
  rowid: string,
  status: OrderStatusHistoryEntry["status"],
  crmResponse?: any,
  errorMessage?: string,
  retryCount?: number,
): Promise<void> {
  const existing = await getOrderMapping(rowid);
  if (!existing) return;

  // Add status to history hash (store CRM response for error states, or if order ID is missing)
  const shouldStoreCrmInHistory = status === 'failed' || 
    (errorMessage && errorMessage.length > 0) || 
    (crmResponse && !crmResponse.id);
  await addStatusToHistoryHash(rowid, status, shouldStoreCrmInHistory ? crmResponse : undefined, errorMessage, retryCount);
  
  if (["pending", "processing", "completed", "failed"].includes(status)) {
    existing.current_status = status as OrderMapping["current_status"];
  }
  existing.updated_at = Date.now();

  // Update CRM data if provided (номер картки не губимо)
  if (crmResponse) {
    existing.crm_order = mergeCrmOrder(existing.crm_order, crmResponse);
  }

  const updatedData = JSON.stringify(existing);
  await redis.set(REDIS_KEYS.ORDER_MAPPING(rowid), updatedData);
  
  // Update history index efficiently
  await updateHistoryIndex(rowid, Date.now());
}

export async function getOrderMapping(
  rowid: string,
  withHistory: boolean = true,
): Promise<OrderMapping | null> {
  const mappingData = await redis.get(REDIS_KEYS.ORDER_MAPPING(rowid));
  if (!mappingData) return null;

  const mapping: OrderMapping = JSON.parse(mappingData as string);
  mapping.status_history = withHistory
    ? await getStatusHistoryFromHash(rowid)
    : [];
  return mapping;
}

export async function getOrderHistory(
  page: number = 1,
  pageSize: number = 10,
  withHistory: boolean = true,
): Promise<OrderMapping[]> {
  const offset = (page - 1) * pageSize;
  const end = offset + pageSize - 1;
  
  // Get order IDs for current page from sorted set (O(log n) operation)
  const orderIds = await redis.zrevrange(REDIS_KEYS.ORDER_HISTORY_INDEX, offset, end);
  
  if (orderIds.length === 0) return [];

  // Fetch order mappings in parallel for efficiency
  const mappingPromises = orderIds.map(async (orderId) => {
    const mappingData = await redis.get(REDIS_KEYS.ORDER_MAPPING(orderId as string));
    if (!mappingData) return null;

    const mapping: OrderMapping = JSON.parse(mappingData as string);
    
    // Get status history from hash only when explicitly requested
    mapping.status_history = withHistory
      ? await getStatusHistoryFromHash(orderId as string)
      : [];
    
    return mapping;
  });

  const results = await Promise.all(mappingPromises);
  
  // Filter out null results and return
  return results.filter((mapping): mapping is OrderMapping => mapping !== null);
}

// Get total count of orders for pagination
export async function getOrderHistoryCount(): Promise<number> {
  return await redis.zcard(REDIS_KEYS.ORDER_HISTORY_INDEX);
}

// Legacy function for backward compatibility
export async function getOrderHistoryLegacy(
  limit: number = 100,
  withHistory: boolean = true,
): Promise<OrderMapping[]> {
  return getOrderHistory(1, limit, withHistory);
}



export async function getOrderMappingsByStatus(
  status: OrderMapping["current_status"],
  limit: number = 1000,
  withHistory: boolean = true,
): Promise<OrderMapping[]> {
  // Get all order IDs from index
  const orderIds = await redis.zrevrange(REDIS_KEYS.ORDER_HISTORY_INDEX, 0, -1);
  
  if (orderIds.length === 0) return [];

  // Check status efficiently by checking individual mappings
  const mappingPromises = orderIds.map(async (orderId) => {
    const mappingData = await redis.get(REDIS_KEYS.ORDER_MAPPING(orderId as string));
    if (!mappingData) return null;

    const mapping: OrderMapping = JSON.parse(mappingData as string);
    
    // Only include if status matches
    if (mapping.current_status !== status) return null;
    
    // Get status history from hash only when explicitly requested
    mapping.status_history = withHistory
      ? await getStatusHistoryFromHash(orderId as string)
      : [];
    
    return mapping;
  });

  const results = await Promise.all(mappingPromises);
  
  // Filter out null results and apply limit
  return results
    .filter((mapping): mapping is OrderMapping => mapping !== null)
    .slice(0, limit);
}

// Cleanup functions
export async function cleanHistory(): Promise<{
  toDelete: number;
  deleted: number;
  errors: string[];
}> {
  try {
    // Get all order IDs from index
    const orderIds = await redis.zrange(REDIS_KEYS.ORDER_HISTORY_INDEX, 0, -1);
    let toDelete = orderIds.length;
    let deleted = 0;
    const errors: string[] = [];

    for (const orderId of orderIds) {
      try {
        // Remove from index
        await redis.zrem(REDIS_KEYS.ORDER_HISTORY_INDEX, orderId);
        
        // Remove individual mapping
        await redis.del(REDIS_KEYS.ORDER_MAPPING(orderId as string));
        
        // Remove status history hash
        await redis.del(REDIS_KEYS.ORDER_STATUS_HISTORY(orderId as string));

        deleted++;
      } catch (error) {
        errors.push(`Failed to delete ${orderId}: ${error}`);
      }
    }

    return { toDelete, deleted, errors };
  } catch (error) {
    return { toDelete: 0, deleted: 0, errors: [`Cleanup failed: ${error}`] };
  }
}

export async function getHistoryStats(): Promise<{
  total: number;
  byStatus: Record<string, number>;
  oldestRecord: number | null;
  newestRecord: number | null;
}> {
  // Get all order IDs with their timestamps from the sorted set
  const orderIdsWithScores = await redis.zrange(REDIS_KEYS.ORDER_HISTORY_INDEX, 0, -1, 'WITHSCORES');
  
  if (orderIdsWithScores.length === 0) {
    return {
      total: 0,
      byStatus: {},
      oldestRecord: null,
      newestRecord: null,
    };
  }

  const byStatus: Record<string, number> = {};
  let oldestRecord = Infinity;
  let newestRecord = 0;
  let total = 0;

  // Bun's RedisClient returns ZRANGE ... WITHSCORES as an array of
  // [member, score] pairs (not a flat [member, score, member, ...] array),
  // so iterate over the pairs directly.
  const entries = orderIdsWithScores as unknown as Array<[string, number | string]>;

  // Process in batches for efficiency
  const batchSize = 100;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const [member, score] = entry;
    const orderId = String(member);
    const timestamp = Number(score);

    // Update timestamp ranges
    if (Number.isFinite(timestamp)) {
      if (timestamp < oldestRecord) oldestRecord = timestamp;
      if (timestamp > newestRecord) newestRecord = timestamp;
    }

    // Get mapping to check status
    const mappingData = await redis.get(REDIS_KEYS.ORDER_MAPPING(orderId));
    if (mappingData) {
      const mapping: OrderMapping = JSON.parse(mappingData as string);
      byStatus[mapping.current_status] = (byStatus[mapping.current_status] || 0) + 1;
      total++;
    }

    // Process in batches to avoid overwhelming Redis
    if (i > 0 && i % batchSize === 0) {
      // Small delay to prevent blocking
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }

  return {
    total,
    byStatus,
    oldestRecord: oldestRecord === Infinity ? null : oldestRecord,
    newestRecord: newestRecord === 0 ? null : newestRecord,
  };
}

// Migration function to transition from old list-based to new hash-based history
export async function migrateHistoryStructure(): Promise<{
  migrated: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let migrated = 0;

  try {
    // Get all items from old history list
    const historyCount = await redis.llen(REDIS_KEYS.ORDER_HISTORY);
    
    for (let i = 0; i < historyCount; i++) {
      try {
        const item = await redis.lindex(REDIS_KEYS.ORDER_HISTORY, i);
        if (!item) continue;

        const mapping: OrderMapping = JSON.parse(item);
        const rowid = mapping._rowid;

        if (!rowid) continue;

        // Add to new index
        await updateHistoryIndex(rowid, mapping.created_at);

        // Migrate status history to hash if it exists
        if (mapping.status_history && mapping.status_history.length > 0) {
          for (const statusEntry of mapping.status_history) {
            await addStatusToHistoryHash(
              rowid,
              statusEntry.status,
              statusEntry.crm_response,
              statusEntry.error_message,
              statusEntry.retry_count,
            );
          }
        }

        // Clear status history from main mapping to save space
        const mappingWithoutHistory = { ...mapping, status_history: [] };
        await redis.set(REDIS_KEYS.ORDER_MAPPING(rowid), JSON.stringify(mappingWithoutHistory));
        
        migrated++;
      } catch (error) {
        errors.push(`Failed to migrate item at index ${i}: ${error}`);
      }
    }

    // Clear old history list after successful migration
    if (migrated > 0) {
      await redis.del(REDIS_KEYS.ORDER_HISTORY);
    }
  } catch (error) {
    errors.push(`Migration failed: ${error}`);
  }

  return { migrated, errors };
}

// Legacy functions for backward compatibility
export async function saveOrderMapping(
  siteOrder: SiteOrder,
  status: OrderMapping["current_status"] = "pending",
): Promise<void> {
  await createOrUpdateOrderMapping(siteOrder, status);
}

export async function updateOrderMapping(
  siteOrderId: string,
  updates: any,
): Promise<void> {
  const status = updates.status || "pending";
  const crmResponse = updates.crm_order;
  await addStatusToHistory(siteOrderId, status, crmResponse);
}
