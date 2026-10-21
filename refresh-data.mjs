#!/usr/bin/env node
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ADDR = '476a5c9d3e514a81eb81bca423d31b13e10b72179fa7caed421e96a57fd982f6';
const GW = 'https://reset.openmayhem.ai';
const DIR = '/workspace/reset-dash-public';
const SIGNER_DIR = '/home/box/.reset-signer';
const CLAIMS_PATH = `${SIGNER_DIR}/claims.json`;
const NETWORK_PATH = `${SIGNER_DIR}/network-miners.json`;

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

const [account, state, mineBundle] = await Promise.all([
  fetch(`${GW}/v1/account/${ADDR}`).then(r => { if (!r.ok) throw new Error('account ' + r.status); return r.json(); }),
  fetch(`${GW}/v1/state`).then(r => { if (!r.ok) throw new Error('state ' + r.status); return r.json(); }),
  fetchAllMiners(),
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

const same = prevObj
  && JSON.stringify(prevObj.account) === JSON.stringify(account)
  && JSON.stringify(prevObj.state?.tip) === JSON.stringify(state?.tip)
  && prevObj.state?.counted === state?.counted
  && JSON.stringify(prevObj.claims?.rounds) === JSON.stringify(out.claims.rounds)
  && JSON.stringify(prevObj.round) === JSON.stringify(roundInfo)
  && JSON.stringify(networkSummary(prevObj.network)) === JSON.stringify(networkSummary(network));

writeFileSync(path, JSON.stringify(out));
if (same) {
  console.log('unchanged', out.updated_at, 'claims', out.claims.count,
    'network', network.total_active, 'new', network.new_today, 'rows', network.miners.length);
  process.exit(0);
}
execSync('git add data.json && git -c user.email=bot@local -c user.name=reset-dash commit -m "chore: refresh data.json" && git push origin main', { cwd: DIR, stdio: 'inherit' });
console.log('pushed', out.updated_at, 'bal', account.balance, 'dep', account.deposit,
  'round', account.mine?.r, 'claims', out.claims.count, claimAdded ? '+new' : '',
  'network', network.total_active, 'new', network.new_today, 'rows', network.miners.length);
