# PANCA Webhook Service

Mini-servicio para recibir y procesar webhooks de agregadores de delivery (Rappi, PedidosYa), con idempotencia garantizada, manejo correcto de dinero y resiliencia ante eventos fuera de orden.

---

## Cómo correrlo

### Opción A — Docker Compose (recomendado)

```bash
docker-compose up --build
```

El servicio queda disponible en `http://localhost:3000`.

### Opción B — Local con Node.js

**Requisitos:** Node.js 18+, MongoDB corriendo en `localhost:27017`

```bash
npm install
cp .env.example .env   # ajusta MONGODB_URI si es necesario
node src/server.js
```

### Correr los tests

```bash
npm install
npm test
```

Los tests usan `mongodb-memory-server` (MongoDB embebido), **no necesitan** una instancia externa.

---

## Endpoints

### `POST /webhooks/delivery`

Recibe eventos de los agregadores.

```json
{
  "event_id": "evt_8a2f91",
  "event_type": "order.created",
  "timestamp": "2026-06-10T19:42:13Z",
  "external_order_id": "PY-448291",
  "payload": {
    "customer_name": "María Torres",
    "items": [
      {
        "sku": "LOMO-01",
        "name": "Lomo Saltado",
        "quantity": 2,
        "unit_price": 28.90,
        "modifiers": [
          { "name": "Sin cebolla", "price": 0 },
          { "name": "Huevo frito extra", "price": 3.00 }
        ]
      }
    ],
    "declared_total": 63.80
  }
}
```

Respuestas: `201` (creado), `200` (actualizado/cancelado), `400` (payload inválido).

### `GET /orders`

Lista pedidos con filtros opcionales y paginación.

```
GET /orders?status=received&aggregator=pedidosya&page=1&limit=20
```

Parámetros:
- `status`: `received | confirmed | in_kitchen | ready | delivered | cancelled`
- `aggregator`: `rappi | pedidosya | unknown`
- `page`: entero >= 1 (default: 1)
- `limit`: entero 1–100 (default: 20)

---

## Decisiones de diseño

### Esquema MongoDB — ¿Embebido o referenciado?

**Items y modificadores: embebidos.**

Un pedido sin sus ítems no tiene sentido operativo. La cocina necesita leer el pedido completo en un solo query. Separar items en una colección aparte agregaría una join (lookup) sin ningún beneficio: los items nunca se reutilizan entre pedidos ni se consultan de forma independiente.

Los modificadores van embebidos dentro del item por la misma razón: "sin cebolla" no existe fuera del contexto del Lomo Saltado de este pedido.

**Canal de origen: subdocumento plano, no colección separada.**

No gestionamos agregadores como entidades con lógica propia en este servicio. Son datos de auditoría. Si en el futuro necesitáramos configuración por agregador (límites de rate, secretos de firma), ahí crearíamos la colección `Aggregators`.

**ProcessedEvent: colección separada.**

La idempotencia requiere un registro de eventos procesados. Va en colección aparte para no contaminar el modelo de negocio de `Order`. Tiene TTL de 7 días: los agregadores reales no reintentan más allá de 48 horas.

---

### Idempotencia

**Estrategia: lookup antes de procesar + índice único como mutex.**

1. Al recibir un evento, busco `event_id` en la colección `ProcessedEvent`.
2. Si existe → devuelvo exactamente la misma respuesta que guardé (mismo status code, mismo body). El cliente no puede distinguir si fue procesado ahora o antes.
3. Si no existe → proceso el evento y guardo el resultado en `ProcessedEvent`.
4. El índice único sobre `event_id` actúa como guardia de concurrencia: si dos instancias del servicio reciben el mismo evento simultáneamente, solo una insertará con éxito; la otra recibe `DuplicateKeyError` y cae al paso 2.

**Por qué no solo el índice único en `Order`:** el índice en `Order` evita pedidos duplicados pero no garantiza idempotencia a nivel de respuesta HTTP. Dos requests concurrentes podrían ejecutar el handler antes de que cualquiera guardara en `ProcessedEvent`, ambas crearían el pedido con `$setOnInsert` (que es atómico) pero ambas responderían 201 — lo cual es correcto. El índice en `ProcessedEvent` es el seguro adicional para el caso de reintentos más lentos.

---

### Manejo de dinero

**Regla: nunca operar con `float`. Todo en centavos (enteros).**

```
2 × (28.90 + 3.00) con float: 63.800000000000004  ← incorrecto
2 × (2890 + 300) centavos = 6380 → 63.80          ← correcto
```

IEEE 754 (el estándar de punto flotante que usa JavaScript) no puede representar exactamente la mayoría de los decimales financieros. `0.1 + 0.2 === 0.30000000000000004` en cualquier motor V8.

**Implementación:**
- `toCents(soles)`: `Math.round(valor * 100)` — el `Math.round` absorbe el error de representación en la *entrada* (ej: `28.9` puede ser `28.899999...` internamente).
- Todo el cálculo ocurre en enteros.
- `fromCents(cents)`: `cents / 100` — división entera que siempre es exacta para múltiplos de centavo.
- MongoDB guarda `total_cents`, `unit_price_cents`, `price_cents` como `Number` (entero).
- La serialización hacia el cliente convierte de vuelta a soles para la respuesta JSON.

---

### Eventos fuera de orden

**Escenario real:** el agregador puede enviar `order.cancelled` antes que `order.created` por retries, timeouts de red o bugs del lado del agregador.

**Decisión: el sistema nunca falla, siempre deja datos consistentes.**

- `order.cancelled` antes de `order.created`: creamos el pedido directamente en estado `cancelled` con `upsert`. Si luego llega el `order.created`, el `$setOnInsert` no lo modifica porque ya existe. El pedido queda cancelado — que es el estado correcto. No podemos "deshacer" una cancelación recibida.

- `order.updated` antes de `order.created`: creamos el pedido en estado `received` con los datos del update. Si luego llega el `order.created`, el `$setOnInsert` tampoco modifica el documento existente. Podemos perder los datos originales del `created` si llegó tarde, pero garantizamos que existe un pedido con datos válidos.

- Guardamos `last_event_type` para auditoría y para detectar estos casos en observabilidad.

**Alternativa que descarté:** queue de eventos ordenados por timestamp. Más correcto en teoría, pero agrega latencia y complejidad operacional para un escenario que, en la práctica, se resuelve bien con la estrategia de upsert + `$setOnInsert`.

---

## Parte B — Bug Hunt

### Código en cuestión

```javascript
async function applyDiscount(orderId, discountPercent) {
  const order = await Order.findById(orderId);
  const discount = order.total * (discountPercent / 100);
  order.total = order.total - discount;
  order.discountApplied = true;
  await order.save();
  return order;
}

app.post('/orders/:id/discount', async (req, res) => {
  const result = await applyDiscount(req.params.id, req.body.percent);
  res.json(result);
});
```

### Bugs encontrados

#### Bug 1 — Race condition (concurrencia) 🔴 Crítico

Si dos requests de descuento llegan al mismo tiempo para el mismo pedido:
1. Request A lee `order.total = 100`
2. Request B lee `order.total = 100`
3. Request A calcula descuento del 10% → guarda `total = 90`
4. Request B calcula descuento del 10% sobre 100 → guarda `total = 90`

El pedido recibe dos descuentos pero el total solo bajó una vez. El restaurante pierde dinero.

**Corrección:** operación atómica en MongoDB con `findOneAndUpdate` y operadores de actualización:

```javascript
const order = await Order.findOneAndUpdate(
  { _id: orderId, discountApplied: { $ne: true } },
  [
    {
      $set: {
        total: {
          $round: [{ $multiply: ['$total', { $subtract: [1, { $divide: [discountPercent, 100] }] }] }, 2]
        },
        discountApplied: true,
      },
    },
  ],
  { new: true }
);
```

O alternativamente, bloqueo optimista con un campo `version` y reintento si hubo conflicto.

---

#### Bug 2 — Sin validación de input 🔴 Crítico

`req.body.percent` puede ser:
- `undefined` → `discountPercent / 100 = NaN` → `order.total = NaN` → datos corrompidos en BD.
- Negativo (`-10`) → el "descuento" *sube* el precio.
- Mayor que 100 → el total se vuelve negativo.
- Un string (`"abc"`) → `NaN`.
- `0` → descuento del 0%, operación inútil pero no catastrófica.

`Order.findById` tampoco valida el `orderId`: un id malformado lanza una excepción no manejada que devuelve un 500 sin contexto.

**Corrección:**

```javascript
app.post('/orders/:id/discount', async (req, res) => {
  const percent = Number(req.body.percent);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    return res.status(400).json({ error: 'percent debe ser un número entre 0.01 y 100' });
  }
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'orderId inválido' });
  }
  // ...
});
```

---

#### Bug 3 — Aritmética de punto flotante 🟡 Importante

`order.total * (discountPercent / 100)` opera con floats. El mismo problema que en el webhook:

```
100 * (10 / 100) = 10                     ← OK en este caso
28.90 * (15 / 100) = 4.334999999999999   ← 4.33 o 4.34 dependiendo del round
```

Con totales y descuentos arbitrarios, el resultado puede tener más de 2 decimales.

**Corrección:** operar en centavos, igual que en el webhook service. Si el total está guardado como `total_cents`, el cálculo es:

```javascript
const discountCents = Math.round(order.total_cents * discountPercent / 100);
order.total_cents = order.total_cents - discountCents;
```

---

#### Bug 4 — Sin manejo de errores en el endpoint 🟡 Importante

Si `Order.findById` no encuentra el pedido, `order` es `null` y `order.total` lanza `TypeError: Cannot read properties of null`. El servidor responde con un 500 genérico.

Si hay un error de conexión a MongoDB, también es un 500 sin contexto.

**Corrección:**

```javascript
if (!order) {
  return res.status(404).json({ error: `Pedido ${orderId} no encontrado` });
}
```

Y un try/catch en el endpoint (o middleware de error global).

---

#### Bug 5 — `discountApplied` no previene doble descuento

El flag `discountApplied: true` se guarda pero nunca se verifica antes de aplicar el descuento. Un segundo request puede aplicar otro descuento aunque el primero ya se aplicó.

**Corrección:** verificar antes de proceder:

```javascript
if (order.discountApplied) {
  return res.status(409).json({ error: 'Este pedido ya tiene un descuento aplicado' });
}
```

O, mejor aún, incluirlo como condición en el query de `findOneAndUpdate` (ver Bug 1).

---

## Qué haría con 2 días más

Esto nos importa mucho como equipo, así que seré concreto:

**Día 1 — Producción-ready**

1. **Firma HMAC del webhook**: verificar que los eventos realmente vienen de Rappi/PedidosYa y no de un tercero. Cada agregador tiene un mecanismo distinto (header `X-Signature`, query param, etc.). Sin esto, cualquiera puede crear pedidos falsos.

2. **Transición de estados validada**: ahora cualquier handler puede cambiar el status a lo que quiera. Necesito una máquina de estados explícita:
   ```
   received → confirmed → in_kitchen → ready → delivered
                                              ↘ cancelled (desde cualquier estado pre-delivered)
   ```
   Un `order.created` no debería poder mover un pedido de `in_kitchen` de vuelta a `received`.

3. **Observabilidad**: structured logging (Winston/Pino) con `event_id`, `external_order_id` y `aggregator` en cada línea. Métricas de eventos procesados/fallidos por agregador. Sin esto, debuggear un pedido duplicado en producción es una pesadilla.

**Día 2 — Resiliencia y ops**

4. **Dead Letter Queue**: si el procesamiento de un evento falla repetidamente (error de validación del schema de Mongoose, por ejemplo), en este momento se pierde silenciosamente. Necesito un mecanismo para capturar esos eventos fallidos, notificar al equipo y poder reprocesarlos manualmente.

5. **Tests de carga de idempotencia concurrente**: los tests actuales son secuenciales. Quiero un test que dispare 50 requests del mismo `event_id` en paralelo con `Promise.all` y verifique que solo se crea 1 documento, para demostrar que el índice único de MongoDB funciona como mutex bajo carga real.

6. **Soporte para `order.updated` con cambio de estado**: ahora `order.updated` solo actualiza items/total. Los agregadores también pueden usarlo para señalar que el restaurante confirmó el pedido. Necesito mapear los estados del agregador a los estados internos de PANCA.

---

## Declaración de uso de IA

Usé Claude (Anthropic) como multiplicador en este reto, principalmente para:

- **Generar el scaffold inicial** de la estructura de carpetas y los schemas de Mongoose, que luego revisé y ajusté (especialmente la decisión de centavos vs decimales, que cambié de la sugerencia inicial de usar `decimal128` de MongoDB a centavos enteros por simplicidad operacional en JS).
- **Discutir la estrategia de idempotencia**: el LLM propuso inicialmente solo el índice único en `Order`; yo agregué la colección `ProcessedEvent` separada para poder devolver exactamente la misma respuesta HTTP y manejar la concurrencia explícitamente.
- **Revisar los bugs de la Parte B**: el LLM identificó los bugs 1, 2 y 4 rápidamente; los bugs 3 y 5 (flotantes en descuentos y doble descuento) los encontré yo revisando el código línea por línea.

Puedo explicar cualquier línea del código en la entrevista técnica.
