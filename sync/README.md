# Sync server: setup checklist

The Worker in this folder runs `sync.freeaitokens.co`. It stores encrypted chats and keys for the desktop app, sells sync through Stripe, and emails keys on request. Design: `docs/superpowers/specs/2026-11-23-encrypted-sync-design.md`.

Steps marked **Owner** need your accounts, payment details or secrets. Only you can do them. Do them in Stripe **test mode** first.

## 1. Cloudflare (Owner)

- [x] Move the account to the **Workers Paid** plan ($5 a month). Sending email to any address needs it.
- [x] Onboard `freeaitokens.co` as an **Email Service sending domain**. Keys are sent from `sync@freeaitokens.co`.
- [x] Create the database and the bucket:

```bash
cd sync
npx wrangler d1 create freeaitokens-sync
npx wrangler r2 bucket create freeaitokens-sync
```

- [x] Paste the `database_id` that `d1 create` prints into `wrangler.jsonc`.

## 2. Stripe (Owner)

- [ ] Use an account eligible for **Managed Payments**. Stripe is then the seller and handles tax.
- [ ] Create two products, each with a digital-goods tax code:
  - **FreeAITokens Sync — yearly**: $10 a year, recurring.
  - **FreeAITokens Sync — lifetime**: $49, one time.
- [ ] Turn on the **customer portal**. It powers Settings › Sync › Manage plan in the app.
- [ ] Add the webhook endpoint `https://sync.freeaitokens.co/stripe/webhook` with these events:
  - `checkout.session.completed`
  - `invoice.paid`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `charge.refunded`
  - `charge.dispute.created`
  - `charge.dispute.closed`

## 3. Secrets (Owner)

Run each command from `sync/`. Wrangler asks for the value, so it never lands in your shell history.

| Secret | Value |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_…` first) |
| `STRIPE_WEBHOOK_SECRET` | The endpoint's signing secret (`whsec_…`) |
| `LICENSE_SECRET` | 32 random bytes, for example from `openssl rand -hex 32` |
| `EMAIL_SECRET` | Another 32 random bytes, different from the one above |

```bash
npx wrangler secret put STRIPE_SECRET_KEY
```

Repeat that command for each of the four names. The two price ids are plain settings in `wrangler.jsonc` (`vars`), not secrets.

**Never change `LICENSE_SECRET` or `EMAIL_SECRET` once anyone has bought sync.**
- Every sync key is made from `LICENSE_SECRET`. Changing it breaks "Send me my key" for every existing buyer.
- The stored email hashes are made with `EMAIL_SECRET`. Changing it makes them unfindable.

Keep both in your password manager.

## 4. Deploy and test-mode run

Do these after steps 1 to 3 are done in test mode.

- [ ] Create the tables and deploy. Expected: the Worker answers at `https://sync.freeaitokens.co`.

```bash
cd sync && npx wrangler d1 execute SYNC_DB --remote --file schema.sql && npx wrangler deploy
```

- [ ] **Buy both plans** with Stripe test cards, starting from Settings › Sync in a desktop build.
  - Expected: the app picks up the key by itself and asks for a passphrase.
  - Setup shows a recovery code.
- [ ] **Test a second computer.** Use a second machine, or run the app again with `FREEAITOKENS_HOME` set to an empty folder. Choose "I already have a key" and enter the key and passphrase.
  - Expected: the same chats and keys appear.
  - An edit on either side reaches the other in about a minute.
- [ ] **Refund the test lifetime purchase, then open a test dispute on another one.**
  - Expected: sync shows that it stopped because of a refund or dispute.
  - Local chats stay.
  - **If these events never reach the webhook under Managed Payments** (Stripe's docs don't confirm they do), stop. Report it with the event log from the Stripe dashboard. Refunds and disputes would then need another path.
- [ ] **Test "Send me my key"** at `https://freeaitokens.co/sync#key`.
  - With the test purchase email: expected exactly one email with the key.
  - With an unknown address: the page says the same thing, and no email is sent.

## 5. Go live (Owner)

- [x] Live mode: products, prices, webhook endpoint and portal created; live price ids are in `wrangler.jsonc`.
- [ ] Go live: `wrangler secret bulk` the live secrets, then `wrangler deploy` (in that order).
- [ ] Keep `LICENSE_SECRET` and `EMAIL_SECRET` unchanged, unless only test purchases exist so far.
- [ ] Have the lifetime wording reviewed in the site terms (section 8, "for as long as the sync service runs"). It appears in all ten languages.
- [ ] Decide what ends the lifetime **launch offer** (a date, a number of sales, or both). The site, terms and app only call it a "limited launch offer" for now; nothing stops lifetime sales yet, so ending it needs a code change.
- [ ] Release the desktop app with a `desktop-v*` tag.
  - **Early access for sync plans:** when you publish the draft release, tick **Set as a pre-release**. Apps with an active sync plan offer it from Settings › Check for updates; everyone else is offered it once you edit the release and tick **Set as the latest release**. The terms promise early access but no fixed delay.
  - Before publishing, check that the Mac zip's `app.asar` contains `syncsvc.js` and `chats.js`.
  - Check that `codesign --verify --deep` passes.
- [ ] Deploy the site, so that `/sync`, `/sync-thanks` and the updated privacy and terms pages go live.

## Running the tests

From the repository root, `npm test` covers the Worker, the client engine and the desktop service, with Stripe and Cloudflare faked. Nothing in it reaches the network.
