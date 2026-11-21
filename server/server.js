// Infofitsserve Consultant Services - Reachly API (Cloud Run + Firestore)
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Firestore } from '@google-cloud/firestore';

const { PAYU_KEY, PAYU_SALT, JWT_SECRET, SITE_URL, API_URL, ANTHROPIC_API_KEY,
  PAYU_URL = 'https://test.payu.in/_payment', MODEL = 'claude-sonnet-5-5' } = process.env;
const TRIAL_DAYS = 7;
const PLANS = [{ name: 'Starter', price: 1999 }, { name: 'Growth', price: 4999 }, { name: 'Scale', price: 9999 }]; // set real prices
const db = new Firestore();
const sha = s => crypto.createHash('sha512').update(s).digest('hex');
const key = s => crypto.createHash('sha256').update(s.toLowerCase()).digest('hex');
const getU = async id => { const s = await db.collection('users').doc(key(id)).get(); return s.exists ? s.data() : null; };
const putU = u => db.collection('users').doc(key(u.id)).set(u, { merge: true });

const app = express();
app.use(cors({ origin: new URL(SITE_URL).origin }), express.json(), express.urlencoded({ extended: true }));

// TODO: send the code by email (SES/SendGrid) and/or SMS (MSG91/Twilio; India needs DLT registration).
async function deliver(email, code) { /* provider call here */ }

app.post('/api/otp/send', async (q, r) => {
  const { mode, identifier: id, name, company, mobile } = q.body;
  if (!id) return r.status(400).json({ error: 'Email required' });
  if (mode === 'login' && !(await getU(id))) return r.status(404).json({ error: 'No account found. Please sign up.' });
  const code = String(crypto.randomInt(100000, 1000000));
  await db.collection('otps').doc(key(id)).set({ h: sha(code + id), exp: Date.now() + 6e5, tries: 0, name, company, mobile });
  await deliver(id, code);
  r.json({ ok: true });
});

app.post('/api/otp/verify', async (q, r) => {
  const { identifier: id, otp } = q.body, ref = db.collection('otps').doc(key(id)), s = await ref.get(), o = s.data();
  if (!o || o.exp < Date.now() || o.tries >= 5) return r.status(400).json({ error: 'OTP expired or too many attempts' });
  if (o.h !== sha(otp + id)) { await ref.update({ tries: o.tries + 1 }); return r.status(400).json({ error: 'Incorrect OTP' }); }
  await ref.delete();
  if (!(await getU(id))) await putU({ id, email: id, name: o.name || '', company: o.company || '', mobile: o.mobile || '',
    trialEnds: Date.now() + TRIAL_DAYS * 864e5, plan: null, paidUntil: 0, connected: [] });
  r.json({ token: jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' }) });
});

const auth = async (q, r, n) => {
  try { q.u = await getU(jwt.verify((q.headers.authorization || '').slice(7), JWT_SECRET).id); if (!q.u) throw 0; n(); }
  catch { r.status(401).json({ error: 'Please log in' }); }
};
const status = u => u.paidUntil > Date.now() ? 'active' : u.trialEnds > Date.now() ? 'trial' : 'expired';

app.get('/api/me', auth, (q, r) => {
  const u = q.u;
  r.json({ name: u.name, plan: u.plan, plans: PLANS, connected: u.connected, campaigns: [], status: status(u), trialEnds: u.trialEnds, paidUntil: u.paidUntil });
});

// AI agent: server-side call so your Anthropic key stays secret. Only trial/active clients.
app.post('/api/ai', auth, async (q, r) => {
  if (status(q.u) === 'expired') return r.status(402).json({ error: 'Trial ended. Please subscribe to continue.' });
  try {
    const a = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content: String(q.body.prompt).slice(0, 6000) }] }) });
    const j = await a.json(), t = (j.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    r.json({ data: JSON.parse(t) });
  } catch { r.status(502).json({ error: 'AI request failed. Please try again.' }); }
});

// PayU: hash = sha512(key|txnid|amount|productinfo|firstname|email|udf1..udf5||||||salt)
app.post('/api/payu/initiate', auth, (q, r) => {
  const plan = PLANS.find(p => p.name === q.body.plan);
  if (!plan) return r.status(400).json({ error: 'Invalid plan' });
  const f = { key: PAYU_KEY, txnid: 'T' + Date.now() + crypto.randomInt(1e4), amount: plan.price.toFixed(2),
    productinfo: 'Reachly ' + plan.name, firstname: (q.u.name || 'Client').split(' ')[0], email: q.u.email, phone: q.u.mobile || '',
    surl: API_URL + '/api/payu/result', furl: API_URL + '/api/payu/result', udf1: q.u.id, udf2: plan.name, udf3: '', udf4: '', udf5: '' };
  f.hash = sha([f.key, f.txnid, f.amount, f.productinfo, f.firstname, f.email, f.udf1, f.udf2, f.udf3, f.udf4, f.udf5, '', '', '', '', '', PAYU_SALT].join('|'));
  r.json({ action: PAYU_URL, fields: f });
});

app.post('/api/payu/result', async (q, r) => {
  const b = q.body;
  const rev = sha([PAYU_SALT, b.status, '', '', '', '', '', b.udf5 || '', b.udf4 || '', b.udf3 || '', b.udf2 || '', b.udf1 || '',
    b.email, b.firstname, b.productinfo, b.amount, b.txnid, PAYU_KEY].join('|'));
  const plan = PLANS.find(p => p.name === b.udf2), u = await getU(b.udf1 || '');
  if (rev === b.hash && b.status === 'success' && plan && u && Number(b.amount) === plan.price) {
    try {
      await db.collection('payments').doc(b.txnid).create({ user: u.id, plan: plan.name, at: Date.now() }); // fails if already processed
      await putU({ id: u.id, plan: plan.name, paidUntil: Math.max(Date.now(), u.paidUntil) + 30 * 864e5 });
    } catch { /* duplicate callback */ }
  }
  r.redirect(SITE_URL + '/#dashboard');
});

// Social ads: needs an approved developer app per platform (Meta, Google Ads, LinkedIn, X).
app.post('/api/oauth/:p/start', auth, (q, r) => r.status(501).json({ error: 'Platform connection not implemented yet' }));

app.listen(process.env.PORT || 8080);
