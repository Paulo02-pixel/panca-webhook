const express = require('express');
const router = express.Router();
const { validateWebhookPayload } = require('../middleware/validateWebhook');
const { processWebhookEvent } = require('../services/webhookService');

/**
 * POST /webhooks/delivery
 *
 * Recibe eventos de agregadores de delivery.
 * Idempotente: el mismo event_id puede llegar N veces con el mismo resultado.
 */
router.post('/delivery', validateWebhookPayload, async (req, res) => {
  try {
    const result = await processWebhookEvent(req.body, req.inferredAggregator);
    return res.status(result.statusCode).json(result.body);
  } catch (err) {
    console.error('[webhook] Error inesperado:', err);
    return res.status(500).json({
      error: 'Error interno del servidor',
      message: 'Contacte al equipo de PANCA si el problema persiste',
    });
  }
});

module.exports = router;
