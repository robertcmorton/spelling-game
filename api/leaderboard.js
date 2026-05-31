// Shared leaderboard backed by Vercel KV (Upstash Redis).
//
// Setup (one-time, ~2 min):
//   1. Vercel dashboard → spelling-game project → Storage tab
//   2. Create Database → "KV" (Marketplace → Upstash) → connect to project
//   3. Vercel auto-injects KV_REST_API_URL and KV_REST_API_TOKEN env vars
//   4. Push (or redeploy) — the API will start responding
//
// Until KV is connected, the endpoint returns 503 and the frontend falls back
// to the local-only leaderboard.

import { Redis } from '@upstash/redis';

const LEADERBOARD_KEY = 'spelling-bee:leaderboard:v1';
const RATE_KEY_PREFIX  = 'spelling-bee:rate:';
const MAX_ENTRIES      = 1000;   // hard cap on stored rows
const RATE_LIMIT       = 30;     // POSTs per minute per IP

// Crude blocklist — names containing any of these substrings are rejected.
const BLOCKLIST = [
  'fuck', 'shit', 'cunt', 'dick', 'cock', 'pussy',
  'nigger', 'faggot', 'whore', 'bitch', 'bastard',
  'admin', 'undefined', 'null'
];

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 20);
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  if (BLOCKLIST.some(b => lower.includes(b))) return null;
  // Allow Unicode letters/numbers, spaces, hyphens, apostrophes, dots
  if (!/^[\p{L}\p{N}\s\-'.]+$/u.test(trimmed)) return null;
  return trimmed;
}

function getRedis() {
  const url   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({
      error: 'Leaderboard not configured',
      hint: 'Connect Vercel KV (Upstash Redis) in the project dashboard. See README.'
    });
  }

  if (req.method === 'GET') {
    try {
      const raw = await redis.lrange(LEADERBOARD_KEY, 0, -1);
      const entries = (raw || []).map(e => {
        // @upstash/redis auto-parses JSON when possible
        return typeof e === 'string' ? safeParse(e) : e;
      }).filter(Boolean);
      return res.status(200).json({ entries });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'redis error' });
    }
  }

  if (req.method === 'POST') {
    try {
      // Rate limit per IP — 30/min
      const ip = clientIp(req);
      const rateKey = RATE_KEY_PREFIX + ip;
      const count = await redis.incr(rateKey);
      if (count === 1) await redis.expire(rateKey, 60);
      if (count > RATE_LIMIT) {
        return res.status(429).json({ error: 'too many requests, try again in a minute' });
      }

      const body = req.body || {};
      const name  = cleanName(body.name);
      const mode  = (body.mode === 'junior' || body.mode === 'senior') ? body.mode : null;
      const score = parseInt(body.score, 10);
      const total = parseInt(body.total, 10);
      const level = parseInt(body.level, 10);

      if (!name)
        return res.status(400).json({ error: 'invalid name (letters/numbers only, ≤20 chars, no profanity)' });
      if (!mode)
        return res.status(400).json({ error: 'invalid mode (junior or senior)' });
      if (!Number.isFinite(score) || score < 0 || score > 100)
        return res.status(400).json({ error: 'invalid score' });
      if (!Number.isFinite(total) || total < 1 || total > 100)
        return res.status(400).json({ error: 'invalid total' });
      if (score > total)
        return res.status(400).json({ error: 'score > total' });
      if (!Number.isFinite(level) || level < 0 || level > 4)
        return res.status(400).json({ error: 'invalid level' });

      const entry = { name, mode, score, total, level, date: new Date().toISOString() };

      // RPUSH then trim — keep at most MAX_ENTRIES (most recent)
      await redis.rpush(LEADERBOARD_KEY, JSON.stringify(entry));
      await redis.ltrim(LEADERBOARD_KEY, -MAX_ENTRIES, -1);

      return res.status(200).json({ ok: true, entry });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'redis error' });
    }
  }

  if (req.method === 'DELETE') {
    // Wipe the shared leaderboard. Rate-limited per IP via the same
    // bucket so it can't be hammered.
    try {
      const ip = clientIp(req);
      const rateKey = RATE_KEY_PREFIX + 'del:' + ip;
      const count = await redis.incr(rateKey);
      if (count === 1) await redis.expire(rateKey, 60);
      if (count > 5) return res.status(429).json({ error: 'too many resets, try later' });

      await redis.del(LEADERBOARD_KEY);
      return res.status(200).json({ ok: true, cleared: true });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'delete failed' });
    }
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
