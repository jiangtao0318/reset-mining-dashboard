#!/usr/bin/env node
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ADDR = '476a5c9d3e514a81eb81bca423d31b13e10b72179fa7caed421e96a57fd982f6';
const GW = 'https://reset.openmayhem.ai';
const DIR = '/workspace/reset-dash-public';
const CLAIMS_PATH = '/home/box/.reset-signer/claims.json';

function loadClaims() {
  try {
    const d = JSON.parse(readFileSync(CLAIMS_PATH, 'utf8'));
    if (d?.v === 1 && d.address === ADDR && Array.isArray(d.claims)) return d;
  } catch {}
  return { v: 1, address: ADDR, claims: [] };
}

function saveClaims(data) {
  mkdirSync('/home/box/.reset-signer', { recursive: true, mode: 0o700 });
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
  // keep last 200 rounds
  if (store.claims.length > 200) store.claims = store.claims.slice(-200);
  return true;
}

const [account, state, mineView] = await Promise.all([
  fetch(`${GW}/v1/account/${ADDR}`).then(r => { if (!r.ok) throw new Error('account ' + r.status); return r.json(); }),
  fetch(`${GW}/v1/state`).then(r => { if (!r.ok) throw new Error('state ' + r.status); return r.json(); }),
  fetch(`${GW}/v1/mine/view`).then(r => r.ok ? r.json() : null).catch(() => null),
]);

const claimsStore = loadClaims();
const claimAdded = observeClaim(claimsStore, account?.mine?.last_result);
if (claimAdded) saveClaims(claimsStore);
else saveClaims(claimsStore); // ensure file exists

const totalMine = claimsStore.claims.reduce((s, c) => s + BigInt(c.amount || '0'), 0n);
const totalPenalty = claimsStore.claims.reduce((s, c) => s + BigInt(c.penalty || '0'), 0n);

const roundInfo = mineView?.round || null;
const minerRow = (mineView?.miners || []).find(m => m?.[0] === ADDR) || null;

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
    // newest first for UI
    rounds: [...claimsStore.claims].reverse(),
  },
};

const path = `${DIR}/data.json`;
let prev = '';
try { prev = readFileSync(path, 'utf8'); } catch {}
const prevObj = prev ? JSON.parse(prev) : null;
const same = prevObj
  && JSON.stringify(prevObj.account) === JSON.stringify(account)
  && JSON.stringify(prevObj.state?.tip) === JSON.stringify(state?.tip)
  && prevObj.state?.counted === state?.counted
  && JSON.stringify(prevObj.claims?.rounds) === JSON.stringify(out.claims.rounds)
  && JSON.stringify(prevObj.round) === JSON.stringify(roundInfo);
writeFileSync(path, JSON.stringify(out));
if (same) {
  console.log('unchanged', out.updated_at, 'claims', out.claims.count);
  process.exit(0);
}
execSync('git add data.json && git -c user.email=bot@local -c user.name=reset-dash commit -m "chore: refresh data.json" && git push origin main', { cwd: DIR, stdio: 'inherit' });
console.log('pushed', out.updated_at, 'bal', account.balance, 'dep', account.deposit, 'round', account.mine?.r, 'claims', out.claims.count, claimAdded ? '+new' : '');
