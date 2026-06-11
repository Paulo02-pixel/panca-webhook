const express = require('express');

const app = express();

app.use(express.json());

// Rutas
app.use('/webhooks', require('./routes/webhooks'));
app.use('/orders', require('./routes/orders'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 404
app.use((req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

// Error handler global
app.use((err, req, res, next) => {
  console.error('[app] Error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

module.exports = app;
