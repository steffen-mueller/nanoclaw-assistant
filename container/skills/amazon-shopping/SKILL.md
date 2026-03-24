---
name: amazon-shopping
description: Order groceries from Tegut via Amazon. Read the Alexa shopping list, match items from past purchases, check the calendar for a delivery slot, confirm with Steffen, and place the order.
allowed-tools: Bash(agent-browser:*), Read, Write
---

# Amazon Grocery Shopping

## Credentials & Session

Read credentials from `/workspace/group/amazon-credentials.json`:
```json
{ "email": "...", "password": "...", "totp_seed": "BASE32SEED" }
```

Session state is saved to `/workspace/group/amazon-session.json` after login. Always try to load it first to avoid unnecessary logins.

---

## Step 1 — Start Browser & Load Session

```bash
# Try loading saved session
agent-browser state load /workspace/group/amazon-session.json

# Navigate to account page to check if session is valid
agent-browser open https://www.amazon.de/gp/css/homepage.html
agent-browser get url
```

If the URL stays on the account page (not redirected to a login page), the session is valid — **skip to Step 3**.

If redirected to signin, proceed to Step 2.

---

## Step 2 — Login with TOTP

```bash
agent-browser open https://www.amazon.de/ap/signin
agent-browser snapshot -i
agent-browser fill @e1 "EMAIL_FROM_CREDENTIALS"
agent-browser find role button click --name "Weiter"
agent-browser wait --load networkidle
agent-browser snapshot -i
agent-browser fill @e1 "PASSWORD_FROM_CREDENTIALS"
agent-browser find role button click --name "Anmelden"
agent-browser wait --load networkidle
agent-browser snapshot -i
```

If a TOTP prompt appears, generate the code and enter it:

```bash
# Generate TOTP code using Web Crypto API
agent-browser eval "
(async () => {
  const seed = 'TOTP_SEED_FROM_CREDENTIALS';
  const base32 = seed.toUpperCase().replace(/=+$/, '');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = [];
  let bits = 0, value = 0;
  for (const char of base32) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 0xff); }
  }
  const key = await crypto.subtle.importKey(
    'raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setUint32(4, counter, false);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const offset = sig[19] & 0xf;
  const code = ((sig[offset] & 0x7f) << 24 | sig[offset+1] << 16 | sig[offset+2] << 8 | sig[offset+3]) % 1000000;
  return String(code).padStart(6, '0');
})()
"
```

The eval returns the 6-digit code. Fill it in:

```bash
agent-browser snapshot -i
agent-browser fill @e1 "CODE"
agent-browser find role button click --name "Anmelden"
agent-browser wait --load networkidle
```

Save the session after successful login:

```bash
agent-browser state save /workspace/group/amazon-session.json
```

---

## Step 3 — Read the Alexa Shopping List

```bash
agent-browser open https://www.amazon.de/alexaquantum/sp/alexaShoppingList
agent-browser wait --load networkidle
agent-browser snapshot
```

Extract all **unchecked** items from the list. These are the items to order.

---

## Step 4 — Match Items from Past Tegut Purchases

```bash
agent-browser open "https://www.amazon.de/afx/lists/pastpurchases/tegut?almBrandId=dGVndXQuLi4"
agent-browser wait --load networkidle
agent-browser snapshot
```

For each item on the shopping list, search the past purchases page:

```bash
# Use the search/filter if available, or scroll through the list
agent-browser find placeholder "Suche" fill "ITEM_NAME"
agent-browser wait --load networkidle
agent-browser snapshot -i
```

**Matching rules:**
- **Found in past purchases** → note the exact product name and price, add to cart (Step 5)
- **Not found in past purchases** → add to the "needs Steffen's input" list — do NOT search Tegut generally
- **Found but out of stock** → add to the OOS list — do NOT suggest alternatives

---

## Step 5 — Add Items to Cart

For each matched item, click the "In den Einkaufswagen" button from the past purchases page:

```bash
agent-browser click @e_ADD_TO_CART_REF
agent-browser wait --load networkidle
```

Alternatively, navigate directly to the Tegut storefront to add items:

```bash
agent-browser open "https://www.amazon.de/fmc/storefront?almBrandId=dGVndXQuLi4"
```

---

## Step 6 — Find Delivery Slot

Read the calendar to find a free window same-day after 18:00:

```bash
# Read calendar (already refreshed every 15min by the host)
# Parse /workspace/group/calendar-events.json
```

Logic:
1. Get today's date.
2. From `calendar-events.json`, find all events today where `status` is not `"free"` and not `"holiday"`.
3. Find a 2-hour gap between 18:00 and 22:00 with no events.
4. Navigate to checkout to see available Tegut delivery slots:
   ```bash
   agent-browser open https://www.amazon.de/gp/cart/view.html
   agent-browser find role button click --name "Zur Kasse"
   agent-browser wait --load networkidle
   agent-browser snapshot
   ```
5. Look for slots ≥18:00 today. If none available today → note "no same-day slot available".

---

## Step 7 — Confirmation Message to Steffen

**Do NOT place the order yet.** Send Steffen a summary and wait for approval:

```
🛒 Einkauf bei Tegut — Bestellübersicht

✅ Gefundene Artikel (aus früheren Bestellungen):
- Produkt A — 2,49 €
- Produkt B — 1,89 €
...

❓ Nicht in früheren Bestellungen gefunden (bitte entscheiden):
- Artikel X
- Artikel Y

❌ Nicht vorrätig:
- Artikel Z

🚚 Lieferfenster: Heute, 18:00–20:00 Uhr
💶 Geschätzter Gesamtbetrag: 38,50 €

Soll ich die Bestellung jetzt aufgeben? (Ja / Nein)
```

Wait for Steffen's response before proceeding.

---

## Step 8 — Complete Checkout (after approval)

After Steffen confirms:

```bash
# Navigate to checkout
agent-browser open https://www.amazon.de/gp/cart/view.html
agent-browser find role button click --name "Zur Kasse"
agent-browser wait --load networkidle

# Select the confirmed delivery slot
agent-browser snapshot -i
# Click the approved slot
agent-browser click @e_SLOT_REF
agent-browser wait --load networkidle

# Review order and place
agent-browser find role button click --name "Jetzt kaufen"
agent-browser wait --load networkidle
agent-browser snapshot
```

Confirm to Steffen that the order has been placed, including the order number if visible.

---

## First-Time Setup

On first use, create the 7 AM daily task so Kim checks the list automatically every morning:

Write an IPC file to `/workspace/ipc/tasks/shopping_schedule.json`:
```json
{
  "type": "schedule_task",
  "targetJid": "MAIN_GROUP_JID",
  "prompt": "Bitte überprüfe unsere Einkaufsliste bei Amazon Alexa und erstelle eine Tegut-Bestellung falls Artikel vorhanden sind. Folge dem Amazon-Shopping-Workflow in deiner Skill-Dokumentation.",
  "schedule_type": "cron",
  "schedule_value": "0 7 * * *",
  "context_mode": "group",
  "taskId": "grocery-check-daily"
}
```

Only do this once — check if the task already exists before creating it.

---

## Error Handling

- **Login loop / captcha**: Stop, notify Steffen via message that manual intervention is needed.
- **Session expired mid-flow**: Re-run Step 2, then continue.
- **Cart issues**: Take a screenshot and include it in the message to Steffen.
- **All items OOS or not found**: Notify Steffen, do not attempt checkout.
