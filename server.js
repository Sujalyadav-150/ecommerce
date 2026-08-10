// server.js
// Express backend for the NEXUS AI shopping site.
// Serves the storefront (public/index.html) and powers all of its AI
// features + shared data storage through the Gemini API.

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai'); // current SDK — replaces the deprecated @google/generative-ai

const app = express();
const PORT = process.env.PORT || 3000;
// gemini-1.5-flash is fully shut down (404s on every request).
// gemini-3.1-flash-lite is a current, stable model as of Aug 2026 — override via .env if needed.
const CHAT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

if (!process.env.GEMINI_API_KEY) {
  console.warn('⚠️  Warning: GEMINI_API_KEY is not set. Add it to your .env file.');
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* -------------------------------------------------------------------- */
/* Shared key-value store (products, orders) — a real backend, so every  */
/* visitor sees the same catalog and order history. Cart stays per-      */
/* visitor in the browser's localStorage, so it isn't handled here.      */
/* -------------------------------------------------------------------- */
const DATA_FILE = path.join(__dirname, 'data', 'store.json');

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

app.get('/api/store/:key', (req, res) => {
  const store = readStore();
  const value = store[req.params.key];
  if (value === undefined) return res.status(404).json({ error: 'Not found' });
  res.json({ value });
});

app.post('/api/store/:key', (req, res) => {
  if (!('value' in req.body)) {
    return res.status(400).json({ error: 'Request body must include "value".' });
  }
  const store = readStore();
  store[req.params.key] = req.body.value;
  writeStore(store);
  res.json({ ok: true });
});

function getProductsFromStore(store) {
  return Array.isArray(store.products) ? store.products : [];
}

function getOrdersFromStore(store) {
  return Array.isArray(store.orders) ? store.orders : [];
}

function getCategories(products) {
  const counts = {};
  products.forEach((product) => {
    counts[product.category] = (counts[product.category] || 0) + 1;
  });
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getBrands(products) {
  const set = new Set(products.map((product) => product.brand).filter(Boolean));
  return [...set].sort((a, b) => a.localeCompare(b));
}

app.get('/api/products', (req, res) => {
  const store = readStore();
  const products = getProductsFromStore(store);
  res.json({ products, categories: getCategories(products), brands: getBrands(products) });
});

app.get('/api/categories', (req, res) => {
  const store = readStore();
  const products = getProductsFromStore(store);
  res.json({ categories: getCategories(products) });
});

app.get('/api/brands', (req, res) => {
  const store = readStore();
  const products = getProductsFromStore(store);
  res.json({ brands: getBrands(products) });
});

app.get('/api/products/:id', (req, res) => {
  const store = readStore();
  const products = getProductsFromStore(store);
  const product = products.find((item) => item.id === req.params.id);

  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const related = products.filter((item) => item.category === product.category && item.id !== product.id).slice(0, 3);
  const bundleItem = related[0] || null;

  res.json({ product, related, bundleItem });
});

app.post('/api/orders', (req, res) => {
  try {
    const { name, email, address, items, total } = req.body;
    if (!items || typeof items !== 'object') {
      return res.status(400).json({ error: 'items object is required.' });
    }

    const store = readStore();
    const orders = getOrdersFromStore(store);
    const order = {
      id: `ord_${Date.now()}`,
      name: name || 'Guest User',
      email: email || '',
      address: address || '',
      items,
      total: Number(total || 0),
      placedAt: new Date().toISOString(),
      status: 'Confirmed',
    };

    orders.unshift(order);
    store.orders = orders;
    writeStore(store);

    res.json({ ok: true, order });
  } catch (error) {
    console.error('Order save error:', error);
    res.status(500).json({ error: 'Could not save order.' });
  }
});

app.get('/api/orders', (req, res) => {
  const store = readStore();
  res.json({ orders: getOrdersFromStore(store) });
});

/* -------------------------------------------------------------------- */
/* Chat assistant — multi-turn, shopping-context-aware.                  */
/* Frontend sends: { messages: [{role:'user', content: systemContext},   */
/*   ...actual conversation turns] }. The first entry is always the      */
/* store's system context, so we split it out and use it as the model's  */
/* system instruction rather than a real conversational turn.            */
/* -------------------------------------------------------------------- */
app.post('/api/chat', async (req, res) => {
  try {
    const messages = req.body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required.' });
    }

    const [systemMsg, ...turns] = messages;
    const systemInstruction = systemMsg && systemMsg.content ? systemMsg.content : undefined;

    if (turns.length === 0) {
      return res.status(400).json({ error: 'At least one conversation turn is required.' });
    }

    // Build the full contents array (history + latest turn) — simpler and
    // more explicit than a stateful chat object, and works the same way.
    const contents = turns.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const result = await ai.models.generateContent({
      model: CHAT_MODEL,
      contents,
      config: systemInstruction ? { systemInstruction } : undefined,
    });
    const text = result.text;

    // Shaped like an Anthropic Messages response so the existing frontend
    // parsing (`data.content.map(c => c.text)`) keeps working unchanged.
    res.json({ content: [{ type: 'text', text }] });
  } catch (error) {
    console.error('Gemini chat error:', error);
    res.status(500).json({ error: 'Something went wrong while talking to the AI.' });
  }
});

/* -------------------------------------------------------------------- */
/* One-off AI completions — used for AI search, AI picks, review        */
/* summaries, and order-confirmation messages. Single prompt in,        */
/* single text out.                                                     */
/* -------------------------------------------------------------------- */
app.post('/api/ai', async (req, res) => {
  try {
    const { prompt, maxTokens } = req.body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt is required.' });
    }

    const result = await ai.models.generateContent({
      model: CHAT_MODEL,
      contents: prompt,
      config: maxTokens ? { maxOutputTokens: maxTokens } : undefined,
    });
    const text = result.text;

    res.json({ content: [{ type: 'text', text }] });
  } catch (error) {
    console.error('Gemini AI error:', error);
    res.status(500).json({ error: 'Something went wrong while talking to the AI.' });
  }
});

app.post('/api/ai/compare', async (req, res) => {
  try {
    const { productIds } = req.body;
    if (!Array.isArray(productIds) || productIds.length < 2) {
      return res.status(400).json({ error: 'At least two product IDs are required.' });
    }

    const store = readStore();
    const products = getProductsFromStore(store);
    const selected = products.filter((item) => productIds.includes(item.id));

    if (selected.length < 2) {
      return res.status(400).json({ error: 'Selected products were not found.' });
    }

    const prompt = `Compare these products for a shopper in a concise, helpful way. Mention strengths, ideal use cases, and a quick recommendation.\n\n${selected.map((item) => `- ${item.name} | $${item.price} | ${item.category} | ${item.description}`).join('\n')}`;

    const result = await ai.models.generateContent({
      model: CHAT_MODEL,
      contents: prompt,
      config: { maxOutputTokens: 220 },
    });

    res.json({ comparison: result.text });
  } catch (error) {
    console.error('Gemini compare error:', error);
    res.status(500).json({ error: 'Could not generate a product comparison.' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ NEXUS running at http://localhost:${PORT}`);
  });
}

module.exports = app;
}

module.exports = app;
});
