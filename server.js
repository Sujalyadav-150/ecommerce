// server.js
// Express backend for the NEXUS AI shopping site.

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

const CHAT_MODEL =
  process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

if (!process.env.GEMINI_API_KEY) {
  console.warn(
    '⚠️ Warning: GEMINI_API_KEY is not set. Add it to your environment variables.'
  );
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------
// Shared key-value store
// ---------------------------------------------------------------------

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

  if (value === undefined) {
    return res.status(404).json({ error: 'Not found' });
  }

  res.json({ value });
});

app.post('/api/store/:key', (req, res) => {
  if (!('value' in req.body)) {
    return res
      .status(400)
      .json({ error: 'Request body must include "value".' });
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
    counts[product.category] =
      (counts[product.category] || 0) + 1;
  });

  return Object.entries(counts)
    .map(([name, count]) => ({
      name,
      count,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getBrands(products) {
  const set = new Set(
    products
      .map((product) => product.brand)
      .filter(Boolean)
  );

  return [...set].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------

app.get('/api/products', (req, res) => {
  const store = readStore();
  const products = getProductsFromStore(store);

  res.json({
    products,
    categories: getCategories(products),
    brands: getBrands(products),
  });
});

app.get('/api/categories', (req, res) => {
  const store = readStore();
  const products = getProductsFromStore(store);

  res.json({
    categories: getCategories(products),
  });
});

app.get('/api/brands', (req, res) => {
  const store = readStore();
  const products = getProductsFromStore(store);

  res.json({
    brands: getBrands(products),
  });
});

app.get('/api/products/:id', (req, res) => {
  const store = readStore();
  const products = getProductsFromStore(store);

  const product = products.find(
    (item) => item.id === req.params.id
  );

  if (!product) {
    return res.status(404).json({
      error: 'Product not found',
    });
  }

  const related = products
    .filter(
      (item) =>
        item.category === product.category &&
        item.id !== product.id
    )
    .slice(0, 3);

  const bundleItem = related[0] || null;

  res.json({
    product,
    related,
    bundleItem,
  });
});

// ---------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------

app.post('/api/orders', (req, res) => {
  try {
    const {
      name,
      email,
      address,
      items,
      total,
    } = req.body;

    if (!items || typeof items !== 'object') {
      return res.status(400).json({
        error: 'items object is required.',
      });
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

    res.json({
      ok: true,
      order,
    });
  } catch (error) {
    console.error('Order save error:', error);

    res.status(500).json({
      error: 'Could not save order.',
    });
  }
});

app.get('/api/orders', (req, res) => {
  const store = readStore();

  res.json({
    orders: getOrdersFromStore(store),
  });
});

// ---------------------------------------------------------------------
// Chat assistant
// ---------------------------------------------------------------------

app.post('/api/chat', async (req, res) => {
  try {
    const messages = req.body.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: 'messages array is required.',
      });
    }

    const [systemMsg, ...turns] = messages;

    const systemInstruction =
      systemMsg && systemMsg.content
        ? systemMsg.content
        : undefined;

    if (turns.length === 0) {
      return res.status(400).json({
        error:
          'At least one conversation turn is required.',
      });
    }

    const contents = turns.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [
        {
          text: m.content,
        },
      ],
    }));

    const result = await ai.models.generateContent({
      model: CHAT_MODEL,
      contents,
      config: systemInstruction
        ? { systemInstruction }
        : undefined,
    });

    const text = result.text;

    res.json({
      content: [
        {
          type: 'text',
          text,
        },
      ],
    });
  } catch (error) {
    console.error('Gemini chat error:', error);

    res.status(500).json({
      error:
        'Something went wrong while talking to the AI.',
    });
  }
});

// ---------------------------------------------------------------------
// One-off AI completions
// ---------------------------------------------------------------------

app.post('/api/ai', async (req, res) => {
  try {
    const { prompt, maxTokens } = req.body;

    if (
      !prompt ||
      typeof prompt !== 'string' ||
      !prompt.trim()
    ) {
      return res.status(400).json({
        error: 'prompt is required.',
      });
    }

    const result = await ai.models.generateContent({
      model: CHAT_MODEL,
      contents: prompt,
      config: maxTokens
        ? { maxOutputTokens: maxTokens }
        : undefined,
    });

    const text = result.text;

    res.json({
      content: [
        {
          type: 'text',
          text,
        },
      ],
    });
  } catch (error) {
    console.error('Gemini AI error:', error);

    res.status(500).json({
      error:
        'Something went wrong while talking to the AI.',
    });
  }
});

// ---------------------------------------------------------------------
// Product comparison
// ---------------------------------------------------------------------

app.post('/api/ai/compare', async (req, res) => {
  try {
    const { productIds } = req.body;

    if (
      !Array.isArray(productIds) ||
      productIds.length < 2
    ) {
      return res.status(400).json({
        error:
          'At least two product IDs are required.',
      });
    }

    const store = readStore();
    const products = getProductsFromStore(store);

    const selected = products.filter((item) =>
      productIds.includes(item.id)
    );

    if (selected.length < 2) {
      return res.status(400).json({
        error:
          'Selected products were not found.',
      });
    }

    const prompt = `Compare these products for a shopper in a concise, helpful way. Mention strengths, ideal use cases, and a quick recommendation.

${selected
  .map(
    (item) =>
      `- ${item.name} | $${item.price} | ${item.category} | ${item.description}`
  )
  .join('\n')}`;

    const result = await ai.models.generateContent({
      model: CHAT_MODEL,
      contents: prompt,
      config: {
        maxOutputTokens: 220,
      },
    });

    res.json({
      comparison: result.text,
    });
  } catch (error) {
    console.error(
      'Gemini compare error:',
      error
    );

    res.status(500).json({
      error:
        'Could not generate a product comparison.',
    });
  }
});

// ---------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `✅ NEXUS running at http://localhost:${PORT}`
  );
});

module.exports = app;
