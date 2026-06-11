/**
 * Tests con mocking de Mongoose — no requieren MongoDB instalado.
 * Probamos las capas de lógica más riesgosas: dinero, validación,
 * idempotencia (flujo), y eventos fuera de orden.
 */

// ── Mocks de modelos ──────────────────────────────────────────────────────────
jest.mock('../src/models/Order');
jest.mock('../src/models/ProcessedEvent');
jest.mock('../src/db', () => ({
  connectDB: jest.fn().mockResolvedValue(),
  disconnectDB: jest.fn().mockResolvedValue(),
}));

const request = require('supertest');
const app = require('../src/app');
const Order = require('../src/models/Order');
const ProcessedEvent = require('../src/models/ProcessedEvent');

// ── Helpers ───────────────────────────────────────────────────────────────────

const basePayload = (overrides = {}) => ({
  event_id: 'evt_test_001',
  event_type: 'order.created',
  timestamp: '2026-06-10T19:42:13Z',
  external_order_id: 'PY-448291',
  payload: {
    customer_name: 'María Torres',
    items: [
      {
        sku: 'LOMO-01',
        name: 'Lomo Saltado',
        quantity: 2,
        unit_price: 28.90,
        modifiers: [
          { name: 'Sin cebolla', price: 0 },
          { name: 'Huevo frito extra', price: 3.00 },
        ],
      },
    ],
    declared_total: 63.80,
  },
  ...overrides,
});

/** Crea un objeto Order mock con .toObject() */
function mockOrder(fields = {}) {
  const data = {
    _id: 'order_mock_id',
    source: { aggregator: 'pedidosya', external_order_id: 'PY-448291' },
    customer_name: 'María Torres',
    items: [
      {
        sku: 'LOMO-01', name: 'Lomo Saltado', quantity: 2,
        unit_price_cents: 2890,
        modifiers: [
          { name: 'Sin cebolla', price_cents: 0 },
          { name: 'Huevo frito extra', price_cents: 300 },
        ],
      },
    ],
    total_cents: 6380,
    total_mismatch: false,
    status: 'received',
    last_event_type: 'order.created',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  };
  return { ...data, toObject: () => data };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 1 — Manejo de dinero
// Es el riesgo más alto e invisible: no explota, solo cobra mal.
// ════════════════════════════════════════════════════════════════════════════

describe('Manejo de dinero', () => {
  test('2 × (28.90 + 3.00) da exactamente 63.80, no 63.800000000000004', () => {
    const { calculateTotalCents, fromCents } = require('../src/utils/money');
    const items = basePayload().payload.items;
    const totalCents = calculateTotalCents(items);
    expect(totalCents).toBe(6380);              // entero exacto
    expect(fromCents(totalCents)).toBe(63.80);  // decimal correcto
    // Demostrar que float puro sería problemático en otros casos:
    expect(0.1 + 0.2).not.toBe(0.3);           // el bug existe en JS
    expect(Math.round((0.1 + 0.2) * 100)).toBe(30); // nuestra solución lo evita
  });

  test('toCents absorbe errores de representación flotante en la entrada', () => {
    const { toCents } = require('../src/utils/money');
    // 28.9 internamente puede ser 28.899999999...
    expect(toCents(28.9)).toBe(2890);
    expect(toCents(3.00)).toBe(300);
    expect(toCents(0.01)).toBe(1);
    expect(toCents(63.80)).toBe(6380);
  });

  test('detecta mismatch y activa el flag sin rechazar el pedido', async () => {
    ProcessedEvent.findOne.mockResolvedValue(null);
    ProcessedEvent.create.mockResolvedValue({});
    const order = mockOrder({ total_mismatch: true, total_cents: 6380 });
    Order.findOneAndUpdate.mockResolvedValue(order);

    const payload = basePayload();
    payload.payload.declared_total = 50.00; // incorrecto a propósito

    const res = await request(app).post('/webhooks/delivery').send(payload);

    expect(res.status).toBe(201);
    // El pedido se guarda (no se rechaza)
    expect(Order.findOneAndUpdate).toHaveBeenCalled();
    // Verificar que el flag se habría activado comparando los valores
    const callArgs = Order.findOneAndUpdate.mock.calls[0];
    const updateDoc = callArgs[1];
    expect(updateDoc.$setOnInsert.total_mismatch).toBe(true);
  });

  test('pedido sin declared_total no activa mismatch', async () => {
    ProcessedEvent.findOne.mockResolvedValue(null);
    ProcessedEvent.create.mockResolvedValue({});
    const order = mockOrder({ total_mismatch: false });
    Order.findOneAndUpdate.mockResolvedValue(order);

    const payload = basePayload();
    delete payload.payload.declared_total;

    const res = await request(app).post('/webhooks/delivery').send(payload);
    expect(res.status).toBe(201);
    const updateDoc = Order.findOneAndUpdate.mock.calls[0][1];
    expect(updateDoc.$setOnInsert.total_mismatch).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 2 — Idempotencia
// Sin esto, la cocina prepara N pollos cuando el agregador reintenta.
// ════════════════════════════════════════════════════════════════════════════

describe('Idempotencia', () => {
  test('event_id ya procesado devuelve la misma respuesta sin tocar Order', async () => {
    const cachedResponse = mockOrder();
    // Simular que el evento YA fue procesado
    ProcessedEvent.findOne.mockResolvedValue({
      event_id: 'evt_test_001',
      status_code: 201,
      response_body: { id: 'order_mock_id', status: 'received', total: 63.80 },
    });

    const res = await request(app).post('/webhooks/delivery').send(basePayload());

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('order_mock_id');
    // LO MÁS IMPORTANTE: Order nunca se tocó
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('event_id nuevo sí procesa y guarda en ProcessedEvent', async () => {
    ProcessedEvent.findOne.mockResolvedValue(null); // nuevo
    ProcessedEvent.create.mockResolvedValue({});
    Order.findOneAndUpdate.mockResolvedValue(mockOrder());

    const res = await request(app).post('/webhooks/delivery').send(basePayload());

    expect(res.status).toBe(201);
    expect(Order.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(ProcessedEvent.create).toHaveBeenCalledTimes(1);

    // Verificar que guardamos el resultado correcto
    const savedEvent = ProcessedEvent.create.mock.calls[0][0];
    expect(savedEvent.event_id).toBe('evt_test_001');
    expect(savedEvent.status_code).toBe(201);
  });

  test('DuplicateKey en ProcessedEvent (race condition) cae al path idempotente', async () => {
    ProcessedEvent.findOne
      .mockResolvedValueOnce(null) // primera llamada: no existe
      .mockResolvedValueOnce({    // segunda llamada (post-error): lo encuentra
        event_id: 'evt_test_001',
        status_code: 201,
        response_body: { id: 'order_from_winner', status: 'received' },
      });

    const dupKeyError = new Error('duplicate key');
    dupKeyError.code = 11000;
    dupKeyError.keyPattern = { event_id: 1 };
    ProcessedEvent.create.mockRejectedValue(dupKeyError);
    Order.findOneAndUpdate.mockResolvedValue(mockOrder());

    const res = await request(app).post('/webhooks/delivery').send(basePayload());

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('order_from_winner');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 3 — Eventos fuera de orden
// order.cancelled puede llegar ANTES que order.created. Si esto rompe
// el sistema, perdemos visibilidad total del pedido.
// ════════════════════════════════════════════════════════════════════════════

describe('Eventos fuera de orden', () => {
  test('order.cancelled sin order.created previo crea pedido en estado cancelled', async () => {
    ProcessedEvent.findOne.mockResolvedValue(null);
    ProcessedEvent.create.mockResolvedValue({});
    const cancelledOrder = mockOrder({ status: 'cancelled', total_cents: 0, items: [] });
    Order.findOneAndUpdate.mockResolvedValue(cancelledOrder);

    const res = await request(app).post('/webhooks/delivery').send({
      event_id: 'evt_cancel_001',
      event_type: 'order.cancelled',
      timestamp: '2026-06-10T19:42:13Z',
      external_order_id: 'PY-999999',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');

    // Verificar que se usó upsert (no falla si no existe el pedido)
    const queryFilter = Order.findOneAndUpdate.mock.calls[0][0];
    const updateDoc = Order.findOneAndUpdate.mock.calls[0][1];
    const options = Order.findOneAndUpdate.mock.calls[0][2];
    expect(options.upsert).toBe(true);
    expect(updateDoc.$set.status).toBe('cancelled');
  });

  test('order.updated antes de order.created crea el pedido en received', async () => {
    ProcessedEvent.findOne.mockResolvedValue(null);
    ProcessedEvent.create.mockResolvedValue({});
    const newOrder = mockOrder({ status: 'received', last_event_type: 'order.updated' });
    Order.findOneAndUpdate.mockResolvedValue(newOrder);

    const res = await request(app).post('/webhooks/delivery').send({
      ...basePayload(),
      event_id: 'evt_update_first',
      event_type: 'order.updated',
      external_order_id: 'PY-777777',
    });

    expect(res.status).toBe(200);
    const options = Order.findOneAndUpdate.mock.calls[0][2];
    expect(options.upsert).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 4 — Validación de input
// Payloads malformados deben dar 400 explicativo, nunca 500.
// ════════════════════════════════════════════════════════════════════════════

describe('Validación de input', () => {
  test('payload vacío devuelve 400 con array de errores descriptivos', async () => {
    const res = await request(app).post('/webhooks/delivery').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Payload inválido');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
    // Nunca debe llegar a tocar la BD
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('event_type inválido devuelve 400 con mensaje sobre event_type', async () => {
    const res = await request(app).post('/webhooks/delivery').send({
      ...basePayload(),
      event_type: 'order.teleported',
    });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => d.includes('event_type'))).toBe(true);
  });

  test('quantity negativa en item devuelve 400', async () => {
    const payload = basePayload();
    payload.payload.items[0].quantity = -1;
    const res = await request(app).post('/webhooks/delivery').send(payload);
    expect(res.status).toBe(400);
  });

  test('unit_price faltante devuelve 400', async () => {
    const payload = basePayload();
    delete payload.payload.items[0].unit_price;
    const res = await request(app).post('/webhooks/delivery').send(payload);
    expect(res.status).toBe(400);
  });

  test('timestamp inválido devuelve 400', async () => {
    const res = await request(app).post('/webhooks/delivery').send({
      ...basePayload(),
      timestamp: 'no-es-una-fecha',
    });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => d.includes('timestamp'))).toBe(true);
  });

  test('order.cancelled sin payload es válido (payload opcional en cancelaciones)', async () => {
    ProcessedEvent.findOne.mockResolvedValue(null);
    ProcessedEvent.create.mockResolvedValue({});
    Order.findOneAndUpdate.mockResolvedValue(mockOrder({ status: 'cancelled' }));

    const res = await request(app).post('/webhooks/delivery').send({
      event_id: 'evt_cancel_valid',
      event_type: 'order.cancelled',
      timestamp: '2026-06-10T19:42:13Z',
      external_order_id: 'PY-CANCEL-01',
    });
    expect(res.status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 5 — GET /orders
// ════════════════════════════════════════════════════════════════════════════

describe('GET /orders', () => {
  const mockFind = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([mockOrder(), mockOrder({ status: 'cancelled' })]),
  };

  beforeEach(() => {
    Order.find = jest.fn().mockReturnValue(mockFind);
    Order.countDocuments = jest.fn().mockResolvedValue(2);
  });

  test('devuelve lista paginada con estructura correcta', async () => {
    const res = await request(app).get('/orders');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toMatchObject({
      page: 1,
      limit: 20,
      total: 2,
    });
  });

  test('filtra por status válido sin error', async () => {
    Order.find = jest.fn().mockReturnValue({ ...mockFind, limit: jest.fn().mockResolvedValue([mockOrder()]) });
    Order.countDocuments = jest.fn().mockResolvedValue(1);
    const res = await request(app).get('/orders?status=received');
    expect(res.status).toBe(200);
    expect(Order.find).toHaveBeenCalledWith(expect.objectContaining({ status: 'received' }));
  });

  test('status inválido devuelve 400', async () => {
    const res = await request(app).get('/orders?status=volando');
    expect(res.status).toBe(400);
    expect(Order.find).not.toHaveBeenCalled();
  });

  test('filtra por aggregator', async () => {
    Order.find = jest.fn().mockReturnValue({ ...mockFind, limit: jest.fn().mockResolvedValue([]) });
    Order.countDocuments = jest.fn().mockResolvedValue(0);
    const res = await request(app).get('/orders?aggregator=rappi');
    expect(res.status).toBe(200);
    expect(Order.find).toHaveBeenCalledWith(
      expect.objectContaining({ 'source.aggregator': 'rappi' })
    );
  });

  test('limit se aplica y no supera 100', async () => {
    const limitMock = jest.fn().mockResolvedValue([]);
    Order.find = jest.fn().mockReturnValue({ ...mockFind, limit: limitMock });
    Order.countDocuments = jest.fn().mockResolvedValue(0);
    await request(app).get('/orders?limit=500');
    // El limit real pasado a Mongoose debe ser 100 (cap)
    expect(limitMock).toHaveBeenCalledWith(100);
  });
});
