/**
 * College Artists Connect talent API (Cloudflare Worker).
 *
 * Stores each chapter's artists and their photos in a KV namespace (binding: TALENT)
 * and checks each chapter's admin password on the server, so passwords never appear
 * in the website's code.
 *
 * Secrets (set with `npx wrangler secret put NAME`):
 *   ADMIN_PASSWORDS  JSON object of chapter slug -> password, e.g. {"ut-austin":"..."}
 *   SESSION_SECRET   any long random string; signs admin login tokens
 *
 * Public:
 *   GET    /schools/:slug/artists          list of artists (featured first, then A-Z)
 *   GET    /photos/:id                     an artist photo
 * Admin (Authorization: Bearer <token>):
 *   POST   /schools/:slug/login            { password } -> { token }
 *   POST   /schools/:slug/artists          { name, discipline, link?, photo? } -> artist
 *   PATCH  /schools/:slug/artists/:id      any of { name, discipline, link, photo, featured }
 *   DELETE /schools/:slug/artists/:id
 */

const DISCIPLINES = ["Actor", "Musician", "Filmmaker"];
const ALLOWED_ORIGINS = [
  "https://collegeartistsconnect.org",
  "https://www.collegeartistsconnect.org",
];
const TOKEN_HOURS = 12;
const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024; // photos are resized in the browser before upload
const LOGIN_LIMIT = 10;                     // failed attempts per IP per 15 minutes

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const res = await route(request, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : "Something went wrong.";
      if (status === 500) console.error(err);
      return json({ error: message }, status, cors);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method;

  if (parts[0] === "photos" && parts.length === 2 && method === "GET") {
    return getPhoto(env, parts[1]);
  }

  if (parts[0] === "schools" && parts.length >= 3) {
    const slug = parts[1];
    if (!/^[a-z0-9-]{1,40}$/.test(slug)) throw new HttpError(404, "Unknown chapter.");

    if (parts[2] === "login" && parts.length === 3 && method === "POST") {
      return login(request, env, slug);
    }
    if (parts[2] === "artists") {
      if (parts.length === 3 && method === "GET") return json(sortArtists(await loadArtists(env, slug)));
      await requireAdmin(request, env, slug);
      if (parts.length === 3 && method === "POST") return addArtist(request, env, slug);
      if (parts.length === 4 && method === "PATCH") return updateArtist(request, env, slug, parts[3]);
      if (parts.length === 4 && method === "DELETE") return deleteArtist(env, slug, parts[3]);
    }
  }
  throw new HttpError(404, "Not found.");
}

/* ---------- Artists ---------- */

async function loadArtists(env, slug) {
  return (await env.TALENT.get(`artists:${slug}`, "json")) || [];
}
async function saveArtists(env, slug, list) {
  await env.TALENT.put(`artists:${slug}`, JSON.stringify(list));
}
function sortArtists(list) {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

async function addArtist(request, env, slug) {
  const body = await readJson(request);
  const artist = {
    id: crypto.randomUUID(),
    name: cleanName(body.name),
    discipline: cleanDiscipline(body.discipline),
    link: cleanLink(body.link),
    photo: null,
    featured: false,
    added: new Date().toISOString(),
  };
  if (body.photo) artist.photo = await storePhoto(env, body.photo);
  const list = await loadArtists(env, slug);
  list.push(artist);
  await saveArtists(env, slug, list);
  return json(artist, 201);
}

async function updateArtist(request, env, slug, id) {
  const body = await readJson(request);
  const list = await loadArtists(env, slug);
  const artist = list.find(a => a.id === id);
  if (!artist) throw new HttpError(404, "That artist no longer exists.");
  if ("name" in body) artist.name = cleanName(body.name);
  if ("discipline" in body) artist.discipline = cleanDiscipline(body.discipline);
  if ("link" in body) artist.link = cleanLink(body.link);
  if ("featured" in body) artist.featured = body.featured === true;
  if (body.photo) {
    const old = artist.photo;
    artist.photo = await storePhoto(env, body.photo);
    if (old) await env.TALENT.delete(`photo:${old}`);
  }
  await saveArtists(env, slug, list);
  return json(artist);
}

async function deleteArtist(env, slug, id) {
  const list = await loadArtists(env, slug);
  const artist = list.find(a => a.id === id);
  if (!artist) throw new HttpError(404, "That artist no longer exists.");
  if (artist.photo) await env.TALENT.delete(`photo:${artist.photo}`);
  await saveArtists(env, slug, list.filter(a => a.id !== id));
  return json({ ok: true });
}

function cleanName(v) {
  const s = String(v || "").trim().replace(/\s+/g, " ");
  if (!s) throw new HttpError(400, "Enter the artist's name.");
  if (s.length > 80) throw new HttpError(400, "That name is too long.");
  return s;
}
function cleanDiscipline(v) {
  if (!DISCIPLINES.includes(v)) throw new HttpError(400, "Choose Actor, Musician or Filmmaker.");
  return v;
}
function cleanLink(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { throw new HttpError(400, "That link doesn't look right."); }
  if (!["http:", "https:"].includes(u.protocol)) throw new HttpError(400, "That link doesn't look right.");
  return u.href;
}

/* ---------- Photos ---------- */

async function storePhoto(env, dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw new HttpError(400, "Upload a JPEG, PNG or WebP photo.");
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  if (bytes.length > MAX_PHOTO_BYTES) throw new HttpError(400, "That photo is too large.");
  const id = crypto.randomUUID();
  await env.TALENT.put(`photo:${id}`, bytes, { metadata: { type: m[1] } });
  return id;
}

async function getPhoto(env, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, "Not found.");
  const { value, metadata } = await env.TALENT.getWithMetadata(`photo:${id}`, "arrayBuffer");
  if (!value) throw new HttpError(404, "Not found.");
  return new Response(value, {
    headers: {
      "Content-Type": metadata?.type || "image/jpeg",
      // Photo ids never change their contents (a new photo gets a new id), so cache for a long time.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

/* ---------- Admin login ---------- */

async function login(request, env, slug) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rlKey = `rl:${ip}`;
  const attempts = Number(await env.TALENT.get(rlKey)) || 0;
  if (attempts >= LOGIN_LIMIT) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");

  const { password } = await readJson(request);
  const passwords = JSON.parse(env.ADMIN_PASSWORDS || "{}");
  const expected = passwords[slug];
  if (!expected || !(await sameString(String(password || ""), expected, env))) {
    await env.TALENT.put(rlKey, String(attempts + 1), { expirationTtl: 900 });
    throw new HttpError(401, "Wrong password.");
  }
  const exp = Date.now() + TOKEN_HOURS * 3600 * 1000;
  const payload = b64url(JSON.stringify({ slug, exp }));
  return json({ token: `${payload}.${await sign(payload, env)}`, expires: exp });
}

async function requireAdmin(request, env, slug) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !(await sameString(sig, await sign(payload, env), env))) {
    throw new HttpError(401, "Please log in again.");
  }
  let data;
  try { data = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))); } catch { throw new HttpError(401, "Please log in again."); }
  if (data.slug !== slug || !(data.exp > Date.now())) throw new HttpError(401, "Please log in again.");
}

async function hmacKey(env) {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function sign(text, env) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(text));
  return b64url(String.fromCharCode(...new Uint8Array(sig)));
}
// Compares two strings without leaking how much of them matched.
async function sameString(a, b, env) {
  const [x, y] = await Promise.all([sign(`cmp:${a}`, env), sign(`cmp:${b}`, env)]);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
function b64url(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ---------- Helpers ---------- */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function readJson(request) {
  try { return await request.json(); } catch { throw new HttpError(400, "Bad request."); }
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}
function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
