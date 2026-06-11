/**
 * Validación del payload del webhook.
 * Responde 400 con cuerpo explicativo ante cualquier campo inválido.
 * No usamos librerías externas (joi/zod) para mantener 0 dependencias extra.
 */

const VALID_EVENT_TYPES = ['order.created', 'order.updated', 'order.cancelled'];
const VALID_AGGREGATORS = ['rappi', 'pedidosya'];

function validateWebhookPayload(req, res, next) {
  const errors = [];
  const body = req.body;

  // Campos raíz obligatorios
  if (!body.event_id || typeof body.event_id !== 'string') {
    errors.push('event_id es obligatorio y debe ser string');
  }
  if (!body.event_type || !VALID_EVENT_TYPES.includes(body.event_type)) {
    errors.push(`event_type debe ser uno de: ${VALID_EVENT_TYPES.join(', ')}`);
  }
  if (!body.timestamp) {
    errors.push('timestamp es obligatorio');
  } else if (isNaN(Date.parse(body.timestamp))) {
    errors.push('timestamp debe ser una fecha ISO 8601 válida');
  }
  if (!body.external_order_id || typeof body.external_order_id !== 'string') {
    errors.push('external_order_id es obligatorio y debe ser string');
  }

  // Aggregator se infiere del prefijo del external_order_id si no viene explícito,
  // pero también lo aceptamos en body.aggregator por flexibilidad.
  const aggregator = body.aggregator || inferAggregator(body.external_order_id || '');
  if (!VALID_AGGREGATORS.includes(aggregator)) {
    // No bloqueamos — lo guardamos como 'unknown'. Solo advertimos en log.
    req.inferredAggregator = 'unknown';
  } else {
    req.inferredAggregator = aggregator;
  }

  // Para cancelaciones el payload puede venir vacío — es válido.
  if (body.event_type !== 'order.cancelled') {
    if (!body.payload || typeof body.payload !== 'object') {
      errors.push('payload es obligatorio para order.created y order.updated');
    } else {
      const p = body.payload;

      if (!p.customer_name || typeof p.customer_name !== 'string') {
        errors.push('payload.customer_name es obligatorio');
      }
      if (!Array.isArray(p.items) || p.items.length === 0) {
        errors.push('payload.items debe ser un array no vacío');
      } else {
        p.items.forEach((item, idx) => {
          if (!item.sku) errors.push(`items[${idx}].sku es obligatorio`);
          if (!item.name) errors.push(`items[${idx}].name es obligatorio`);
          if (typeof item.quantity !== 'number' || item.quantity < 1) {
            errors.push(`items[${idx}].quantity debe ser un número >= 1`);
          }
          if (typeof item.unit_price !== 'number' || item.unit_price < 0) {
            errors.push(`items[${idx}].unit_price debe ser un número >= 0`);
          }
          if (item.modifiers && !Array.isArray(item.modifiers)) {
            errors.push(`items[${idx}].modifiers debe ser un array`);
          }
          if (Array.isArray(item.modifiers)) {
            item.modifiers.forEach((mod, mIdx) => {
              if (!mod.name) errors.push(`items[${idx}].modifiers[${mIdx}].name es obligatorio`);
              if (typeof mod.price !== 'number' || mod.price < 0) {
                errors.push(`items[${idx}].modifiers[${mIdx}].price debe ser un número >= 0`);
              }
            });
          }
        });
      }

      if (p.declared_total !== undefined && typeof p.declared_total !== 'number') {
        errors.push('payload.declared_total debe ser un número');
      }
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({
      error: 'Payload inválido',
      details: errors,
    });
  }

  next();
}

function inferAggregator(externalOrderId) {
  const id = externalOrderId.toLowerCase();
  if (id.startsWith('py-') || id.startsWith('pedidosya')) return 'pedidosya';
  if (id.startsWith('rp-') || id.startsWith('rappi')) return 'rappi';
  return 'unknown';
}

module.exports = { validateWebhookPayload, inferAggregator };
