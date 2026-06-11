/**
 * Utilidades para manejo de dinero.
 *
 * Regla de oro: NUNCA operamos con decimales. Todo se convierte a centavos
 * (enteros) al entrar, se procesa como enteros, y se convierte de vuelta
 * a soles solo al salir hacia el cliente.
 *
 * Por qué: 0.1 + 0.2 === 0.30000000000000004 en IEEE 754.
 * 2 × (28.90 + 3.00) con floats puede dar 63.800000000000004.
 * Con centavos: 2 × (2890 + 300) = 6380 → 63.80. Exacto.
 */

/**
 * Convierte soles (decimal) a centavos (entero).
 * Usa Math.round para absorber errores de representación flotante
 * en la entrada (ej: 28.9 puede ser 28.899999... internamente).
 */
function toCents(soles) {
  return Math.round(soles * 100);
}

/**
 * Convierte centavos (entero) a soles (decimal con 2 cifras).
 */
function fromCents(cents) {
  return cents / 100;
}

/**
 * Calcula el total de un pedido en centavos a partir de los items del payload.
 * Los items vienen con precios en soles (del webhook); los convertimos aquí.
 */
function calculateTotalCents(items) {
  let total = 0;
  for (const item of items) {
    const unitPriceCents = toCents(item.unit_price);
    const modifiersCents = (item.modifiers || []).reduce(
      (acc, mod) => acc + toCents(mod.price),
      0
    );
    total += item.quantity * (unitPriceCents + modifiersCents);
  }
  return total;
}

/**
 * Mapea items del payload al schema de MongoDB (centavos).
 */
function mapItemsToDB(items) {
  return items.map((item) => ({
    sku: item.sku,
    name: item.name,
    quantity: item.quantity,
    unit_price_cents: toCents(item.unit_price),
    modifiers: (item.modifiers || []).map((mod) => ({
      name: mod.name,
      price_cents: toCents(mod.price),
    })),
  }));
}

module.exports = { toCents, fromCents, calculateTotalCents, mapItemsToDB };
