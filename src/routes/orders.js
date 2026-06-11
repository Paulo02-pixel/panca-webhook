const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const { serializeOrder } = require('../services/webhookService');

const VALID_STATUSES = ['received', 'confirmed', 'in_kitchen', 'ready', 'delivered', 'cancelled'];
const VALID_AGGREGATORS = ['rappi', 'pedidosya', 'unknown'];

/**
 * GET /orders
 *
 * Query params:
 *   status      - Filtrar por estado (opcional)
 *   aggregator  - Filtrar por canal de origen (opcional)
 *   page        - Página (default: 1)
 *   limit       - Resultados por página (default: 20, max: 100)
 */
router.get('/', async (req, res) => {
  try {
    const { status, aggregator, page = '1', limit = '20' } = req.query;
    const errors = [];

    // Validar filtros
    if (status && !VALID_STATUSES.includes(status)) {
      errors.push(`status debe ser uno de: ${VALID_STATUSES.join(', ')}`);
    }
    if (aggregator && !VALID_AGGREGATORS.includes(aggregator)) {
      errors.push(`aggregator debe ser uno de: ${VALID_AGGREGATORS.join(', ')}`);
    }

    const pageNum = parseInt(page, 10);
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);

    if (isNaN(pageNum) || pageNum < 1) {
      errors.push('page debe ser un entero >= 1');
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Parámetros inválidos', details: errors });
    }

    // Construir filtro
    const filter = {};
    if (status) filter.status = status;
    if (aggregator) filter['source.aggregator'] = aggregator;

    const skip = (pageNum - 1) * limitNum;

    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
      Order.countDocuments(filter),
    ]);

    return res.json({
      data: orders.map(serializeOrder),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error('[orders] Error al listar pedidos:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
