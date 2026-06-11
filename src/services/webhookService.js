const Order = require('../models/Order');
const ProcessedEvent = require('../models/ProcessedEvent');
const { calculateTotalCents, mapItemsToDB, toCents } = require('../utils/money');
const { inferAggregator } = require('../middleware/validateWebhook');

/**
 * Procesa un evento de webhook de forma idempotente.
 *
 * Estrategia de idempotencia:
 * 1. Antes de procesar, buscamos el event_id en ProcessedEvent.
 * 2. Si existe → devolvemos exactamente la misma respuesta que dimos antes.
 * 3. Si no existe → procesamos y guardamos el resultado.
 * 4. El índice único en event_id actúa como mutex: si dos requests llegan
 *    simultáneamente con el mismo event_id, solo uno insertará con éxito;
 *    el otro recibirá DuplicateKey y caerá al paso 2.
 */
async function processWebhookEvent(eventData, aggregator) {
  const { event_id, event_type, external_order_id, payload } = eventData;

  // ── Paso 1: Verificar idempotencia ──────────────────────────────────────
  const existing = await ProcessedEvent.findOne({ event_id });
  if (existing) {
    return {
      statusCode: existing.status_code,
      body: existing.response_body,
      idempotent: true,
    };
  }

  // ── Paso 2: Procesar según tipo de evento ───────────────────────────────
  let statusCode;
  let responseBody;

  try {
    if (event_type === 'order.created') {
      ({ statusCode, responseBody } = await handleOrderCreated(
        external_order_id,
        aggregator,
        payload
      ));
    } else if (event_type === 'order.updated') {
      ({ statusCode, responseBody } = await handleOrderUpdated(
        external_order_id,
        aggregator,
        payload
      ));
    } else if (event_type === 'order.cancelled') {
      ({ statusCode, responseBody } = await handleOrderCancelled(
        external_order_id,
        aggregator
      ));
    }

    // ── Paso 3: Registrar evento como procesado ─────────────────────────
    await ProcessedEvent.create({
      event_id,
      status_code: statusCode,
      response_body: responseBody,
    });
  } catch (err) {
    // DuplicateKey en ProcessedEvent → carrera ganada por otra instancia,
    // reintentamos la lectura para devolver el resultado guardado.
    if (err.code === 11000 && err.keyPattern?.event_id) {
      const saved = await ProcessedEvent.findOne({ event_id });
      if (saved) {
        return {
          statusCode: saved.status_code,
          body: saved.response_body,
          idempotent: true,
        };
      }
    }
    throw err;
  }

  return { statusCode, body: responseBody, idempotent: false };
}

// ── Handlers por tipo de evento ─────────────────────────────────────────────

async function handleOrderCreated(externalOrderId, aggregator, payload) {
  const totalCents = calculateTotalCents(payload.items);
  const declaredCents = payload.declared_total !== undefined
    ? toCents(payload.declared_total)
    : null;
  const totalMismatch = declaredCents !== null && declaredCents !== totalCents;

  // Usamos findOneAndUpdate con upsert para que sea atómico:
  // si el pedido ya existe (creado por otro path), no lo pisamos.
  const order = await Order.findOneAndUpdate(
    {
      'source.aggregator': aggregator,
      'source.external_order_id': externalOrderId,
    },
    {
      $setOnInsert: {
        source: { aggregator, external_order_id: externalOrderId },
        customer_name: payload.customer_name,
        items: mapItemsToDB(payload.items),
        total_cents: totalCents,
        total_mismatch: totalMismatch,
        status: 'received',
        last_event_type: 'order.created',
      },
    },
    { upsert: true, new: true, runValidators: true }
  );

  return {
    statusCode: 201,
    responseBody: serializeOrder(order),
  };
}

async function handleOrderUpdated(externalOrderId, aggregator, payload) {
  const totalCents = calculateTotalCents(payload.items);
  const declaredCents = payload.declared_total !== undefined
    ? toCents(payload.declared_total)
    : null;
  const totalMismatch = declaredCents !== null && declaredCents !== totalCents;

  // Si el pedido no existe aún (order.updated llegó antes que order.created),
  // lo creamos en estado 'received'. Es mejor tener datos que perder el pedido.
  const order = await Order.findOneAndUpdate(
    {
      'source.aggregator': aggregator,
      'source.external_order_id': externalOrderId,
      // No actualizar si ya está cancelado o entregado.
      status: { $nin: ['cancelled', 'delivered'] },
    },
    {
      $set: {
        customer_name: payload.customer_name,
        items: mapItemsToDB(payload.items),
        total_cents: totalCents,
        total_mismatch: totalMismatch,
        last_event_type: 'order.updated',
      },
      $setOnInsert: {
        source: { aggregator, external_order_id: externalOrderId },
        status: 'received',
      },
    },
    { upsert: true, new: true, runValidators: true }
  );

  return {
    statusCode: 200,
    responseBody: serializeOrder(order),
  };
}

async function handleOrderCancelled(externalOrderId, aggregator) {
  // Estrategia para orden fuera de secuencia (cancelled antes que created):
  // Creamos el pedido directamente en estado 'cancelled'.
  // Si luego llega el order.created, el $setOnInsert no lo pisará porque
  // ya existe. El pedido queda cancelado — que es el estado correcto.
  const order = await Order.findOneAndUpdate(
    {
      'source.aggregator': aggregator,
      'source.external_order_id': externalOrderId,
    },
    {
      $set: {
        status: 'cancelled',
        last_event_type: 'order.cancelled',
      },
      $setOnInsert: {
        source: { aggregator, external_order_id: externalOrderId },
        customer_name: 'unknown',
        items: [],
        total_cents: 0,
      },
    },
    { upsert: true, new: true }
  );

  return {
    statusCode: 200,
    responseBody: serializeOrder(order),
  };
}

// ── Serialización ────────────────────────────────────────────────────────────

/**
 * Convierte centavos a soles en la salida.
 * El cliente recibe soles; nosotros guardamos centavos.
 */
function serializeOrder(order) {
  const obj = order.toObject();
  return {
    id: obj._id,
    source: obj.source,
    customer_name: obj.customer_name,
    items: obj.items.map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      unit_price: item.unit_price_cents / 100,
      modifiers: item.modifiers.map((mod) => ({
        name: mod.name,
        price: mod.price_cents / 100,
      })),
    })),
    total: obj.total_cents / 100,
    total_mismatch: obj.total_mismatch,
    status: obj.status,
    created_at: obj.createdAt,
    updated_at: obj.updatedAt,
  };
}

module.exports = { processWebhookEvent, serializeOrder };
