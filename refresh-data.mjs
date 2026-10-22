#!/usr/bin/env node
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ADDR = '476a5c9d3e514a81eb81bca423d31b13e10b72179fa7caed421e96a57fd982f6';
const GW = 'https://reset.openmayhem.ai';
const DIR = '/workspace/reset-dash-public';
const SIGNER_DIR = '/home/box/.reset-signer';
const CLAIMS_PATH = `${SIGNER_DIR}/claims.json`;
const NETWORK_PATH = `${SIGNER_DIR}/network-miners.json`;
const PRICE_HISTORY_PATH = `${SIGNER_DIR}/price-history.json`;
const MARKET_API = 'https://tractrader.com/trading-post/market-api.php';
const ATOM = 1e8;

function shanghaiDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function loadClaims() {
  try {
    const d = JSON.parse(readFileSync(CLAIMS_PATH, 'utf8'));
    if (d?.v === 1 && d.address === ADDR && Array.isArray(d.claims)) return d;
  } catch {}
  return { v: 1, address: ADDR, claims: [] };
}

function saveClaims(data) {
  mkdirSync(SIGNER_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CLAIMS_PATH, JSON.stringify(data) + '\n', { mode: 0o600 });
}

function observeClaim(store, result) {
  if (!result || result.r == null) return false;
  const r = Number(result.r);
  if (!Number.isFinite(r)) return false;
  if (store.claims.some(c => Number(c.r) === r)) return false;
  store.claims.push({
    r,
    amount: String(result.amount ?? '0'),
    fair: String(result.fair ?? result.amount ?? '0'),
    penalty: String(result.penalty ?? '0'),
    settled_at: new Date().toISOString(),
    source: 'last_result',
  });
  store.claims.sort((a, b) => Number(a.r) - Number(b.r));
  if (store.claims.length > 200) store.claims = store.claims.slice(-200);
  return true;
}

function loadNetwork() {
  try {
    const d = JSON.parse(readFileSync(NETWORK_PATH, 'utf8'));
    if (d?.v === 1 && d.addresses && typeof d.addresses === 'object') {
      if (!d.daily || typeof d.daily !== 'object') d.daily = {};
      return d;
    }
  } catch {}
  return { v: 1, updated_at: null, addresses: {}, daily: {} };
}

function saveNetwork(data) {
  mkdirSync(SIGNER_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(NETWORK_PATH, JSON.stringify(data) + '\n', { mode: 0o600 });
}


function loadPriceHistory() {
  try {
    const d = JSON.parse(readFileSync(PRICE_HISTORY_PATH, 'utf8'));
    if (d?.v === 1 && Array.isArray(d.points)) return d;
  } catch {}
  return { v: 1, points: [] };
}

function savePriceHistory(data) {
  mkdirSync(SIGNER_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(PRICE_HISTORY_PATH, JSON.stringify(data) + '\n', { mode: 0o600 });
}

async function fetchMarketPrice() {
  const res = await fetch(MARKET_API, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('market-api ' + res.status);
  const d = await res.json();
  if (!d?.ok || !d.pair) throw new Error('market-api bad payload');
  const last = Number(d.pair.last);
  const bestSell = d.pair.bestSell != null ? Number(d.pair.bestSell) : null;
  const bestBuy = d.pair.bestBuy != null ? Number(d.pair.bestBuy) : null;
  let usdc = Number.isFinite(last) ? last : NaN;
  // Prefer mid of best book when last is missing
  if (!Number.isFinite(usdc) && Number.isFinite(bestSell) && Number.isFinite(bestBuy)) {
    usdc = (bestSell + bestBuy) / 2;
  }
  let change_24h = d.pair.change24h != null ? Number(d.pair.change24h) : null;
  const trades = Array.isArray(d.trades) ? d.trades : [];
  const nowSec = Math.floor(Date.now() / 1000);
  if ((change_24h == null || !Number.isFinite(change_24h)) && trades.length && Number.isFinite(usdc)) {
    const cutoff = nowSec - 86400;
    // trades may be oldest-first or newest-first; find closest to 24h ago
    let best = null, bestDist = Infinity;
    for (const tr of trades) {
      const t = Number(tr.t);
      const pr = Number(tr.p);
      if (!Number.isFinite(t) || !Number.isFinite(pr) || pr <= 0) continue;
      const dist = Math.abs(t - cutoff);
      if (dist < bestDist) { bestDist = dist; best = pr; }
    }
    if (best != null && best > 0) change_24h = ((usdc - best) / best) * 100;
  }
  return {
    usdc: Number.isFinite(usdc) ? usdc : null,
    change_24h: Number.isFinite(change_24h) ? change_24h : null,
    best_buy: Number.isFinite(bestBuy) ? bestBuy : null,
    best_sell: Number.isFinite(bestSell) ? bestSell : null,
    volume_24h: d.pair.volume24h != null ? Number(d.pair.volume24h) : null,
    trades_24h: d.pair.trades24h != null ? Number(d.pair.trades24h) : null,
    source: 'tractrader-market-api',
    updated_at: new Date().toISOString(),
    trades_sample: trades.slice(-48).map(tr => ({ t: Number(tr.t), p: Number(tr.p) })).filter(x => Number.isFinite(x.t) && Number.isFinite(x.p)),
  };
}

function appendPricePoint(store, usdc) {
  if (!Number.isFinite(usdc)) return store;
  const now = Date.now();
  const points = store.points || [];
  const last = points[points.length - 1];
  // Dedup if same price within 2 minutes
  if (last && Math.abs(now - last.t) < 120000 && last.p === usdc) return store;
  points.push({ t: now, p: usdc });
  const cutoff = now - 30 * 86400000;
  store.points = points.filter(pt => pt.t >= cutoff);
  store.updated_at = new Date().toISOString();
  return store;
}

/** Estimate personal daily mining from recent settled claims. */
function estimateDailyMining(claims, roundInfo, networkLast) {
  const list = Array.isArray(claims) ? claims.filter(c => c && c.r != null) : [];
  const recent = list.slice(-20);
  let avgAtomic = 0;
  if (recent.length) {
    avgAtomic = recent.reduce((s, c) => s + Number(c.amount || 0), 0) / recent.length;
  }
  // Round duration: prefer consecutive settled_at gaps; else BTC block span of current round; else ~56m from logs.
  let roundSec = null;
  const withTs = list.filter(c => c.settled_at).sort((a, b) => Number(a.r) - Number(b.r));
  const gaps = [];
  for (let i = 1; i < withTs.length; i++) {
    const r0 = Number(withTs[i - 1].r), r1 = Number(withTs[i].r);
    if (r1 !== r0 + 1) continue;
    const t0 = Date.parse(withTs[i - 1].settled_at);
    const t1 = Date.parse(withTs[i].settled_at);
    if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) gaps.push((t1 - t0) / 1000);
  }
  if (gaps.length >= 3) {
    gaps.sort((a, b) => a - b);
    roundSec = gaps[Math.floor(gaps.length / 2)]; // median
  }
  if (!roundSec && roundInfo?.start != null && roundInfo?.end != null) {
    const blocks = Number(roundInfo.end) - Number(roundInfo.start);
    if (blocks > 0) roundSec = blocks * 600; // ~10 min/block
  }
  if (!roundSec) roundSec = 56 * 60; // verified from fair-mine log consecutive rounds ~56 min
  const roundsPerDay = 86400 / roundSec;
  const est_daily_reset = (avgAtomic / ATOM) * roundsPerDay;
  // Network "每天产出" on public dashboards shows round capacity (atomic→human), not capacity×rounds.
  let network_daily_output = null;
  const cap = networkLast?.capacity;
  if (cap != null) network_daily_output = Number(cap) / ATOM;
  let network_paid_last = null;
  if (networkLast?.paid != null) network_paid_last = Number(networkLast.paid) / ATOM;
  return {
    est_daily_reset,
    avg_per_round_reset: avgAtomic / ATOM,
    rounds_per_day: roundsPerDay,
    round_sec: roundSec,
    sample_claims: recent.length,
    method: gaps.length >= 3
      ? 'median_settled_at_gap_x_avg_claim'
      : (roundInfo?.start != null ? 'round_block_span_x_avg_claim' : 'log_avg_56m_x_avg_claim'),
    network_daily_output,
    network_paid_last,
  };
}

async function fetchAllMiners() {
  const miners = [];
  let url = `${GW}/v1/mine/view`;
  let page = null;
  let etag = null;
  while (url) {
    const headers = {};
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetch(url, { headers });
    if (res.status === 304 && page) break;
    if (!res.ok) throw new Error('mine/view ' + res.status);
    const nextEtag = res.headers.get('etag');
    if (nextEtag) etag = nextEtag;
    page = await res.json();
    const rows = page.miners || [];
    for (const row of rows) miners.push(row);
    const next = page.next;
    url = next ? `${GW}/v1/mine/view?after=${encodeURIComponent(next)}` : null;
  }
  return { page, miners };
}

function refreshNetworkLedger(store, miners, gatewayTotal) {
  const today = shanghaiDay();
  const addrs = store.addresses || (store.addresses = {});
  const seenNow = new Set();

  for (const row of miners) {
    const a = row?.[0];
    if (!a || typeof a !== 'string') continue;
    seenNow.add(a);
    const deposit = Number(row[1] || 0);
    const leaving = Number(row[2] || 0);
    const strikes = Number(row[3] || 0);
    const clean = Number(row[4] || 0);
    const claimed = Number(row[5] || 0);
    const last_round = Number(row[6] || 0);
    const last_amount = Number(row[7] || 0);
    const last_penalty = Number(row[8] || 0);

    let entry = addrs[a];
    if (!entry) {
      entry = {
        first_seen: today,
        mined_total: String(last_amount || 0),
        seen_round: last_round || 0,
        deposit,
        leaving,
        strikes,
        clean,
        claimed,
        last_round,
        last_amount,
        last_penalty,
        last_seen: today,
      };
      addrs[a] = entry;
    } else {
      entry.deposit = deposit;
      entry.leaving = leaving;
      entry.strikes = strikes;
      entry.clean = clean;
      entry.claimed = claimed;
      entry.last_round = last_round;
      entry.last_amount = last_amount;
      entry.last_penalty = last_penalty;
      entry.last_seen = today;
      if (last_round > (entry.seen_round || 0) && last_round > 0) {
        const prev = BigInt(entry.mined_total || '0');
        entry.mined_total = (prev + BigInt(last_amount || 0)).toString();
        entry.seen_round = last_round;
      }
    }
  }

  if (!store.daily) store.daily = {};
  const newCount = Object.values(addrs).filter(e => e.first_seen === today).length;
  store.daily[today] = {
    new: newCount,
    total_active: gatewayTotal,
  };

  // Keep at most ~60 days in daily
  const days = Object.keys(store.daily).sort();
  while (days.length > 60) {
    delete store.daily[days.shift()];
  }

  store.updated_at = new Date().toISOString();
  return { today, newCount, seenNow };
}

function buildNetworkOut(store, miners, mineView, today, newCount) {
  const addrs = store.addresses || {};
  const gatewayTotal = Number(mineView?.total ?? miners.length);
  let sum_deposit = 0n;
  let sum_leaving = 0n;
  let sum_mined_tracked = 0n;

  const rows = [];
  for (const row of miners) {
    const a = row?.[0];
    if (!a) continue;
    const dep = Number(row[1] || 0);
    const leave = Number(row[2] || 0);
    const strikes = Number(row[3] || 0);
    const clean = Number(row[4] || 0);
    const claimed = Number(row[5] || 0);
    const last_r = Number(row[6] || 0);
    const last_amt = Number(row[7] || 0);
    const hold = dep + leave;
    const entry = addrs[a] || {};
    const mined = String(entry.mined_total || '0');
    sum_deposit += BigInt(dep);
    sum_leaving += BigInt(leave);
    sum_mined_tracked += BigInt(mined || '0');
    rows.push({
      a,
      dep,
      leave,
      hold,
      mined,
      last_r,
      last_amt,
      strikes,
      clean,
      claimed,
      first_seen: entry.first_seen || today,
      is_me: a === ADDR,
    });
  }

  rows.sort((x, y) => {
    if (y.hold !== x.hold) return y.hold - x.hold;
    const ym = BigInt(y.mined || '0');
    const xm = BigInt(x.mined || '0');
    if (ym > xm) return 1;
    if (ym < xm) return -1;
    return x.a < y.a ? -1 : x.a > y.a ? 1 : 0;
  });

  const last = mineView?.last || null;
  return {
    total_active: gatewayTotal,
    new_today: newCount,
    day: today,
    sum_deposit: sum_deposit.toString(),
    sum_leaving: sum_leaving.toString(),
    sum_holdings: (sum_deposit + sum_leaving).toString(),
    sum_mined_tracked: sum_mined_tracked.toString(),
    last_round_network: last,
    round: mineView?.round || null,
    miners: rows,
  };
}

const [account, state, mineBundle, market] = await Promise.all([
  fetch(`${GW}/v1/account/${ADDR}`).then(r => { if (!r.ok) throw new Error('account ' + r.status); return r.json(); }),
  fetch(`${GW}/v1/state`).then(r => { if (!r.ok) throw new Error('state ' + r.status); return r.json(); }),
  fetchAllMiners(),
  fetchMarketPrice().catch(err => ({ usdc: null, change_24h: null, error: String(err.message || err), updated_at: new Date().toISOString(), source: 'tractrader-market-api' })),
]);

const mineView = mineBundle.page;
const allMiners = mineBundle.miners;

const claimsStore = loadClaims();
const claimAdded = observeClaim(claimsStore, account?.mine?.last_result);
saveClaims(claimsStore);

const totalMine = claimsStore.claims.reduce((s, c) => s + BigInt(c.amount || '0'), 0n);
const totalPenalty = claimsStore.claims.reduce((s, c) => s + BigInt(c.penalty || '0'), 0n);

const roundInfo = mineView?.round || null;
const minerRow = allMiners.find(m => m?.[0] === ADDR) || null;

const networkStore = loadNetwork();
const { today, newCount } = refreshNetworkLedger(
  networkStore,
  allMiners,
  Number(mineView?.total ?? allMiners.length),
);
saveNetwork(networkStore);

const network = buildNetworkOut(networkStore, allMiners, mineView, today, newCount);

const priceStore = loadPriceHistory();
if (market?.usdc != null) appendPricePoint(priceStore, market.usdc);
// Also fold recent trade samples into history (dedupe by minute bucket)
if (Array.isArray(market?.trades_sample)) {
  for (const tr of market.trades_sample) {
    const tMs = tr.t * 1000;
    const exists = priceStore.points.some(pt => Math.abs(pt.t - tMs) < 60000 && pt.p === tr.p);
    if (!exists && Number.isFinite(tr.p)) priceStore.points.push({ t: tMs, p: tr.p });
  }
  priceStore.points.sort((a, b) => a.t - b.t);
  const cutoff = Date.now() - 30 * 86400000;
  priceStore.points = priceStore.points.filter(pt => pt.t >= cutoff);
}
savePriceHistory(priceStore);

const est = estimateDailyMining(claimsStore.claims, roundInfo, network.last_round_network);
const est_daily_usdc = (market?.usdc != null && Number.isFinite(est.est_daily_reset))
  ? est.est_daily_reset * market.usdc
  : null;

const activeAddrs = Number(network.total_active || 0);
const minersArr = Array.isArray(network.miners) ? network.miners : [];
const lockedAddrs = minersArr.filter(m => Number(m.dep || 0) > 0).length;
const leavingApprox = minersArr.filter(m => Number(m.leave || 0) > 0).length;

const out = {
  updated_at: new Date().toISOString(),
  address: ADDR,
  account,
  state,
  round: roundInfo,
  miner: minerRow,
  claims: {
    total_mine: totalMine.toString(),
    total_penalty: totalPenalty.toString(),
    count: claimsStore.claims.length,
    rounds: [...claimsStore.claims].reverse(),
  },
  network,
  price: {
    usdc: market?.usdc ?? null,
    change_24h: market?.change_24h ?? null,
    best_buy: market?.best_buy ?? null,
    best_sell: market?.best_sell ?? null,
    volume_24h: market?.volume_24h ?? null,
    trades_24h: market?.trades_24h ?? null,
    updated_at: market?.updated_at ?? null,
    source: market?.source ?? null,
    error: market?.error ?? null,
  },
  price_history: priceStore.points.map(pt => ({ t: pt.t, p: pt.p })),
  est_daily_reset: est.est_daily_reset,
  est_daily_usdc,
  est_meta: est,
  overview: {
    active_addresses: activeAddrs,
    total_addresses: activeAddrs, // gateway view is active miners
    locked_reset: Number(network.sum_deposit || 0) / ATOM,
    leaving_reset: Number(network.sum_leaving || 0) / ATOM,
    locked_addresses: lockedAddrs,
    leaving_addresses: leavingApprox,
    network_daily_output: est.network_daily_output,
  },
};

const path = `${DIR}/data.json`;
let prev = '';
try { prev = readFileSync(path, 'utf8'); } catch {}
const prevObj = prev ? JSON.parse(prev) : null;

function networkSummary(n) {
  if (!n) return null;
  return {
    total_active: n.total_active,
    new_today: n.new_today,
    day: n.day,
    sum_deposit: n.sum_deposit,
    sum_leaving: n.sum_leaving,
    sum_holdings: n.sum_holdings,
    sum_mined_tracked: n.sum_mined_tracked,
    last_paid: n.last_round_network?.paid ?? null,
    round_r: n.round?.r ?? null,
    miner_count: Array.isArray(n.miners) ? n.miners.length : 0,
  };
}

function priceSummary(pr) {
  if (!pr) return null;
  return { usdc: pr.usdc, change_24h: pr.change_24h, updated_at: pr.updated_at };
}

const same = prevObj
  && JSON.stringify(prevObj.account) === JSON.stringify(account)
  && JSON.stringify(prevObj.state?.tip) === JSON.stringify(state?.tip)
  && prevObj.state?.counted === state?.counted
  && JSON.stringify(prevObj.claims?.rounds) === JSON.stringify(out.claims.rounds)
  && JSON.stringify(prevObj.round) === JSON.stringify(roundInfo)
  && JSON.stringify(networkSummary(prevObj.network)) === JSON.stringify(networkSummary(network))
  && JSON.stringify(priceSummary(prevObj.price)) === JSON.stringify(priceSummary(out.price))
  && Number(prevObj.est_daily_reset || 0).toFixed(8) === Number(out.est_daily_reset || 0).toFixed(8);

writeFileSync(path, JSON.stringify(out));
if (same) {
  console.log('unchanged', out.updated_at, 'claims', out.claims.count,
    'network', network.total_active, 'new', network.new_today, 'rows', network.miners.length,
  'price', out.price?.usdc, 'est_daily', out.est_daily_reset);
  process.exit(0);
}
execSync('git add data.json && git -c user.email=bot@local -c user.name=reset-dash commit -m "chore: refresh data.json" && git push origin main', { cwd: DIR, stdio: 'inherit' });
console.log('pushed', out.updated_at, 'bal', account.balance, 'dep', account.deposit,
  'round', account.mine?.r, 'claims', out.claims.count, claimAdded ? '+new' : '',
  'network', network.total_active, 'new', network.new_today, 'rows', network.miners.length,
  'price', out.price?.usdc, 'est_daily', out.est_daily_reset);
