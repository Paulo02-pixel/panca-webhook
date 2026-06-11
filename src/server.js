require('dotenv').config();
const app = require('./app');
const { connectDB } = require('./db');

const PORT = process.env.PORT || 3000;

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] PANCA webhook service corriendo en puerto ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[server] Error al conectar a MongoDB:', err);
    process.exit(1);
  });
