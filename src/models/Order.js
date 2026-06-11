const mongoose = require('mongoose');

// Modificadores embebidos dentro del item: siempre se leen juntos,
// nunca se necesitan de forma independiente → embed es la decisión correcta.
const ModifierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    // Precios en centavos (enteros) para evitar aritmética flotante.
    // La conversión ocurre en la capa de servicio, no aquí.
    price_cents: { type: Number, required: true, default: 0 },
  },
  { _id: false }
);

// Items embebidos en el pedido: un pedido sin sus items no tiene sentido,
// y los items no existen fuera del contexto de un pedido.
const OrderItemSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true },
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unit_price_cents: { type: Number, required: true, min: 0 },
    modifiers: { type: [ModifierSchema], default: [] },
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    // Canal de origen: referenciado como subdocumento plano.
    // No es una colección separada porque no gestionamos agregadores
    // como entidades independientes en este servicio.
    source: {
      aggregator: {
        type: String,
        required: true,
        enum: ['rappi', 'pedidosya', 'unknown'],
      },
      external_order_id: { type: String, required: true },
    },

    customer_name: { type: String, required: true },
    items: { type: [OrderItemSchema], required: true },

    // Total calculado en el servidor, en centavos.
    total_cents: { type: Number, required: true },

    // Flag de auditoría: el restaurante decide qué hacer,
    // nosotros solo lo registramos.
    total_mismatch: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ['received', 'confirmed', 'in_kitchen', 'ready', 'delivered', 'cancelled'],
      default: 'received',
    },

    // Guarda el último event_type procesado para manejar eventos fuera de orden.
    last_event_type: { type: String },
  },
  {
    timestamps: true, // createdAt, updatedAt automáticos
  }
);

// Índice compuesto para buscar por canal rápidamente (GET /orders con filtros).
OrderSchema.index({ 'source.aggregator': 1, status: 1 });
// Índice único para evitar duplicados por canal + ID externo.
OrderSchema.index({ 'source.aggregator': 1, 'source.external_order_id': 1 }, { unique: true });

module.exports = mongoose.model('Order', OrderSchema);
