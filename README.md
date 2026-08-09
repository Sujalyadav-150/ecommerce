# NEXUS — AI-Integrated eCommerce Store

A single storefront that merges the **NEXUS** shopping site with the **Gemini chatbot** backend: one Express server, one AI provider, one shared product catalog, real chat + AI shopping features.

## What changed in this integration

The store (`public/index.html`) was originally built as a Claude.ai *artifact*, so two things in it only worked inside claude.ai and would have silently failed on a real server:

- `window.storage` (products/cart/orders) — an artifact-only API.
- Direct browser calls to `https://api.anthropic.com/v1/messages` (AI search, AI picks, review summaries, order-confirmation notes) — no API key attached in a real deployment, so these would 401.

Both are now replaced with real backend equivalents that reuse the existing Gemini chatbot project:

| Feature | Before | Now |
|---|---|---|
| Products & orders | `window.storage` (shared) | `GET/POST /api/store/:key` → `data/store.json` on the server |
| Cart | `window.storage` (personal) | `localStorage` in the visitor's own browser |
| Chat widget | `/api/chat` (already correct, just needed a real backend) | `/api/chat` — Gemini, multi-turn, shopping-context aware |
| AI search / AI picks / review summaries / order notes | raw `fetch` to Anthropic with no key | `/api/ai` — single-prompt Gemini completions |

The frontend's response parsing (`data.content.map(c => c.text)`) was kept as-is — the backend just returns Gemini's output in that same shape, so no other UI code had to change.

## Project Structure

```
nexus-ai-store/
├── server.js            # Express server: static hosting + /api/chat, /api/ai, /api/store
├── package.json
├── .env.example          # Template for your API key
├── data/
│   └── store.json        # Shared product/order data (created automatically)
└── public/
    └── index.html         # The full storefront: catalog, cart, checkout, admin, AI chat panel
```

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Add your API key**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and paste in your Gemini key (free at [Google AI Studio](https://aistudio.google.com/app/apikey)):

   ```
   GEMINI_API_KEY=your_gemini_api_key_here
   ```

3. **Run it**

   ```bash
   npm start
   ```

4. Open `http://localhost:3000`.

## What's genuinely working end-to-end

- Product catalog, category filters, quick view, cart, and checkout — all backed by real shared storage.
- Floating AI chat assistant (bottom-right) with full shopping context — it sees your live catalog and can recommend real products by name and price, and also answers general questions.
- AI natural-language search bar ("quiet earbuds under $200").
- AI-curated "picks for you" section, regenerated from your current cart.
- AI review summaries in the quick-view modal.
- AI-written order-confirmation message at checkout.
- Admin panel (⚙ admin button) for adding/removing products, visible to every visitor since it's server-backed.

## Known simplifications (call out for anyone extending this)

- **Auth**: there isn't any. "Shared" storage is one global store, not per-account — fine for a demo/portfolio piece, not for multiple real customers.
- **Payments**: checkout is simulated; wire in Stripe/Razorpay for real charges.
- **Persistence**: `data/store.json` is a flat file, not a database — swap for Postgres/Mongo/etc. before any real traffic.
- **Streaming**: the chat reply currently arrives all at once, not token-by-token. Gemini's SDK supports streaming (`generateContentStream`) if you want the typing effect — happy to wire that up if useful.
