# bridge2 — Pentagon Chain $PC top-up (frontend)

One-way deposit UI: users lock $PC on Ethereum and receive native $PC on Pentagon Chain.
Static site — HTML/JS + ethers (CDN, SRI-pinned). No build step, no secrets.

## Files
- `index.html` — the top-up page (terms gate, disclaimers, deposit + swap-and-bridge, capacity check)
- `app.js` — wallet connect, deposit, Uniswap v2 swap-and-bridge, capacity guard
- `config.js` — addresses & options (edit this to configure)

## Configure (`config.js`)
- `vaultAddress` — deployed PCDepositVault (Ethereum)
- `capacityUrl` — a backend endpoint returning `{"balanceWei":"<pool wei>"}` (pentagon.games has no CORS,
  so the browser can't read the pool directly). Empty ⇒ capacity check is dormant (fails open).
- `discordUrl`, `tokenomicsUrl` — support / disclaimers

## Deploy (static)
Any static host. **Do not** deploy an admin/owner tool here.
- **S3 + CloudFront:** upload the 3 files; ACM cert; Route 53 alias for the bridge domain.
- **nginx:** serve the folder on :443; point the bridge domain's A-record at the box.

## Notes
- One-way: deposited PC is locked permanently; in-ecosystem $PC has no cash value, is non-transferable,
  and is not exchangeable back — see the tokenomics.
- Security lives in the contracts + 2-of-2 signer, not the frontend. This UI only triggers user-signed deposits.
