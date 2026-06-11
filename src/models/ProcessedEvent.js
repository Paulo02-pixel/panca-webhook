const mongoose = require('mongoose');

// Colección separada para idempotencia.
// Guardamos cada event_id procesado con el resultado HTTP que dimos,
// así si llega duplicado respondemos exactamente lo mismo sin reprocesar.
const ProcessedEventSchema = new mongoose.Schema(
  {
    event_id: { type: String, required: true, unique: true },
    status_code: { type: Number, required: true },
    response_body: { type: mongoose.Schema.Types.Mixed, required: true },
    processed_at: { type: Date, default: Date.now },
  },
  {
    // TTL: los eventos se eliminan después de 7 días para no crecer infinitamente.
    // Los agregadores reales no reintentan más allá de 24–48 h.
    expireAfterSeconds: 60 * 60 * 24 * 7,
  }
);

// El índice único sobre event_id ya actúa como guardia de concurrencia:
// si dos instancias intentan insertar el mismo event_id al mismo tiempo,
// una falla con DuplicateKey y cae en el bloque de idempotencia.
ProcessedEventSchema.index({ processed_at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });

module.exports = mongoose.model('ProcessedEvent', ProcessedEventSchema);
