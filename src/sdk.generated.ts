// УВАГА: файл згенерований, але містить ручні правки, які треба зберігати
// при повторній генерації (ліміт темпу, таймаут, позначка відмов CRM __httpStatus
// та filter[source_uuid] у getOrdersBySourceUuid).
import { CONFIG } from "./config";
import { awaitCrmSlot } from "./crm-guard";

export type Order = {
  id?: number;
  parent_id?: number;
  source_uuid?: string;
  source_id: number;
  status_id?: number;
  status_group_id?: number;
  grand_total?: number;
  promocode?: string;
  total_discount?: number;
  expenses_sum?: number;
  shipping_price?: number;
  wrap_price?: number;
  taxes?: number;
  manager_comment?: string;
  buyer_comment?: string;
  gift_message?: string;
  is_gift?: boolean;
  payment_status?: string;
  last_synced_at?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
};

export type OrderWithIncludes = {
  id?: number;
  parent_id?: number;
  source_uuid?: string;
  source_id: number;
  status_id?: number;
  status_group_id?: number;
  grand_total?: number;
  promocode?: string;
  total_discount?: number;
  expenses_sum?: number;
  shipping_price?: number;
  wrap_price?: number;
  taxes?: number;
  manager_comment?: string;
  buyer_comment?: string;
  gift_message?: string;
  is_gift?: boolean;
  payment_status?: string;
  last_synced_at?: string;
  created_at?: string;
  ordered_at?: string;
  updated_at?: string;
  closed_at?: string;
  buyer?: {
    id?: number;
    full_name?: string;
    email?: string;
    phone?: string;
    company_id?: number;
    manager_id?: number;
  };
  products?: {
    name?: string;
    sku?: string;
    price?: number;
    price_sold?: number;
    purchased_price?: number;
    discount_percent?: number;
    discount_amount?: number;
    total_discount?: number;
    quantity?: number;
    unit_type?: string;
    upsale?: boolean;
    comment?: string;
    product_status_id?: number;
    picture?: string;
    properties?: {
      name?: string;
      value?: string;
    }[];
    shipment_type?: string;
    warehouse?: {
      id?: number;
      name?: string;
      description?: string;
      is_active?: boolean;
    };
    offer?: {
      id?: number;
      product_id?: number;
      sku?: string;
      barcode?: string;
      price?: number;
      purchased_price?: number;
      quantity?: number;
      weight?: number;
      length?: number;
      width?: number;
      height?: number;
      properties?: {
        name?: string;
        value?: string;
      }[];
    };
  }[];
  manager?: {
    id?: number;
    first_name?: string;
    last_name?: string;
    full_name?: string;
    username?: string;
    email?: string;
    phone?: string;
    role_id?: number;
    status?: string;
    created_at?: string;
    updated_at?: string;
    last_logged_at?: string;
  };
  tags?: {
    id?: number;
    name?: string;
    alias?: string;
    color?: string;
    created_at?: string;
    updated_at?: string;
  }[];
  status?: {
    id?: number;
    name?: string;
    alias?: string;
    is_active?: boolean;
    group_id?: number;
    is_closing_order?: boolean;
    is_reserved?: boolean;
    created_at?: string;
    updated_at?: string;
  };
  marketing?: {
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_term?: string;
    utm_content?: string;
    created_at?: string;
    updated_at?: string;
  };
  payments?: {
    id?: number;
    destination_id?: number;
    payment_method_id?: number;
    amount?: number;
    actual_currency?: string;
    transaction_uuid?: string;
    description?: string;
    status?: string;
    fiscal_result?: Record<string, any>;
    payment_date?: string;
    created_at?: string;
    updated_at?: string;
  }[];
  shipping?: {
    delivery_service_id?: number;
    tracking_code?: string;
    shipping_status?: string;
    shipping_address_city?: string;
    shipping_address_country?: string;
    shipping_address_country_code?: string;
    shipping_address_region?: string;
    shipping_address_zip?: string;
    shipping_secondary_line?: string;
    shipping_receive_point?: string;
    recipient_full_name?: string;
    recipient_phone?: string;
    shipping_date_actual?: string;
  };
  expenses?: {
    id?: number;
    destination_id?: number;
    expense_type_id?: number;
    amount?: number;
    actual_currency?: string;
    transaction_uuid?: string;
    description?: string;
    status?: string;
    payment_date?: string;
    created_at?: string;
    updated_at?: string;
  }[];
  custom_fields?: {
    id?: number;
    uuid?: string;
    name?: string;
    type?: string;
    value?: string;
  }[];
  assigned?: {
    id?: number;
    first_name?: string;
    last_name?: string;
    full_name?: string;
    username?: string;
    email?: string;
    phone?: string;
    role?: {
      id?: number;
      name?: string;
      alias?: string;
    };
    status?: string;
    created_at?: string;
    updated_at?: string;
    last_logged_at?: string;
  }[];
};

export type CustomField = {
  id?: number;
  name?: string;
  uuid?: string;
  model?: string;
  type?: string;
  required?: boolean;
  position?: number;
  is_multiple?: boolean;
  options?: {
    id?: number;
    field_id?: number;
    value?: string;
  }[];
};

export type Payment = {
  payment_method_id: number;
  payment_method?: PaymentMethod;
  amount: number;
  description?: string;
  payment_date?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
};

export type Expense = {
  expense_type_id: number;
  expense_type?: ExpenseType;
  amount: number;
  description?: string;
  payment_date?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
};

export type PaymentMethod = {
  id: number;
  name: string;
  alias?: string;
  is_active?: boolean;
};

export type ExpenseType = {
  id: number;
  name: string;
  alias?: string;
  is_active?: boolean;
  is_reserved?: boolean;
  by_order?: boolean;
};

export type DeliveryService = {
  id: number;
  name: string;
  source_name?: string;
  alias: string;
};

export type Tag = {
  id: number;
  name: string;
  alias: string;
  color: string;
  created_at?: string;
  updated_at?: string;
};

export type Status = {
  id: number;
  name: string;
  alias: string;
  is_active?: boolean;
  group_id?: number;
  is_closing_order?: boolean;
  is_reserved?: boolean;
  expiration_period?: number;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string;
};

export type ProductStatus = {
  id: number;
  name: string;
  alias: string;
  position?: number;
  is_active?: boolean;
  is_reserved?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type Marketing = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  created_at?: string;
  updated_at?: string;
};

export type Source = {
  id: number;
  name: string;
  alias: string;
  driver?: string;
  source_uuid?: string;
  source_name?: string;
  currency_code?: string;
  created_at?: string;
  updated_at?: string;
};

export type File = {
  id: number;
  file_name?: string;
  url?: string;
  size?: number;
  extension?: string;
  original_file_name?: string;
  mime_type?: string;
  created_at?: string;
  updated_at?: string;
};

export type PipelineCard = {
  id?: number;
  contact_id: number;
  source_id?: number;
  manager_id?: number;
  status_id?: number;
  title?: string;
  manager_comment?: string;
  is_finished?: string;
  status_changed_at?: string;
  communicate_at?: string;
  created_at?: string;
  updated_at?: string;
};

export type Pipeline = {
  id?: number;
  name?: string;
  target_type?: string;
  target_id?: string;
  use_payments?: boolean;
  lead_type?: string;
};

export type PipelineStatuses = {
  id?: number;
  pipeline_id?: number;
  title?: string;
  alias?: string;
  color?: string;
  is_final?: boolean;
  leads_count?: number;
};

export type PipelineCardWithIncludes = {
  id?: number;
  contact_id?: number;
  source_id: number;
  manager_id?: number;
  target_id?: number;
  target_type?: string;
  status_id?: number;
  title?: string;
  manager_comment?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  is_finished?: string;
  status_changed_at?: string;
  communicate_at?: string;
  created_at?: string;
  updated_at?: string;
  contact?: {
    id?: number;
    full_name?: string;
    email?: string;
    phone?: string;
    picture?: string;
    additional_details?: string[];
    client_id?: number;
    social_name?: string;
    social_id?: string;
    created_at?: string;
    updated_at?: string;
    client?: {
      id?: number;
      company_id?: number;
      full_name?: string;
      phone?: string;
      formatted_phone?: string;
      additional_phone?: string;
      email?: string;
      note?: string;
      picture?: string;
      image?: string;
      currency?: string;
      orders_sum?: string;
      orders_count?: number;
      has_duplicates?: number;
      manager_id?: number;
      created_at?: string;
      updated_at?: string;
    };
  };
  products?: {
    id?: number;
    product_id?: number;
    name?: string;
    sku?: string;
    price?: number;
    quantity?: number;
    unit_type?: string;
    picture?: string;
    offer?: {
      id?: number;
      product_id?: number;
      sku?: string;
      barcode?: string;
      price?: number;
      purchased_price?: number;
      quantity?: number;
      weight?: number;
      length?: number;
      width?: number;
      height?: number;
      properties?: {
        name?: string;
        value?: string;
      }[];
    };
  }[];
  manager?: {
    id?: number;
    first_name?: string;
    last_name?: string;
    full_name?: string;
    username?: string;
    email?: string;
    phone?: string;
    role_id?: number;
    status?: string;
    created_at?: string;
    updated_at?: string;
    last_logged_at?: string;
  };
  status?: {
    id?: number;
    name?: string;
    alias?: string;
    is_active?: boolean;
    pipeline_id?: number;
    created_at?: string;
    updated_at?: string;
  };
  payments?: {
    id?: number;
    payment_method_id?: number;
    amount?: number;
    actual_currency?: string;
    transaction_uuid?: string;
    description?: string;
    status?: string;
    payment_date?: string;
    created_at?: string;
    updated_at?: string;
  }[];
  custom_fields?: {
    id?: number;
    uuid?: string;
    name?: string;
    type?: string;
    value?: string;
  }[];
};

export type Product = {
  id?: number;
  name?: string;
  description?: string;
  thumbnail_url?: string;
  attachments_data?: any[];
  quantity?: number;
  unit_type?: string;
  currency_code?: string;
  sku?: string;
  min_price?: number;
  max_price?: number;
  weight?: number;
  length?: number;
  width?: number;
  height?: number;
  has_offers?: boolean;
  is_archived?: boolean;
  category_id?: number;
  created_at?: string;
  updated_at?: string;
};

export type ProductWithIncludes = {
  id?: number;
  name?: string;
  sku?: string;
  barcode?: string;
  price?: number;
  purchased_price?: number;
  description?: string;
  thumbnail_url?: string;
  attachments_data?: any[];
  quantity?: number;
  unit_type?: string;
  currency_code?: string;
  min_price?: number;
  max_price?: number;
  weight?: number;
  length?: number;
  width?: number;
  height?: number;
  has_offers?: boolean;
  is_archived?: boolean;
  category_id?: number;
  created_at?: string;
  updated_at?: string;
  custom_fields?: {
    id?: number;
    uuid?: string;
    name?: string;
    type?: string;
    value?: string;
  }[];
};

export type ProductOffer = {
  id?: number;
  name?: string;
  description?: string;
  thumbnail_url?: string;
  attachments_data?: any[];
  quantity?: number;
  unit_type?: string;
  currency_code?: string;
  sku?: string;
  min_price?: number;
  max_price?: number;
  weight?: number;
  length?: number;
  width?: number;
  height?: number;
  has_offers?: boolean;
  is_archived?: boolean;
  properties_agg?: {
    "\u041D\u0430\u0437\u0432\u0430 \u0432\u043B\u0430\u0441\u0442\u0438\u0432\u043E\u0441\u0442\u0456"?: string[];
  };
  category_id?: number;
  created_at?: string;
  updated_at?: string;
};

export type Offer = {
  id?: number;
  product_id?: number;
  sku?: string;
  barcode?: string;
  thumbnail_url?: string;
  price?: number;
  purchased_price?: number;
  quantity?: number;
  weight?: number;
  length?: number;
  width?: number;
  height?: number;
  properties?: {
    name?: string;
    value?: string;
  }[];
  product?: any;
};

export type OfferStocks = {
  id?: number;
  sku?: string;
  price?: number;
  purchased_price?: number;
  quantity?: number;
  reserve?: number;
  warehouse?: Warehouse[];
};

export type Warehouse = {
  id?: number;
  name?: string;
  quantity?: number;
  reserve?: number;
};

export type PaginatedResponse = {
  total?: number;
  current_page?: number;
  per_page?: number;
  data?: any[];
  first_page_url?: string;
  last_page_url?: string;
  next_page_url?: string;
};

export type BuyerWithIncludes = {
  id?: number;
  full_name: string;
  birthday?: string;
  email?: string[];
  phone?: string[];
  note?: string;
  company?: {
    id?: number;
    name?: string;
    full_name?: string;
    address?: string;
    banking_detailse?: string;
    note?: string;
    created_at?: string;
    updated_at?: string;
  };
  manager?: {
    id?: number;
    first_name?: string;
    last_name?: string;
    full_name?: string;
    username?: string;
    email?: string;
    phone?: string;
    role_id?: number;
    status?: string;
    created_at?: string;
    updated_at?: string;
    last_logged_at?: string;
  };
  loyalty?: {
    loyalty_program_name?: string;
    loyalty_program_id?: number;
    loyalty_program_level_name?: string;
    loyalty_program_level_id?: number;
    amount?: number;
    discount?: number;
  }[];
  shipping?: {
    address?: string;
    additional_address?: string;
    city?: string;
    region?: string;
    zip_code?: string;
    country?: string;
    recipient_full_name?: string;
    recipient_phone?: string;
    warehouse_ref?: string;
  }[];
  custom_fields?: {
    uuid?: string;
    value?: string;
  }[];
  created_at?: string;
  updated_at?: string;
};

export type Category = {
  id?: number;
  name?: string;
  parent_id?: number;
};

export type Buyer = {
  id?: number;
  full_name: string;
  birthday?: string;
  email?: string[];
  phone?: string[];
  note?: string;
  created_at?: string;
  updated_at?: string;
};

export type User = {
  id?: number;
  first_name?: string;
  last_name?: string;
  full_name: string;
  username?: string;
  email?: string;
  phone?: string;
  role_id?: number;
  status?: string;
  created_at?: string;
  updated_at?: string;
  last_logged_at?: string;
};

export type Company = {
  id?: number;
  name: string;
  title?: string;
  notes?: string;
  bank_account?: string;
  manager_id?: number;
  custom_fields?: {
    uuid?: string;
    value?: string;
  }[];
  created_at?: string;
  updated_at?: string;
};

export type CompanyWithIncludes = {
  id?: number;
  name: string;
  title?: string;
  notes?: string;
  bank_account?: string;
  manager_id?: number;
  manager?: {
    id?: number;
    first_name?: string;
    last_name?: string;
    full_name?: string;
    username?: string;
    email?: string;
    phone?: string;
    role_id?: number;
    status?: string;
    created_at?: string;
    updated_at?: string;
    last_logged_at?: string;
  };
  buyer?: {
    id?: number;
    full_name?: string;
    email?: string;
    phone?: string;
    company_id?: number;
    manager_id?: number;
  };
  custom_fields?: {
    id?: number;
    uuid?: string;
    name?: string;
    type?: string;
    value?: string;
  }[];
  created_at?: string;
  updated_at?: string;
};

export type ExternalTransaction = {
  id?: number;
  uuid?: number;
  source_uuid?: string;
  gateway_id?: number;
  payments_data?: any[];
  amount?: number;
  description?: string;
  currency?: string;
  transaction_date?: string;
  created_at?: string;
  updated_at?: string;
};

export type Call = {
  id?: number;
  internal_number?: string;
  external_number?: string;
  source_number?: string;
  reference_id?: string;
  type?: string;
  state?: string;
  user_id?: number;
  call_route_service_id?: number;
  duration?: number;
  call_url?: string;
  comment?: string;
  client_id?: number;
  lead_id?: number;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  created_at?: string;
  updated_at?: string;
};

export type CallWithIncludes = {
  id?: number;
  internal_number?: string;
  external_number?: string;
  source_number?: string;
  reference_id?: string;
  type?: string;
  state?: string;
  user_id?: number;
  manager?: {
    id?: number;
    first_name?: string;
    last_name?: string;
    full_name?: string;
    username?: string;
    email?: string;
    phone?: string;
    role_id?: number;
    status?: string;
    created_at?: string;
    updated_at?: string;
    last_logged_at?: string;
  };
  call_route_service_id?: number;
  service?: {
    id?: number;
    name?: string;
    alias?: string;
    service?: string;
    uuid?: string;
    is_active?: boolean;
    configuraion?: Record<string, any>;
    created_at?: string;
    updated_at?: string;
    deleted_at?: string;
  };
  duration?: number;
  call_url?: string;
  comment?: string;
  client_id?: number;
  client?: {
    id?: number;
    company_id?: number;
    full_name?: string;
    phone?: string;
    formatted_phone?: string;
    additional_phone?: string;
    email?: string;
    note?: string;
    picture?: string;
    image?: string;
    currency?: string;
    orders_sum?: string;
    orders_count?: number;
    has_duplicates?: number;
    manager_id?: number;
    created_at?: string;
    updated_at?: string;
  };
  lead_id?: number;
  lead?: {
    id?: number;
    contact_id?: number;
    source_id?: number;
    manager_id?: number;
    status_id?: number;
    title?: string;
    manager_comment?: string;
    is_finished?: string;
    status_changed_at?: string;
    communicate_at?: string;
    created_at?: string;
    updated_at?: string;
  };
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  created_at?: string;
  updated_at?: string;
};

export class ApiClient {
  baseUrl: string;
  token?: string;
  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }
  setToken(token: string): void {
    this.token = token;
  }
  async request(method: string, path: string, body?: any): Promise<any> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    // Спільний ліміт ключа: краще зачекати, ніж отримати відмову,
    // яку викликач може помилково прийняти за «даних немає».
    await awaitCrmSlot();
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method: method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(CONFIG.CRM_REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      // Мережа/таймаут — це невідомий стан, а не порожня відповідь CRM.
      return {
        __httpStatus: 504,
        message: `CRM недоступна (${method} ${path}): ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    let parsed: any;
    try {
      parsed = await res.json();
    } catch {
      parsed = {
        __httpStatus: res.status,
        message: `CRM віддала не-JSON відповідь (HTTP ${res.status})`,
      };
    }
    // Відмови CRM (ліміт, автентифікація) приходять як звичайна відповідь із тілом,
    // а не як виняток. Позначаємо їх статусом, щоб викликач міг відрізнити
    // «немає даних» від «CRM відмовила» і не створював дубль навмання.
    if (!res.ok && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsed.__httpStatus = res.status;
    }
    return parsed;
  }
}

export class OrderService {
  private client: ApiClient;
  constructor(client: ApiClient) {
    this.client = client;
  }
  async getPaginatedListOfOrders(): Promise<Record<string, any>> {
    return this.client.request(
      "GET",
      "/order?include=products.offer",
      undefined,
    );
  }
  async getOrdersBySourceUuid(sourceUuid: string): Promise<Record<string, any>> {
    const q = encodeURIComponent(sourceUuid);
    // CRM ігнорує параметр source_uuid без filter[] і віддає останні замовлення,
    // через що перевірка «чи вже є картка» ніколи не спрацьовувала.
    return this.client.request(
      "GET",
      `/order?filter%5Bsource_uuid%5D=${q}&include=products.offer`,
      undefined,
    );
  }
  async createNewOrder(body?: {
    source_id: number;
    source_uuid?: string;
    buyer_comment?: string;
    manager_id?: number;
    manager_comment?: string;
    promocode?: string;
    discount_percent?: number;
    discount_amount?: number;
    shipping_price?: number;
    wrap_price?: number;
    gift_message?: string;
    is_gift?: boolean;
    gift_wrap?: boolean;
    taxes?: number;
    ordered_at?: string;
    buyer: {
      full_name?: string;
      email?: string;
      phone?: string;
    };
    shipping?: {
      delivery_service_id?: number;
      tracking_code?: string;
      shipping_service?: string;
      shipping_address_city?: string;
      shipping_address_country?: string;
      shipping_address_region?: string;
      shipping_address_zip?: string;
      shipping_secondary_line?: string;
      shipping_receive_point?: string;
      recipient_full_name?: string;
      recipient_phone?: string;
      warehouse_ref?: string;
      shipping_date?: string;
    };
    marketing?: {
      utm_source?: string;
      utm_medium?: string;
      utm_campaign?: string;
      utm_term?: string;
      utm_content?: string;
    };
    products?: {
      sku?: string;
      price?: number;
      purchased_price?: number;
      discount_percent?: number;
      discount_amount?: number;
      quantity?: number;
      unit_type?: string;
      name?: string;
      comment?: string;
      picture?: string;
      properties?: {
        name?: string;
        value?: string;
      }[];
    }[];
    payments?: {
      payment_method_id?: number;
      payment_method?: string;
      amount: number;
      description?: string;
      payment_date?: string;
      status?: string;
    }[];
    custom_fields?: {
      uuid?: string;
      value?: string | number;
    }[];
  }): Promise<Order> {
    return this.client.request("POST", "/order", body);
  }
  async createNewOrderImport(body?: {
    orders: {
      source_id: number;
      source_uuid?: string;
      buyer_comment?: string;
      manager_comment?: string;
      promocode?: string;
      discount_percent?: number;
      discount_amount?: number;
      shipping_price?: number;
      wrap_price?: number;
      taxes?: number;
      ordered_at?: string;
      buyer: {
        full_name?: string;
        email?: string;
        phone?: string;
      };
      shipping?: {
        delivery_service_id?: number;
        tracking_code?: string;
        shipping_address_city?: string;
        shipping_address_country?: string;
        shipping_address_region?: string;
        shipping_address_zip?: string;
        shipping_secondary_line?: string;
        shipping_receive_point?: string;
        recipient_full_name?: string;
        recipient_phone?: string;
        warehouse_ref?: string;
        shipping_date?: string;
      };
      marketing?: {
        utm_source?: string;
        utm_medium?: string;
        utm_campaign?: string;
        utm_term?: string;
        utm_content?: string;
      };
      products?: {
        sku?: string;
        price?: number;
        purchased_price?: number;
        discount_percent?: number;
        discount_amount?: number;
        quantity?: number;
        unit_type?: string;
        name?: string;
        comment?: string;
        picture?: string;
        properties?: {
          name?: string;
          value?: string;
        }[];
      }[];
      payments?: {
        payment_method_id?: number;
        payment_method?: string;
        amount: number;
        description?: string;
        payment_date?: string;
        status?: string;
      }[];
      custom_fields?: {
        uuid?: string;
        value?: string;
      }[];
    }[];
  }): Promise<any> {
    return this.client.request("POST", "/order/import", body);
  }
  async getOrderById(orderId: string): Promise<OrderWithIncludes> {
    return this.client.request(
      "GET",
      "/order/{orderId}".replace("{orderId}", orderId),
      undefined,
    );
  }
  async updateExistingOrder(
    orderId: string,
    body?: {
      buyer_comment?: string;
      manager_comment?: string;
      status_id?: number;
      discount_percent?: number;
      discount_amount?: number;
      products?: {
        sku?: string;
        id?: number;
        name?: string;
        comment?: string;
        price?: number;
        purchased_price?: number;
        discount_amount?: number;
        discount_percent?: number;
        quantity?: number;
        product_status_id?: number;
      }[];
      shipping?: {
        delivery_service_id?: number;
        tracking_code?: string;
        shipping_address_city?: string;
        shipping_address_country?: string;
        shipping_address_region?: string;
        shipping_address_zip?: string;
        shipping_receive_point?: string;
        shipping_secondary_line?: string;
        recipient_full_name?: string;
        recipient_phone?: string;
        warehouse_ref?: string;
        shipping_date?: string;
      };
      custom_fields?: {
        uuid?: string;
        value?: string;
      }[];
    },
  ): Promise<any> {
    return this.client.request(
      "PUT",
      "/order/{orderId}".replace("{orderId}", orderId),
      body,
    );
  }
  async createNewOrderPayment(
    orderId: string,
    body?: {
      payment_method_id?: number;
      payment_method?: string;
      amount: number;
      status?: string;
      description?: string;
      payment_date?: string;
    },
  ): Promise<Payment> {
    return this.client.request(
      "POST",
      "/order/{orderId}/payment".replace("{orderId}", orderId),
      body,
    );
  }
  async createNewOrderExpense(
    orderId: string,
    body?: {
      expense_type_id?: number;
      expense_type?: string;
      amount: number;
      description?: string;
      payment_date?: string;
    },
  ): Promise<Expense> {
    return this.client.request(
      "POST",
      "/order/{orderId}/expense".replace("{orderId}", orderId),
      body,
    );
  }
  async updateExistingOrderPayment(
    orderId: string,
    paymentId: string,
    body?: {
      status?: string;
      description?: string;
    },
  ): Promise<any> {
    return this.client.request(
      "PUT",
      "/order/{orderId}/payment/{paymentId}"
        .replace("{orderId}", orderId)
        .replace("{paymentId}", paymentId),
      body,
    );
  }
  async updateExistingOrderExpense(
    orderId: string,
    expenseId: string,
    body?: {
      status?: string;
      description?: string;
    },
  ): Promise<any> {
    return this.client.request(
      "PUT",
      "/order/{orderId}/expense/{expenseId}"
        .replace("{orderId}", orderId)
        .replace("{expenseId}", expenseId),
      body,
    );
  }
  async attachTagToOrder(
    orderId: string,
    tagId: string,
    body?: any,
  ): Promise<any> {
    return this.client.request(
      "POST",
      "/order/{orderId}/tag/{tagId}"
        .replace("{orderId}", orderId)
        .replace("{tagId}", tagId),
      body,
    );
  }
  async deleteTagFromOrder(orderId: string, tagId: string): Promise<any> {
    return this.client.request(
      "DELETE",
      "/order/{orderId}/tag/{tagId}"
        .replace("{orderId}", orderId)
        .replace("{tagId}", tagId),
      undefined,
    );
  }
  async attachFileToOrder(
    orderId: string,
    fileId: string,
    body?: any,
  ): Promise<any> {
    return this.client.request(
      "POST",
      "/order/{orderId}/attachment/{fileId}"
        .replace("{orderId}", orderId)
        .replace("{fileId}", fileId),
      body,
    );
  }
  async deleteFileFromOrder(
    orderId: string,
    fileId: string,
  ): Promise<{
    status?: boolean;
  }> {
    return this.client.request(
      "DELETE",
      "/order/{orderId}/attachment/{fileId}"
        .replace("{orderId}", orderId)
        .replace("{fileId}", fileId),
      undefined,
    );
  }
  async getPaginatedListOfTags(): Promise<Record<string, any>> {
    return this.client.request("GET", "/order/tag", undefined);
  }
  async getPaginatedListOfSources(): Promise<Record<string, any>> {
    return this.client.request("GET", "/order/source", undefined);
  }
  async getPaginatedListOfStatuses(): Promise<Record<string, any>> {
    return this.client.request("GET", "/order/status", undefined);
  }
  async getPaginatedListOfPaymentMethods(): Promise<Record<string, any>> {
    return this.client.request("GET", "/order/payment-method", undefined);
  }
  async getPaginatedListOfExpenseTypes(): Promise<Record<string, any>> {
    return this.client.request("GET", "/order/expense-type", undefined);
  }
  async getPaginatedListOfDeliveryServices(): Promise<Record<string, any>> {
    return this.client.request("GET", "/order/delivery-service", undefined);
  }
  async getPaginatedListOfProductStatuses(): Promise<Record<string, any>> {
    return this.client.request("GET", "/order/product-status", undefined);
  }
}

export class StorageService {
  private client: ApiClient;
  constructor(client: ApiClient) {
    this.client = client;
  }
  async getPaginatedListOfFiles(): Promise<Record<string, any>> {
    return this.client.request("GET", "/storage", undefined);
  }
  async getEntityListOfFiles(
    entityType: string,
    entityId: string,
  ): Promise<File[]> {
    return this.client.request(
      "GET",
      "/storage/attachment/{entityType}/{entityId}"
        .replace("{entityType}", entityType)
        .replace("{entityId}", entityId),
      undefined,
    );
  }
  async uploadStorageFile(body?: any): Promise<File> {
    return this.client.request("POST", "/storage/upload", body);
  }
}

export class CustomFieldsService {
  private client: ApiClient;
  constructor(client: ApiClient) {
    this.client = client;
  }
  async getListOfCustomFields(): Promise<CustomField[]> {
    return this.client.request("GET", "/custom-fields", undefined);
  }
}

export class OfferService {
  private client: ApiClient;
  constructor(client: ApiClient) {
    this.client = client;
  }
  async getPaginatedListOfOffers(): Promise<Record<string, any>> {
    return this.client.request("GET", "/offers", undefined);
  }
  async offersUpdate(body?: {
    offers: {
      id?: number;
      sku?: string;
      price?: number;
      purchased_price?: number;
      weight?: number;
      height?: number;
      image_url?: string;
      length?: number;
      width?: number;
    }[];
  }): Promise<any> {
    return this.client.request("PUT", "/offers", body);
  }
  async getPaginatedListOfStocks(): Promise<Record<string, any>> {
    return this.client.request("GET", "/offers/stocks", undefined);
  }
  async offersStocksUpdate(body?: {
    warehouse_id: number;
    stocks: {
      id?: number;
      sku?: string;
      quantity: number;
    }[];
  }): Promise<any> {
    return this.client.request("PUT", "/offers/stocks", body);
  }
}

export class PipelinesService {
  private client: ApiClient;
  constructor(client: ApiClient) {
    this.client = client;
  }
  async getPaginatedListOfPipelines(): Promise<Record<string, any>> {
    return this.client.request("GET", "/pipelines", undefined);
  }
  async getPaginatedListOfPipelinesStatuses(
    pipelineId: string,
  ): Promise<Record<string, any>> {
    return this.client.request(
      "GET",
      "/pipelines/{pipelineId}/statuses".replace("{pipelineId}", pipelineId),
      undefined,
    );
  }
  async getPaginatedListOfPipelinesCards(query?: {
    limit?: number;
    page?: number;
    include?: string;
    filter?: Record<string, string | number | boolean | undefined | null>;
  }): Promise<Record<string, any>> {
    const params = new URLSearchParams();

    if (query?.limit != null) {
      params.set("limit", String(query.limit));
    }
    if (query?.page != null) {
      params.set("page", String(query.page));
    }
    if (query?.include) {
      params.set("include", query.include);
    }
    if (query?.filter) {
      for (const [key, value] of Object.entries(query.filter)) {
        if (value == null) continue;
        params.set(`filter[${key}]`, String(value));
      }
    }

    const suffix = params.toString();
    const path = suffix ? `/pipelines/cards?${suffix}` : "/pipelines/cards";
    return this.client.request("GET", path, undefined);
  }
  async createNewPipelineCard(body?: {
    title?: string;
    source_id?: number;
    manager_comment?: string;
    manager_id?: number;
    pipeline_id?: number;
    communicate_at?: string;
    contact: {
      full_name?: string;
      email?: string;
      phone?: string;
      client_id?: number;
    };
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_term?: string;
    utm_content?: string;
    products?: {
      sku?: string;
      price?: number;
      quantity?: number;
      unit_type?: string;
      name?: string;
      picture?: string;
    }[];
    payments?: {
      payment_method_id?: number;
      payment_method?: string;
      amount: number;
      description?: string;
      payment_date?: string;
      status?: string;
    }[];
    custom_fields?: {
      uuid?: string;
      value?: string | number;
    }[];
  }): Promise<PipelineCard> {
    return this.client.request("POST", "/pipelines/cards", body);
  }
  async getPipelinesCard(cardId: string): Promise<Record<string, any>> {
    return this.client.request(
      "GET",
      "/pipelines/cards/{cardId}".replace("{cardId}", cardId),
      undefined,
    );
  }
  async updatePipelinesCard(
    cardId: string,
    body?: {
      title?: string;
      note?: string;
      status_id?: number;
      source_id?: number;
      client_id?: number;
      manager_id?: number;
      communicate_at?: string;
      products?: {
        name?: string;
        sku?: string;
        price?: number;
        quantity?: number;
        picture?: string;
      }[];
      custom_fields?: {
        uuid?: string;
        value?: string;
      }[];
    },
  ): Promise<any> {
    return this.client.request(
      "PUT",
      "/pipelines/cards/{cardId}".replace("{cardId}", cardId),
      body,
    );
  }
  async createNewPipelinesCardPayment(
    cardId: string,
    body?: {
      payment_method_id?: number;
      payment_method?: string;
      amount: number;
      status?: string;
      description?: string;
      payment_date?: string;
    },
  ): Promise<Payment> {
    return this.client.request(
      "POST",
      "/pipelines/cards/{cardId}/payment".replace("{cardId}", cardId),
      body,
    );
  }
  async updateExistingPipelinesCardPayment(
    cardId: string,
    paymentId: string,
    body?: {
      status?: string;
      description?: string;
    },
  ): Promise<any> {
    return this.client.request(
      "PUT",
      "/pipelines/cards/{cardId}/payment/{paymentId}"
        .replace("{cardId}", cardId)
        .replace("{paymentId}", paymentId),
      body,
    );
  }
  async attachFileToPipelinesCard(
    cardId: string,
    fileId: string,
    body?: any,
  ): Promise<any> {
    return this.client.request(
      "POST",
      "/pipelines/cards/{cardId}/attachment/{fileId}"
        .replace("{cardId}", cardId)
        .replace("{fileId}", fileId),
      body,
    );
  }
  async deleteFileFromCard(
    cardId: string,
    fileId: string,
  ): Promise<{
    status?: boolean;
  }> {
    return this.client.request(
      "DELETE",
      "/pipelines/cards/{cardId}/attachment/{fileId}"
        .replace("{cardId}", cardId)
        .replace("{fileId}", fileId),
      undefined,
    );
  }
}

export class BuyerService {
  private client: ApiClient;
  constructor(client: ApiClient) {
    this.client = client;
  }
  async getBuyerById(buyerId: string): Promise<BuyerWithIncludes> {
    return this.client.request(
      "GET",
      "/buyer/{buyerId}".replace("{buyerId}", buyerId),
      undefined,
    );
  }
  async updateExistingBuyer(
    buyerId: string,
    body?: {
      full_name: string;
      birthday?: string;
      email?: string[];
      phone?: string[];
      note?: string;
      discount?: number;
      company_id?: number;
      manager_id?: number;
      shipping?: {
        address?: string;
        additional_address?: string;
        city?: string;
        region?: string;
        zip_code?: string;
        country?: string;
        recipient_full_name?: string;
        recipient_phone?: string;
        warehouse_ref?: string;
        shipping_service?: string;
      }[];
      custom_fields?: {
        uuid?: string;
        value?: string;
      }[];
    },
  ): Promise<any> {
    return this.client.request(
      "PUT",
      "/buyer/{buyerId}".replace("{buyerId}", buyerId),
      body,
    );
  }
  async getPaginatedListOfBuyers(): Promise<Record<string, any>> {
    return this.client.request("GET", "/buyer", undefined);
  }
  async createNewBuyer(body?: {
    full_name: string;
    birthday?: string;
    email?: string[];
    phone?: string[];
    note?: string;
    discount?: number;
    company_id?: number;
    manager_id?: number;
    shipping?: {
      address?: string;
      additional_address?: string;
      city?: string;
      region?: string;
      zip_code?: string;
      country?: string;
      recipient_full_name?: string;
      recipient_phone?: string;
      warehouse_ref?: string;
      shipping_service?: string;
    }[];
    custom_fields?: {
      uuid?: string;
      value?: string;
    }[];
  }): Promise<Buyer> {
    return this.client.request("POST", "/buyer", body);
  }
  async importBuyers(body?: {
    buyers: {
      full_name?: string;
      birthday?: string;
      email?: string[];
      phone?: string[];
      note?: string;
      discount?: number;
      company_id?: number;
      manager_id?: number;
      shipping?: {
        address?: string;
        additional_address?: string;
        city?: string;
        region?: string;
        zip_code?: string;
        country?: string;
        recipient_full_name?: string;
        recipient_phone?: string;
        warehouse_ref?: string;
        shipping_service?: string;
      }[];
      custom_fields?: {
        uuid?: string;
        value?: string;
      }[];
    }[];
  }): Promise<{
    status?: boolean;
  }> {
    return this.client.request("POST", "/buyer/import", body);
  }
}

export class CompanyService {
  private client: ApiClient;
  constructor(client: ApiClient) {
    this.client = client;
  }
  async createNewCompany(body?: {
    name: string;
    title?: string;
    bank_account?: string;
    notes?: string;
    manager_id?: number;
    buyer_id?: string[];
    custom_fields?: {
      uuid?: string;
      value?: string;
    }[];
  }): Promise<Company> {
    return this.client.request("POST", "/companies", body);
  }
  async getPaginatedListOfCompanies(): Promise<Record<string, any>> {
    return this.client.request("GET", "/companies", undefined);
  }
  async getCompanyById(companyId: string): Promise<CompanyWithIncludes> {
    return this.client.request(
      "GET",
      "/companies/{companyId}".replace("{companyId}", companyId),
      undefined,
    );
  }
  async updateExistingCompany(
    companyId: string,
    body?: {
      name: string;
      title?: string;
      bank_account?: string;
      notes?: string;
      manager_id?: number;
      buyer_id?: string[];
      custom_fields?: {
        uuid?: string;
        value?: string;
      }[];
    },
  ): Promise<Company> {
    return this.client.request(
      "PUT",
      "/companies/{companyId}".replace("{companyId}", companyId),
      body,
    );
  }
}

export class PaymentsService {
  private client: ApiClient;
  constructor(client: ApiClient) {
    this.client = client;
  }
  async getPaginatedListOfExternalTransactions(): Promise<Record<string, any>> {
    return this.client.request(
      "GET",
      "/payments/external-transactions",
      undefined,
    );
  }
  async attachExternalTransactionToPayment(
    paymentId: string,
    body?: {
      transaction_id?: number;
      transaction_uuid?: string;
    },
  ): Promise<Payment> {
    return this.client.request(
      "POST",
      "/payments/{paymentId}/external-transactions".replace(
        "{paymentId}",
        paymentId,
      ),
      body,
    );
  }
}

export class ProductsService {
  private client: ApiClient;
  constructor(client: ApiClient) {
    this.client = client;
  }
  async getPaginatedListOfProducts(): Promise<Record<string, any>> {
    return this.client.request("GET", "/products", undefined);
  }
  async createNewProduct(body?: {
    name: string;
    description?: string;
    pictures?: string[];
    currency_code?: string;
    sku?: string;
    barcode?: string;
    price?: number;
    purchased_price?: number;
    unit_type?: string;
    weight?: number;
    length?: number;
    width?: number;
    height?: number;
    category_id?: number;
    custom_fields?: {
      uuid?: string;
      value?: string;
    }[];
  }): Promise<Product> {
    return this.client.request("POST", "/products", body);
  }
  async createNewProductImport(body?: {
    products: {
      name: string;
      description?: string;
      pictures?: string[];
      currency_code?: string;
      sku?: string;
      barcode?: string;
      price?: number;
      purchased_price?: number;
      unit_type?: string;
      weight?: number;
      length?: number;
      width?: number;
      height?: number;
      category_id?: number;
      custom_fields?: {
        uuid?: string;
        value?: string;
      }[];
    }[];
  }): Promise<{
    status?: boolean;
  }> {
    return this.client.request("POST", "/products/import", body);
  }
  async getProductById(productId: string): Promise<ProductWithIncludes> {
    return this.client.request(
      "GET",
      "/products/{productId}".replace("{productId}", productId),
      undefined,
    );
  }
  async updateExistingProduct(
    productId: string,
    body?: {
      name?: string;
      description?: string;
      pictures?: string[];
      currency_code?: string;
      sku?: string;
      barcode?: string;
      price?: number;
      purchased_price?: number;
      unit_type?: string;
      weight?: number;
      length?: number;
      width?: number;
      height?: number;
      category_id?: number;
      custom_fields?: {
        uuid?: string;
        value?: string;
      }[];
    },
  ): Promise<any> {
    return this.client.request(
      "PUT",
      "/products/{productId}".replace("{productId}", productId),
      body,
    );
  }
  async createNewProductOffers(
    productId: string,
    body?: {
      offers?: {
        sku?: string;
        barcode?: string;
        price?: number;
        purchased_price?: number;
        weight?: number;
        height?: number;
        image_url?: string;
        length?: number;
        width?: number;
        properties?: {
          name?: string;
          value?: string;
        }[];
      }[];
    },
  ): Promise<{
    status?: boolean;
  }> {
    return this.client.request(
      "POST",
      "/products/{productId}/offers".replace("{productId}", productId),
      body,
    );
  }
  async getPaginatedListOfCategories(): Promise<Record<string, any>> {
    return this.client.request("GET", "/products/categories", undefined);
  }
  async createNewCategory(body?: {
    name?: string;
    parent_id?: number;
  }): Promise<Category> {
    return this.client.request("POST", "/products/categories", body);
  }
}

export class CallsService {
  private client: ApiClient;
  constructor(client: ApiClient) {
    this.client = client;
  }
  async getPaginatedListOfCalls(): Promise<Record<string, any>> {
    return this.client.request("GET", "/calls", undefined);
  }
}

export class UsersService {
  private client: ApiClient;
  constructor(client: ApiClient) {
    this.client = client;
  }
  async getPaginatedListOfUsers(): Promise<Record<string, any>> {
    return this.client.request("GET", "/users", undefined);
  }
}

export class SDK {
  private client: ApiClient;
  readonly order: OrderService;
  readonly storage: StorageService;
  readonly customFields: CustomFieldsService;
  readonly offer: OfferService;
  readonly pipelines: PipelinesService;
  readonly buyer: BuyerService;
  readonly company: CompanyService;
  readonly payments: PaymentsService;
  readonly products: ProductsService;
  readonly calls: CallsService;
  readonly users: UsersService;
  constructor(baseUrl: string, token?: string) {
    const client = new ApiClient(baseUrl, token);
    this.client = client;
    this.order = new OrderService(client);
    this.storage = new StorageService(client);
    this.customFields = new CustomFieldsService(client);
    this.offer = new OfferService(client);
    this.pipelines = new PipelinesService(client);
    this.buyer = new BuyerService(client);
    this.company = new CompanyService(client);
    this.payments = new PaymentsService(client);
    this.products = new ProductsService(client);
    this.calls = new CallsService(client);
    this.users = new UsersService(client);
  }
  setToken(token: string): void {
    this.client.setToken(token);
  }
}
