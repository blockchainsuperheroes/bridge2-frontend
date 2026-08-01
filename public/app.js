/* Pentagon Chain $PC top-up — one-way bridge with optional swap-and-bridge (Uniswap v2). */
const CFG = window.BRIDGE2_CONFIG;
const AGREED_KEY = 'pc_topup_agreed_v1';
const HISTORY_KEY = 'pc_topup_history_v1';

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address,uint256) returns (bool)',
];
const VAULT = [
  'function deposit(uint256 amount, address recipient) returns (uint256)',
  'event Deposited(uint256 indexed depositId, address indexed from, address indexed recipient, uint256 amount, uint256 srcChainId, address vault)',
];
const ROUTER = [
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
];

const $ = (id) => document.getElementById(id);
const status = (m, k = '') => { const e = $('status'); e.textContent = m; e.className = k; };

let provider, signer, account, payWith = 'PC';
let pc, vault, router, quotedOut = 0n;
let poolBal = 0n, poolKnown = false;
const fmtPC = (v) => (+ethers.formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 });

const TOK = () => ({
  PC:   { addr: CFG.pcTokenAddress, dp: 18, label: '$PC',  native: false },
  ETH:  { addr: null,               dp: 18, label: 'ETH',  native: true  },
  USDC: { addr: CFG.usdc,           dp: 6,  label: 'USDC', native: false },
}[payWith]);

/* ---------------- terms gate ---------------- */
function checkTosScroll() {
  const box = $('tosbox'); if (!box) return;
  const canScroll = box.scrollHeight > box.clientHeight + 8;
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
  if (atEnd || !canScroll) {
    $('agree').disabled = false;
    const h = $('scrollhint');
    if (h) { h.textContent = '✓ Thanks for reading — you can continue.'; h.classList.add('done'); }
  }
}
function showGate(force) {
  if (!force && localStorage.getItem(AGREED_KEY) === '1') { enterApp(); return; }
  $('gate').style.display = 'flex'; $('app').style.display = 'none';
  const box = $('tosbox'); if (box) box.scrollTop = 0;
  $('agree').disabled = true;
  const h = $('scrollhint'); if (h) { h.textContent = '▼ Scroll through the terms above to enable the button.'; h.classList.remove('done'); }
  setTimeout(checkTosScroll, 60); // in case the content is short enough not to scroll
}
function enterApp() { $('gate').style.display = 'none'; $('app').style.display = 'block'; }
function agree() {
  if ($('agree').disabled) return;
  if ($('dontshow').checked) localStorage.setItem(AGREED_KEY, '1');
  else localStorage.removeItem(AGREED_KEY);
  enterApp();
}

/* ---------------- history (browser-local only) ---------------- */
function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }
function saveHistoryEntry(entry) {
  try { const a = loadHistory(); a.unshift(entry); if (a.length > 100) a.length = 100; localStorage.setItem(HISTORY_KEY, JSON.stringify(a)); } catch {}
}
function renderHistory() {
  const el = $('historyList'); if (!el) return;
  const a = loadHistory();
  if (!a.length) { el.innerHTML = '<div class="hempty">No top-ups recorded on this device yet.</div>'; return; }
  el.innerHTML = a.map(e => {
    const pc = (+e.pc).toLocaleString(undefined, { maximumFractionDigits: 4 });
    const amt = (+e.amountIn).toLocaleString(undefined, { maximumFractionDigits: 6 });
    let when = e.t; try { when = new Date(e.t).toLocaleString(); } catch {}
    const idTxt = (e.depositId != null && e.depositId !== '') ? `deposit #${e.depositId}` : '';
    const txLink = e.tx ? `<a target="_blank" rel="noopener" href="${CFG.explorerBase}/tx/${e.tx}">ETH tx</a>` : '';
    const credLink = e.recipient ? `<a target="_blank" rel="noopener" href="${CFG.pcExplorerBase}/address/${e.recipient}">credited →</a>` : '';
    const sep = txLink && credLink ? ' · ' : '';
    return `<div class="hitem"><div class="r1"><b>${pc} $PC</b><span class="id">${idTxt}</span></div>`
      + `<div class="r2">Paid ${amt} ${esc(e.payWith)} · ${esc(when)}</div>`
      + `<div class="r2">To ${e.recipient ? shortA(e.recipient) : '—'} · ${txLink}${sep}${credLink}</div></div>`;
  }).join('');
}
function showTab(which) {
  const hist = which === 'history';
  $('tabTopup').classList.toggle('sel', !hist);
  $('tabHistory').classList.toggle('sel', hist);
  $('historyPanel').style.display = hist ? 'block' : 'none';
  $('connect').style.display = hist ? 'none' : '';
  $('form').style.display = (!hist && account) ? 'block' : 'none';
  if (hist) renderHistory();
}
function clearHistory() {
  if (!confirm('Clear your top-up history on this device? This cannot be undone. Your on-chain transactions are not affected.')) return;
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
}

/* ---------------- wallet ---------------- */
async function connect() {
  if (!window.ethereum) return status('No wallet found. Install MetaMask.', 'err');
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  const net = await provider.getNetwork();
  if ('0x' + net.chainId.toString(16) !== CFG.ethChainIdHex) {
    try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CFG.ethChainIdHex }] }); provider = new ethers.BrowserProvider(window.ethereum); }
    catch { return status(`Switch your wallet to ${CFG.ethChainName}.`, 'err'); }
  }
  signer = await provider.getSigner();
  account = await signer.getAddress();
  pc = new ethers.Contract(CFG.pcTokenAddress, ERC20, signer);
  vault = new ethers.Contract(CFG.vaultAddress, VAULT, signer);
  router = new ethers.Contract(CFG.uniV2Router, ROUTER, signer);
  $('connect').textContent = account.slice(0, 6) + '…' + account.slice(-4);
  $('form').style.display = 'block';
  if (!$('recipient').value) $('recipient').value = account;
  await refreshBalance();
  await refreshPool();
  if (!window._poolTimer) window._poolTimer = setInterval(refreshPool, 30000);
}

async function tokenBalance() {
  const t = TOK();
  if (t.native) return provider.getBalance(account);
  const c = new ethers.Contract(t.addr, ERC20, provider);
  return c.balanceOf(account);
}
async function refreshBalance() {
  if (!account) return;
  const t = TOK();
  const b = await tokenBalance();
  $('balance').textContent = `${(+ethers.formatUnits(b, t.dp)).toLocaleString(undefined,{maximumFractionDigits:6})} ${t.label}`;
}

/* ---------------- bridge capacity (via PG-be proxy; pentagon.games has no CORS) ---------------- */
async function refreshPool() {
  if (!CFG.capacityUrl) { poolKnown = false; $('capacity').textContent = ''; checkCapacity(); return; }
  try {
    const r = await fetch(CFG.capacityUrl, { cache: 'no-store' });
    const j = await r.json();
    poolBal = BigInt(j.balanceWei ?? j.wei ?? '0');
    poolKnown = true;
    $('capacity').textContent = 'Bridge capacity: ' + fmtPC(poolBal) + ' PC available';
  } catch {
    poolKnown = false;
    $('capacity').textContent = 'Bridge capacity: unavailable';
  }
  checkCapacity();
}
function pcOutNow() {
  if (payWith === 'PC') {
    const a = $('amount').value.trim();
    try { return (a && Number(a) > 0) ? ethers.parseUnits(a, 18) : 0n; } catch { return 0n; }
  }
  return quotedOut;
}
function checkCapacity() {
  const warn = $('capWarn');
  if (!poolKnown) { warn.style.display = 'none'; $('submit').disabled = false; return true; } // fail open
  const need = pcOutNow();
  if (need > 0n && need > poolBal) {
    warn.style.display = 'block';
    warn.innerHTML = `Not enough bridge capacity right now — only <b>${fmtPC(poolBal)} PC</b> is available to receive. Please top up a smaller amount. Need more? Contact support at <a href="${CFG.discordUrl}" target="_blank" rel="noopener">${CFG.discordUrl.replace('https://','')}</a>.`;
    $('submit').disabled = true;
    return false;
  }
  warn.style.display = 'none';
  $('submit').disabled = false;
  return true;
}

/* ---------------- quote (Uniswap v2) ---------------- */
function pathFor() {
  if (payWith === 'ETH')  return [CFG.weth, CFG.pcTokenAddress];
  if (payWith === 'USDC') return [CFG.usdc, CFG.pcTokenAddress];
  return null;
}
async function refreshQuote() {
  quotedOut = 0n;
  const q = $('quote'), t = TOK();
  const amt = $('amount').value.trim();
  if (payWith === 'PC' || !amt || Number(amt) <= 0 || !router) { q.style.display = 'none'; return; }
  try {
    const amountIn = ethers.parseUnits(amt, t.dp);
    const amounts = await router.getAmountsOut(amountIn, pathFor());
    quotedOut = amounts[amounts.length - 1];
    const pcOut = +ethers.formatUnits(quotedOut, 18);
    const minOut = +ethers.formatUnits(quotedOut * BigInt(10000 - CFG.slippageBps) / 10000n, 18);
    q.style.display = 'block';
    q.innerHTML = `You receive ≈ <b>${pcOut.toLocaleString(undefined,{maximumFractionDigits:4})} $PC</b> <span style="color:#7fae95">(min ${minOut.toLocaleString(undefined,{maximumFractionDigits:4})} after ${CFG.slippageBps/100}% slippage, via Uniswap)</span>`;
  } catch { q.style.display = 'block'; q.innerHTML = '<span style="color:#e0a26a">No route / pool too thin for this size.</span>'; }
}

/* ---------------- guided, on-chain-verified stepper ----------------
   Each step is a single manual button. After the tx confirms we POLL a fresh
   on-chain read (allowance / balance) before revealing the next button — so a
   later step can never run against stale state (this is what prevents the
   USDC "TRANSFER_FROM_FAILED" race: Swap can't be clicked until the router's
   allowance actually reads >= amount on-chain). ---------------------------- */
let flow = { steps: [], i: 0, ctx: {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const shortA = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const spin = (t) => `<span class="spin"></span>${t}`;
const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function resetFlow() {
  clearInterval(window._track); window._track = null;
  flow = { steps: [], i: 0, ctx: {} };
  $('steps').style.display = 'none';
  $('stepsHdr').innerHTML = ''; $('stepList').innerHTML = ''; $('stepAct').innerHTML = '';
  $('result').innerHTML = '';
  $('submit').style.display = ''; $('submit').disabled = false;
  status('');
}

/* Build the exact list of steps for the chosen path. */
async function buildPlan() {
  const t = TOK();
  const amountIn = ethers.parseUnits($('amount').value.trim(), t.dp);
  const recipient = $('recipient').value.trim();
  const ctx = { amountIn, recipient, pcToDeposit: payWith === 'PC' ? amountIn : 0n };
  const pcRead = new ethers.Contract(CFG.pcTokenAddress, ERC20, provider);
  const steps = [];

  if (payWith === 'USDC') {
    const usdcRead = new ethers.Contract(CFG.usdc, ERC20, provider);
    steps.push({
      code: 'APPRV-USDC', label: 'Approve USDC for the swap',
      sub: 'One-time permission so Uniswap can move the USDC you\'re swapping.',
      act: 'Approve USDC',
      precheck: async () => (await usdcRead.allowance(account, CFG.uniV2Router)) >= amountIn,
      run: async () => new ethers.Contract(CFG.usdc, ERC20, signer).approve(CFG.uniV2Router, amountIn),
      verify: async () => (await usdcRead.allowance(account, CFG.uniV2Router)) >= amountIn,
    });
  }
  if (payWith === 'ETH' || payWith === 'USDC') {
    steps.push({
      code: 'SWAP', label: `Swap ${t.label} → $PC on Uniswap`,
      sub: `Converts your ${t.label} into $PC in your own wallet first.`,
      act: `Swap ${t.label} → $PC`,
      run: async () => {
        if (quotedOut === 0n) await refreshQuote();
        if (quotedOut === 0n) throw new Error('No swap route available right now.');
        const minOut = quotedOut * BigInt(10000 - CFG.slippageBps) / 10000n;
        const deadline = Math.floor(Date.now() / 1000) + 1200;
        ctx.pcBefore = await pcRead.balanceOf(account);
        if (payWith === 'ETH') return router.swapExactETHForTokens(minOut, pathFor(), account, deadline, { value: amountIn });
        return router.swapExactTokensForTokens(amountIn, minOut, pathFor(), account, deadline);
      },
      verify: async () => {
        const after = await pcRead.balanceOf(account);
        if (after > (ctx.pcBefore ?? 0n)) { ctx.pcToDeposit = after - ctx.pcBefore; return true; }
        return false;
      },
    });
  }
  steps.push({
    code: 'APPRV-PC', label: 'Approve $PC for the bridge',
    sub: 'Lets the bridge lock exactly the $PC you\'re topping up.',
    act: 'Approve $PC',
    precheck: async () => ctx.pcToDeposit > 0n && (await pcRead.allowance(account, CFG.vaultAddress)) >= ctx.pcToDeposit,
    run: async () => new ethers.Contract(CFG.pcTokenAddress, ERC20, signer).approve(CFG.vaultAddress, ctx.pcToDeposit),
    verify: async () => (await pcRead.allowance(account, CFG.vaultAddress)) >= ctx.pcToDeposit,
  });
  steps.push({
    code: 'LOCK', label: 'Lock $PC into the bridge',
    sub: 'Final step — one-way lock; $PC is credited to your address on Pentagon Chain.',
    act: 'Lock $PC & finish',
    run: async () => { const dtx = await vault.deposit(ctx.pcToDeposit, recipient); ctx.depositTx = dtx.hash; return dtx; },
    verify: async (rc) => {
      if (!rc && ctx.depositTx) rc = await provider.getTransactionReceipt(ctx.depositTx);
      if (!rc || rc.status !== 1) return false;
      for (const lg of rc.logs) { try { const p = vault.interface.parseLog(lg); if (p?.name === 'Deposited') ctx.depositId = p.args.depositId.toString(); } catch {} }
      return true;
    },
  });
  return { steps, ctx };
}

async function startFlow(e) {
  e.preventDefault();
  try {
    if (CFG.vaultAddress.toLowerCase() === '0x0000000000000000000000000000000000000000') return status('Vault not configured.', 'err');
    if (!account) return status('Connect your wallet first.', 'err');
    const recipient = $('recipient').value.trim();
    if (!ethers.isAddress(recipient)) return status('Enter a valid Pentagon Chain address.', 'err');
    const amtStr = $('amount').value.trim();
    if (!amtStr || Number(amtStr) <= 0) return status('Enter an amount.', 'err');
    const t = TOK();
    const amountIn = ethers.parseUnits(amtStr, t.dp);
    const bal = await tokenBalance();
    if (amountIn > bal) return status(`Amount exceeds your ${t.label} balance.`, 'err');

    // capacity guard — never lock PC the pool can't pay out (only when capacity is known)
    await refreshPool();
    if (poolKnown) {
      let expectOut = amountIn;
      if (payWith !== 'PC') { if (quotedOut === 0n) await refreshQuote(); expectOut = quotedOut; }
      if (expectOut > 0n && expectOut > poolBal)
        return status(`Bridge capacity is only ${fmtPC(poolBal)} PC right now — top up less, or contact support: ${CFG.discordUrl}`, 'err');
    }
    if (payWith !== 'PC' && quotedOut === 0n) { await refreshQuote(); if (quotedOut === 0n) return status('No swap route available right now.', 'err'); }

    resetFlow();
    const { steps, ctx } = await buildPlan();
    flow = { steps, ctx, i: 0 };
    $('submit').style.display = 'none';
    $('steps').style.display = 'block';
    renderSteps();
    status('Follow the steps below — one wallet prompt at a time.', '');
    prepareStep(0);
  } catch (err) {
    console.error(err);
    status(err?.shortMessage || err?.reason || err?.message || 'Could not start.', 'err');
  }
}

function renderSteps() {
  const n = flow.steps.length;
  $('stepsHdr').innerHTML = `You'll sign up to <b>${n}</b> wallet prompt${n > 1 ? 's' : ''}, one at a time. Each is checked on-chain before the next appears — so nothing runs on stale data.`;
  $('stepList').innerHTML = flow.steps.map((s, i) => {
    const st = s.state || 'pending';
    const dot = st === 'done' ? '✓' : st === 'fail' ? '✗' : (i + 1);
    return `<div class="step ${st}"><span class="dot">${dot}</span><span>${esc(s.label)}${s.sub ? `<span class="sub">${esc(s.sub)}</span>` : ''}</span></div>`;
  }).join('');
}

async function prepareStep(i) {
  const s = flow.steps[i];
  if (s.precheck) { try { if (await s.precheck()) { s.state = 'done'; renderSteps(); flow.i = i + 1; return flow.i < flow.steps.length ? prepareStep(flow.i) : finalize(); } } catch {} }
  s.state = 'active'; renderSteps();
  const total = flow.steps.length;
  $('stepAct').innerHTML = '';
  const btn = document.createElement('button');
  btn.className = 'go'; btn.type = 'button';
  btn.textContent = `Step ${i + 1} of ${total} — ${s.act}`;
  btn.onclick = () => runStep(i);
  const hint = document.createElement('div');
  hint.className = 'hint'; hint.id = 'stepHint';
  hint.innerHTML = `Click to open your wallet and confirm <b>step ${i + 1}</b>. ${total - i - 1 > 0 ? `${total - i - 1} step${total - i - 1 > 1 ? 's' : ''} left after this.` : 'This is the last step.'}`;
  $('stepAct').append(btn, hint);
}
const setHint = (html) => { const h = $('stepHint'); if (h) h.innerHTML = html; };

async function runStep(i) {
  const s = flow.steps[i];
  const b = $('stepAct').querySelector('.go'); if (b) b.disabled = true;
  s.state = 'sent'; renderSteps(); setHint(spin('Confirm the transaction in your wallet…'));
  let tx;
  try { tx = await s.run(); }
  catch (err) { s.state = 'fail'; renderSteps(); stepFail(i, err, { retry: true }); return; }
  try {
    if (tx && tx.wait) { if (tx.hash) s.hash = tx.hash; setHint(spin('Submitted — waiting for network confirmation…')); s.receipt = await tx.wait(); }
  } catch (err) {
    // the tx may still have landed; offer the safe "Check again" as well as Retry
    s.state = 'fail'; renderSteps(); stepFail(i, err, { retry: true, recheck: true });
    return;
  }
  await verifyStep(i);
}

async function verifyStep(i) {
  const s = flow.steps[i];
  s.state = 'verifying'; renderSteps(); setHint(spin('Confirming on-chain…'));
  let ok = false;
  for (let k = 0; k < 20; k++) { try { if (await s.verify(s.receipt)) { ok = true; break; } } catch {} await sleep(1800); }
  if (!ok) { s.state = 'fail'; renderSteps(); stepFail(i, new Error('Transaction confirmed, but the on-chain state hasn\'t updated yet (network lag).'), { recheck: true }); return; }
  s.state = 'done'; renderSteps();
  flow.i = i + 1;
  if (flow.i < flow.steps.length) prepareStep(flow.i); else await finalize();
}

function errCode(err, i) {
  const s = (err?.shortMessage || err?.reason || err?.info?.error?.message || err?.message || '').toUpperCase();
  let r = 'FAIL';
  if (/ACTION_REJECTED|USER (DENIED|REJECTED)|4001/.test(s)) r = 'REJECTED';
  else if (/INSUFFICIENT_OUTPUT|SLIPPAGE/.test(s)) r = 'SLIPPAGE';
  else if (/TRANSFER_FROM_FAILED|ALLOWANCE|EXCEEDS ALLOWANCE/.test(s)) r = 'ALLOWANCE';
  else if (/INSUFFICIENT FUNDS|EXCEEDS BALANCE|GAS REQUIRED/.test(s)) r = 'FUNDS';
  else if (/DEADLINE|EXPIRED/.test(s)) r = 'DEADLINE';
  else if (/NONCE/.test(s)) r = 'NONCE';
  else if (/HASN'T UPDATED|LAG|NOT YET/.test(s)) r = 'PENDING';
  else if (/CALL_EXCEPTION|REVERT/.test(s)) r = 'REVERTED';
  return `${flow.steps[i]?.code || ('S' + (i + 1))}-${r}`;
}
function niceErr(err) {
  const s = err?.shortMessage || err?.reason || err?.info?.error?.message || err?.message || 'Transaction failed.';
  if (/ACTION_REJECTED|user rejected|4001/i.test(s)) return 'You dismissed the wallet prompt — no problem, just retry when ready.';
  if (/TRANSFER_FROM_FAILED/i.test(s)) return 'The approval wasn\'t live on-chain yet. The approve step is confirmed now — just retry this step.';
  if (/INSUFFICIENT_OUTPUT/i.test(s)) return 'The price moved past your slippage limit. Retry to get a fresh quote.';
  if (/insufficient funds/i.test(s)) return 'Not enough ETH to cover gas (or the amount). Top up ETH and retry.';
  if (/deadline|expired/i.test(s)) return 'The transaction took too long and expired. Retry.';
  return s;
}

function stepFail(i, err, opts) {
  const s = flow.steps[i];
  const code = errCode(err, i);
  $('stepAct').innerHTML = '';
  const total = flow.steps.length;
  if (opts.recheck) {
    const rc = document.createElement('button'); rc.className = 'go'; rc.type = 'button';
    rc.textContent = `Check step ${i + 1} again`; rc.onclick = () => verifyStep(i);
    $('stepAct').append(rc);
  }
  if (opts.retry) {
    const rb = document.createElement('button'); rb.className = 'go retry'; rb.type = 'button';
    rb.style.marginTop = opts.recheck ? '8px' : '';
    rb.textContent = `Retry step ${i + 1} — ${s.act}`; rb.onclick = () => runStep(i);
    $('stepAct').append(rb);
  }
  const hint = document.createElement('div'); hint.className = 'hint'; hint.id = 'stepHint';
  const both = opts.recheck && opts.retry
    ? ' If your wallet shows this transaction <b>succeeded</b>, use <b>Check again</b>. Only <b>Retry</b> if it failed or you\'re unsure it was sent.'
    : opts.recheck ? ' Your transaction may already be going through — use <b>Check again</b> in a moment.' : '';
  hint.innerHTML = `⚠️ ${esc(niceErr(err))}${both}<br><span style="color:#7f8fb0">Nothing was lost. Error code <code>${code}</code> — quote it in <a href="${CFG.discordUrl}" target="_blank" rel="noopener">support</a> if it keeps failing.</span>`;
  $('stepAct').append(hint);
  status(`Step ${i + 1} of ${total} needs attention (${code}).`, 'err');
}

async function finalize() {
  const ctx = flow.ctx;
  const pcAmt = fmtPC(ctx.pcToDeposit);
  const idTxt = ctx.depositId != null ? ` (deposit #${ctx.depositId})` : '';
  try {
    saveHistoryEntry({
      t: Date.now(),
      account: account || '',
      recipient: ctx.recipient,
      payWith,
      amountIn: ethers.formatUnits(ctx.amountIn, TOK().dp),
      pc: ethers.formatUnits(ctx.pcToDeposit, 18),
      depositId: ctx.depositId ?? null,
      tx: ctx.depositTx || '',
    });
    if ($('historyPanel').style.display === 'block') renderHistory();
  } catch {}
  $('stepAct').innerHTML = '';
  $('result').innerHTML =
    `<div class="tracker">`
    + `<div class="tline">✅ Locked <b>${pcAmt} $PC</b>${idTxt} for <code>${shortA(ctx.recipient)}</code>`
    + (ctx.depositTx ? ` · <a target="_blank" rel="noopener" href="${CFG.explorerBase}/tx/${ctx.depositTx}">Ethereum tx</a>` : '') + `</div>`
    + `<div class="tstep" id="tEth"><div class="tstep-h">① Confirming on ${CFG.ethChainName}</div>`
    + `<div class="tbar"><div class="tbar-f" id="tEthBar"></div></div>`
    + `<div class="tstep-s" id="tEthS">Waiting for the lock to be mined…</div></div>`
    + `<div class="tstep" id="tPc"><div class="tstep-h">② Releasing $PC on ${CFG.pcChainName}</div>`
    + `<div class="tstep-s" id="tPcS">Starts automatically once ${CFG.ethChainName} confirmations complete.</div></div>`
    + `</div>`;
  status('Locked in. Tracking the release below — safe to leave this open.', 'ok');
  $('submit').style.display = ''; $('submit').disabled = false;
  startTracker(ctx);
  await refreshBalance(); await refreshPool();
}

const fmtEta = (s) => { s = Math.max(0, Math.round(s)); return s < 60 ? `${s}s` : `${Math.ceil(s / 60)} min`; };

/* Live post-lock tracker: ETH confirmations (client-side) then PC credit
   (via CFG.statusUrl if configured; otherwise an explorer link, since the
   browser can't read Pentagon Chain directly — no CORS). */
function startTracker(ctx) {
  clearInterval(window._track);
  const target = CFG.minConfirmationsNote || 12;
  const srcChainId = parseInt(CFG.ethChainIdHex, 16) || 1;
  let ethDone = false, pcDone = false, pcAnnounced = false, ticks = 0;
  const stop = () => { clearInterval(window._track); window._track = null; };
  const tick = async () => {
    if (++ticks > 360) { // ~30 min safety stop
      if (!pcDone) { const s = $('tPcS'); if (s) s.innerHTML = `Still processing — track your address on the explorer: <a target="_blank" rel="noopener" href="${CFG.pcExplorerBase}/address/${ctx.recipient}">open →</a>.`; }
      stop(); return;
    }
    try {
      if (!ethDone) {
        const rc = ctx.depositTx ? await provider.getTransactionReceipt(ctx.depositTx) : null;
        if (rc && rc.blockNumber != null) {
          const head = await provider.getBlockNumber();
          const conf = Math.max(0, head - rc.blockNumber + 1);
          const bar = $('tEthBar'); if (bar) bar.style.width = Math.min(100, Math.round(conf / target * 100)) + '%';
          const s = $('tEthS');
          if (conf >= target) {
            ethDone = true;
            $('tEth')?.classList.add('done');
            if (s) s.innerHTML = `<span style="color:#58e08f">✓ Confirmed on ${CFG.ethChainName} (${conf} confirmations).</span>`;
          } else if (s) {
            s.textContent = `${conf} / ${target} confirmations · ~${fmtEta((target - conf) * 12)} remaining`;
          }
        } else { const s = $('tEthS'); if (s) s.textContent = 'Waiting for the lock transaction to be mined…'; }
      }
      if (ethDone && !pcDone) {
        if (CFG.statusUrl) {
          if (!pcAnnounced) { pcAnnounced = true; const s = $('tPcS'); if (s) s.innerHTML = `<span class="spin"></span>Confirmed — waiting for the bridge to release $PC…`; }
          const u = new URL(CFG.statusUrl, location.href);
          u.searchParams.set('depositId', ctx.depositId ?? '');
          u.searchParams.set('srcChainId', String(srcChainId));
          u.searchParams.set('srcVault', CFG.vaultAddress);
          const j = await (await fetch(u, { cache: 'no-store' })).json();
          if (j && j.credited) {
            pcDone = true; stop();
            $('tPc')?.classList.add('done');
            const link = j.claimTx
              ? ` <a target="_blank" rel="noopener" href="${CFG.pcExplorerBase}/tx/${j.claimTx}">payout tx</a>`
              : ` <a target="_blank" rel="noopener" href="${CFG.pcExplorerBase}/address/${ctx.recipient}">view on explorer</a>`;
            const amt = j.amount ? fmtPC(BigInt(j.amount)) : fmtPC(ctx.pcToDeposit);
            const s = $('tPcS'); if (s) s.innerHTML = `<span style="color:#58e08f">✅ Credited ${amt} $PC on ${CFG.pcChainName}.</span>${link}`;
            status('Credited on Pentagon Chain. 🎉', 'ok');
            await refreshBalance();
          }
        } else {
          pcDone = true; stop(); // no backend → can't poll PC from the browser
          const s = $('tPcS');
          if (s) s.innerHTML = `Confirmed on ${CFG.ethChainName}. The bridge releases your $PC on ${CFG.pcChainName} automatically (usually a minute or two). Your browser can't read ${CFG.pcChainName} directly, so <a target="_blank" rel="noopener" href="${CFG.pcExplorerBase}/address/${ctx.recipient}">track your address on the explorer →</a>.`;
        }
      }
    } catch { /* transient RPC error — keep polling */ }
  };
  tick();
  window._track = setInterval(tick, 5000);
}

/* ---------------- wiring ---------------- */
window.addEventListener('DOMContentLoaded', () => {
  $('tosbox')?.addEventListener('scroll', checkTosScroll);
  showGate(false);
  $('agree').addEventListener('click', agree);
  $('showterms').addEventListener('click', (e) => { e.preventDefault(); showGate(true); });
  $('showterms2').addEventListener('click', (e) => { e.preventDefault(); showGate(true); });

  $('tabTopup').addEventListener('click', () => showTab('topup'));
  $('tabHistory').addEventListener('click', () => showTab('history'));
  $('clearHistory').addEventListener('click', clearHistory);

  $('connect').addEventListener('click', connect);
  $('form').addEventListener('submit', startFlow);
  $('amount').addEventListener('input', () => { resetFlow(); clearTimeout(window._q); window._q = setTimeout(async () => { await refreshQuote(); checkCapacity(); }, 350); });

  $('paywith').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pay]'); if (!b) return;
    payWith = b.dataset.pay;
    [...$('paywith').children].forEach(x => x.classList.toggle('sel', x === b));
    $('payLabel').textContent = TOK().label;
    $('amount').value = ''; $('quote').style.display = 'none'; quotedOut = 0n;
    $('swapNote').style.display = payWith === 'PC' ? 'none' : 'block';
    $('submit').textContent = payWith === 'PC' ? 'Review & top up' : `Review swap & top-up (${TOK().label})`;
    resetFlow();
    if (account) refreshBalance();
    checkCapacity();
  });

  $('max').addEventListener('click', async () => {
    if (!account) return;
    const t = TOK();
    let b = await tokenBalance();
    if (t.native) b = b > ethers.parseEther('0.01') ? b - ethers.parseEther('0.01') : 0n; // leave gas
    $('amount').value = ethers.formatUnits(b, t.dp);
    await refreshQuote(); checkCapacity();
  });

  if (window.ethereum) {
    window.ethereum.on?.('accountsChanged', () => location.reload());
    window.ethereum.on?.('chainChanged', () => location.reload());
  }
});
