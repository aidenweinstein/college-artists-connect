/**
 * College Artists Connect talent API (Cloudflare Worker).
 *
 * Stores each chapter's artists, photos and resumes in a KV namespace (binding: TALENT)
 * and checks each chapter's admin password on the server, so passwords never appear
 * in the website's code.
 *
 * Secrets (set with `npx wrangler@4 secret put NAME`):
 *   ADMIN_PASSWORDS  JSON object of chapter slug -> password, e.g. {"ut-austin":"..."}
 *   SESSION_SECRET   any long random string; signs admin login tokens
 *
 * Public:
 *   GET    /schools/:slug/artists          { artists: [...in All Artists order], featured: [ids in Featured order],
 *                                            frontPage: { Actor: id, Musician: id, Filmmaker: id } }
 *   GET    /photos/:id                     a photo
 *   GET    /files/:id                      a resume (PDF)
 * Admin (Authorization: Bearer <token>):
 *   POST   /schools/:slug/login            { password } -> { token }
 *   POST   /schools/:slug/artists          artist fields -> artist
 *   PATCH  /schools/:slug/artists/:id      any artist fields, plus { featured: true|false, frontPage: true|false }
 *                                          (frontPage = the homepage pick for the artist's discipline; one per discipline,
 *                                           and front-page artists are always featured)
 *   DELETE /schools/:slug/artists/:id
 *   PUT    /schools/:slug/order            { all: [ids], featured: [ids] }
 *
 * Artist fields: name, discipline, hometown, major, gradYear, photoCredit,
 *   links: { nexus, instagram, youtube, spotify, appleMusic, imdb, linkedin },
 *   photo: { image, original, crop }   (data URLs; crop = { x, y, size } as fractions of the original)
 *   resume: { name, data } to upload a PDF, or null to remove it
 */

const DISCIPLINES = ["Actor", "Musician", "Filmmaker"];
const LINK_KEYS = ["nexus", "instagram", "youtube", "spotify", "appleMusic", "imdb", "linkedin"];
const RESERVED_HANDLES = ["admin", "index", "artists", "all", "featured"];
const ALLOWED_ORIGINS = [
  "https://collegeartistsconnect.org",
  "https://www.collegeartistsconnect.org",
];
const TOKEN_HOURS = 12;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;   // photos are resized in the browser before upload
const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const LOGIN_LIMIT = 10;                    // failed attempts per IP per 15 minutes

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

  if (parts[0] === "photos" && parts.length === 2 && method === "GET") return getFile(env, "photo", parts[1]);
  if (parts[0] === "files" && parts.length === 2 && method === "GET") return getFile(env, "file", parts[1]);

  if (parts[0] === "schools" && parts.length >= 3) {
    const slug = parts[1];
    if (!/^[a-z0-9-]{1,40}$/.test(slug)) throw new HttpError(404, "Unknown chapter.");

    if (parts[2] === "login" && parts.length === 3 && method === "POST") return login(request, env, slug);

    if (parts[2] === "artists" && parts.length === 3 && method === "GET") {
      return json(publicView(await loadSchool(env, slug)));
    }

    await requireAdmin(request, env, slug);
    if (parts[2] === "artists" && parts.length === 3 && method === "POST") return addArtist(request, env, slug);
    if (parts[2] === "artists" && parts.length === 4 && method === "PATCH") return updateArtist(request, env, slug, parts[3]);
    if (parts[2] === "artists" && parts.length === 4 && method === "DELETE") return deleteArtist(env, slug, parts[3]);
    if (parts[2] === "order" && parts.length === 3 && method === "PUT") return setOrder(request, env, slug);
  }
  throw new HttpError(404, "Not found.");
}

/* ---------- Storage ---------- */

/* One record per chapter: { artists: [...] in All Artists order, featured: [ids] in Featured order,
   frontPage: { discipline: id } }. */
async function loadSchool(env, slug) {
  const school = await env.TALENT.get(`school:${slug}`, "json");
  if (school) { school.frontPage ||= {}; return school; }

  // First load after the upgrade: convert the old format (a plain list with featured flags).
  const legacy = await env.TALENT.get(`artists:${slug}`, "json");
  if (!legacy) return { artists: [], featured: [] };
  const artists = [];
  const sorted = [...legacy].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  for (const old of sorted) {
    artists.push({
      id: old.id,
      handle: uniqueHandle(old.name, artists),
      name: old.name,
      discipline: old.discipline,
      hometown: "", major: "", gradYear: "", photoCredit: "",
      links: blankLinks(old.link),
      photo: old.photo || null,
      photoOriginal: old.photo || null,
      crop: null,
      resume: null,
      added: old.added,
    });
  }
  const school2 = { artists, featured: sorted.filter(a => a.featured).map(a => a.id), frontPage: {} };
  await saveSchool(env, slug, school2);
  await env.TALENT.delete(`artists:${slug}`);
  return school2;
}
async function saveSchool(env, slug, school) {
  await env.TALENT.put(`school:${slug}`, JSON.stringify(school));
}
function publicView(school) {
  return {
    artists: school.artists.map(a => withFeatured(school, a)),
    featured: school.featured,
    frontPage: school.frontPage,
  };
}
function withFeatured(school, artist) {
  return {
    ...artist,
    featured: school.featured.includes(artist.id),
    frontPage: school.frontPage[artist.discipline] === artist.id,
  };
}
/* Keeps the tiers consistent: front-page artists are featured, and each discipline has at most one. */
function setTiers(school, artist, { featured, frontPage }) {
  const id = artist.id;
  for (const d of Object.keys(school.frontPage)) {
    if (school.frontPage[d] === id && (d !== artist.discipline || frontPage === false || featured === false)) delete school.frontPage[d];
  }
  if (frontPage === true) {
    school.frontPage[artist.discipline] = id;
    if (!school.featured.includes(id)) school.featured.push(id);
  }
  if (featured === true && !school.featured.includes(id)) school.featured.push(id);
  if (featured === false) school.featured = school.featured.filter(f => f !== id);
}

/* ---------- Artists ---------- */

async function addArtist(request, env, slug) {
  const body = await readJson(request);
  const school = await loadSchool(env, slug);
  const artist = {
    id: crypto.randomUUID(),
    handle: "",
    name: cleanName(body.name),
    discipline: cleanDiscipline(body.discipline),
    hometown: "", major: "", gradYear: "", photoCredit: "",
    links: blankLinks(),
    photo: null, photoOriginal: null, crop: null,
    resume: null,
    added: new Date().toISOString(),
  };
  artist.handle = uniqueHandle(artist.name, school.artists);
  await applyFields(env, artist, body);
  school.artists.push(artist);
  setTiers(school, artist, { featured: body.featured === true ? true : undefined, frontPage: body.frontPage === true ? true : undefined });
  await saveSchool(env, slug, school);
  return json(withFeatured(school, artist), 201);
}

async function updateArtist(request, env, slug, id) {
  const body = await readJson(request);
  const school = await loadSchool(env, slug);
  const artist = school.artists.find(a => a.id === id);
  if (!artist) throw new HttpError(404, "That artist no longer exists.");

  if ("name" in body) {
    const name = cleanName(body.name);
    if (name !== artist.name) {
      artist.name = name;
      artist.handle = uniqueHandle(name, school.artists.filter(a => a.id !== id));
    }
  }
  if ("discipline" in body) artist.discipline = cleanDiscipline(body.discipline);
  await applyFields(env, artist, body);
  setTiers(school, artist, {
    featured: "featured" in body ? body.featured === true : undefined,
    frontPage: "frontPage" in body ? body.frontPage === true : undefined,
  });
  await saveSchool(env, slug, school);
  return json(withFeatured(school, artist));
}

/* Optional profile fields, photo and resume (shared by add and update). */
async function applyFields(env, artist, body) {
  if ("hometown" in body) artist.hometown = cleanText(body.hometown, 80, "Hometown");
  if ("major" in body) artist.major = cleanText(body.major, 80, "Major");
  if ("gradYear" in body) artist.gradYear = cleanYear(body.gradYear);
  if ("photoCredit" in body) artist.photoCredit = cleanText(body.photoCredit, 80, "Photo credit");
  if (body.links && typeof body.links === "object") {
    for (const k of LINK_KEYS) if (k in body.links) artist.links[k] = cleanLink(body.links[k], k);
  }
  if (body.photo && typeof body.photo === "object") {
    const p = body.photo;
    if (p.image) {
      const oldImage = artist.photo;
      artist.photo = await storeBlob(env, "photo", p.image, /^image\/(jpeg|png|webp)$/, MAX_PHOTO_BYTES, "Upload a JPEG, PNG or WebP photo.");
      if (oldImage && oldImage !== artist.photoOriginal) await env.TALENT.delete(`photo:${oldImage}`);
    }
    if (p.original) {
      const oldOriginal = artist.photoOriginal;
      artist.photoOriginal = await storeBlob(env, "photo", p.original, /^image\/(jpeg|png|webp)$/, MAX_PHOTO_BYTES, "Upload a JPEG, PNG or WebP photo.");
      if (oldOriginal && oldOriginal !== artist.photo) await env.TALENT.delete(`photo:${oldOriginal}`);
    }
    if ("crop" in p) artist.crop = cleanCrop(p.crop);
  }
  if ("resume" in body) {
    const old = artist.resume;
    if (body.resume && body.resume.data) {
      const id = await storeBlob(env, "file", body.resume.data, /^application\/pdf$/, MAX_RESUME_BYTES, "Upload the resume as a PDF under 5 MB.");
      artist.resume = { id, name: cleanText(body.resume.name || "Resume.pdf", 120, "File name") || "Resume.pdf" };
      if (old) await env.TALENT.delete(`file:${old.id}`);
    } else if (body.resume === null) {
      artist.resume = null;
      if (old) await env.TALENT.delete(`file:${old.id}`);
    }
  }
}

async function deleteArtist(env, slug, id) {
  const school = await loadSchool(env, slug);
  const artist = school.artists.find(a => a.id === id);
  if (!artist) throw new HttpError(404, "That artist no longer exists.");
  for (const p of new Set([artist.photo, artist.photoOriginal])) if (p) await env.TALENT.delete(`photo:${p}`);
  if (artist.resume) await env.TALENT.delete(`file:${artist.resume.id}`);
  school.artists = school.artists.filter(a => a.id !== id);
  school.featured = school.featured.filter(f => f !== id);
  for (const d of Object.keys(school.frontPage)) if (school.frontPage[d] === id) delete school.frontPage[d];
  await saveSchool(env, slug, school);
  return json({ ok: true });
}

async function setOrder(request, env, slug) {
  const body = await readJson(request);
  const school = await loadSchool(env, slug);
  const ids = new Set(school.artists.map(a => a.id));
  if (Array.isArray(body.all)) {
    const all = body.all.filter(id => ids.has(id));
    if (new Set(all).size !== ids.size) throw new HttpError(409, "The list changed. Please refresh and try again.");
    const byId = Object.fromEntries(school.artists.map(a => [a.id, a]));
    school.artists = all.map(id => byId[id]);
  }
  if (Array.isArray(body.featured)) {
    const current = new Set(school.featured);
    const featured = [...new Set(body.featured)].filter(id => current.has(id));
    if (featured.length !== current.size) throw new HttpError(409, "The list changed. Please refresh and try again.");
    school.featured = featured;
  }
  await saveSchool(env, slug, school);
  return json(publicView(school));
}

/* ---------- Cleaning input ---------- */

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
function cleanText(v, max, label) {
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  if (s.length > max) throw new HttpError(400, `${label} is too long.`);
  return s;
}
function cleanYear(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (!/^\d{4}$/.test(s) || +s < 1950 || +s > 2100) throw new HttpError(400, "Enter a four-digit graduation year.");
  return s;
}
const LINK_LABELS = { nexus: "Nexus", instagram: "Instagram", youtube: "YouTube", spotify: "Spotify", appleMusic: "Apple Music", imdb: "IMDb", linkedin: "LinkedIn" };
function cleanLink(v, key) {
  const s = String(v || "").trim();
  if (!s) return "";
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { u = null; }
  if (!u || !["http:", "https:"].includes(u.protocol) || !u.hostname.includes(".")) {
    throw new HttpError(400, `The ${LINK_LABELS[key] || "link"} link doesn't look right.`);
  }
  return u.href;
}
function cleanCrop(c) {
  if (!c) return null;
  const x = +c.x, y = +c.y, size = +c.size;
  if (![x, y, size].every(Number.isFinite) || size <= 0 || size > 1 || x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x, y, size };
}
function blankLinks(oldLink = "") {
  const links = Object.fromEntries(LINK_KEYS.map(k => [k, ""]));
  if (/instagram\.com/i.test(oldLink)) links.instagram = oldLink;
  return links;
}

/* The artist's web address, from their name: "Fred Wara" -> "fredwara". */
function uniqueHandle(name, others) {
  let base = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "") || "artist";
  if (RESERVED_HANDLES.includes(base)) base += "1";
  const taken = new Set(others.map(a => a.handle));
  let handle = base, n = 2;
  while (taken.has(handle)) handle = `${base}${n++}`;
  return handle;
}

/* ---------- Files ---------- */

async function storeBlob(env, kind, dataUrl, typeRe, maxBytes, message) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m || !typeRe.test(m[1])) throw new HttpError(400, message);
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  if (bytes.length > maxBytes) throw new HttpError(400, message);
  const id = crypto.randomUUID();
  await env.TALENT.put(`${kind}:${id}`, bytes, { metadata: { type: m[1] } });
  return id;
}

async function getFile(env, kind, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, "Not found.");
  const { value, metadata } = await env.TALENT.getWithMetadata(`${kind}:${id}`, "arrayBuffer");
  if (!value) throw new HttpError(404, "Not found.");
  return new Response(value, {
    headers: {
      "Content-Type": metadata?.type || (kind === "file" ? "application/pdf" : "image/jpeg"),
      // A file's id never changes its contents (a new upload gets a new id), so cache for a long time.
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
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
