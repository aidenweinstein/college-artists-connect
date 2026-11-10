/* Shared by every page on collegeartistsconnect.org */

/* Where the talent API (the Cloudflare Worker in talent-api/) is running. */
const TALENT_API = "https://cac-talent.aidenweinstein11.workers.dev";

/* ============================================================
   EDIT CHAPTERS HERE — copy a block to add a new chapter.
   slug:   the web address of the chapter's talent page, e.g. "ut-austin" → collegeartistsconnect.org/ut-austin
   talent: true once the chapter has a talent page (a folder named after the slug, with
           index.html and admin/index.html copied from ut-austin/) and an admin password.
   ============================================================ */
const chapters = [
  {
    name: "Longhorn Artists Connect",
    slug: "ut-austin",
    talent: true,
    school: "University of Texas at Austin",
    location: "Austin, TX",
    founding: true,
    instagram: "https://www.instagram.com/longhornartistsconnect/",
    colors: { bg: "#BF5700", fg: "#FFFFFF" },   // Texas burnt orange + white
  },
  {
    name: "Cal Artists Connect",
    slug: "berkeley",
    talent: false,
    school: "UC Berkeley",
    location: "Berkeley, CA",
    instagram: "https://www.instagram.com/calartistsconnect/",
    colors: { bg: "#002676", fg: "#FDB515" },   // Berkeley blue + California gold
  },
  {
    name: "Trojan Artists Connect",
    slug: "usc",
    talent: false,
    school: "University of Southern California",
    location: "Los Angeles, CA",
    instagram: "https://www.instagram.com/trojanartistsconnect/",
    colors: { bg: "#990000", fg: "#FFCC00" },   // USC cardinal + gold
  },
  // {
  //   name: "Example Artists Connect",
  //   slug: "example",
  //   talent: false,
  //   school: "Example University",
  //   location: "City, ST",
  //   instagram: "https://instagram.com/example",
  //   colors: { bg: "#333333", fg: "#FFFFFF" },
  //   posts: []   // optional: specific post links to show instead of the profile feed
  // },
];

const DISCIPLINES = ["Actor", "Musician", "Filmmaker"];

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const orderedChapters = () => [...chapters].sort((a, b) => (b.founding === true) - (a.founding === true) || a.school.localeCompare(b.school));
const chapterBySlug = slug => chapters.find(c => c.slug === slug);
/* The chapter whose folder this page is in, e.g. /ut-austin/admin/ → "ut-austin". */
const currentSlug = () => location.pathname.split("/").filter(Boolean)[0] || "";

const photoUrl = id => `${TALENT_API}/photos/${encodeURIComponent(id)}`;
const fileUrl = id => `${TALENT_API}/files/${encodeURIComponent(id)}`;
const SILHOUETTE = `<div class="silhouette" aria-hidden="true"><svg viewBox="0 0 100 100"><circle cx="50" cy="36" r="20" fill="currentColor"/><path d="M12 100c0-24 17-38 38-38s38 14 38 38z" fill="currentColor"/></svg></div>`;
const photoHtml = (a, alt = "") => a && a.photo
  ? `<img src="${esc(photoUrl(a.photo))}" alt="${esc(alt)}" loading="lazy">`
  : SILHOUETTE;

/* An artist's own page, e.g. /ut-austin/fredwara/ */
const artistUrl = (slug, a) => `/${encodeURIComponent(slug)}/${encodeURIComponent(a.handle)}/`;

/* Profile links, in the order they appear on artist pages and in admin. */
const ARTIST_LINKS = [
  ["nexus", "Nexus"], ["instagram", "Instagram"], ["youtube", "YouTube"], ["spotify", "Spotify"],
  ["appleMusic", "Apple Music"], ["imdb", "IMDb"], ["linkedin", "LinkedIn"],
];

/* Returns { artists: [...in All Artists order], featured: [...artists in Featured order],
   frontPage: { Actor: artist, Musician: artist, Filmmaker: artist } (homepage picks) }. */
async function fetchArtists(slug) {
  const res = await fetch(`${TALENT_API}/schools/${encodeURIComponent(slug)}/artists`);
  if (!res.ok) throw new Error(`Couldn't load artists (${res.status})`);
  const data = await res.json();
  const byId = Object.fromEntries(data.artists.map(a => [a.id, a]));
  const frontPage = {};
  for (const [d, id] of Object.entries(data.frontPage || {})) if (byId[id]) frontPage[d] = byId[id];
  return { artists: data.artists, featured: data.featured.map(id => byId[id]).filter(Boolean), frontPage };
}

/* One actor, one musician and one filmmaker for the homepage: the admins' front-page picks.
   If a discipline has no pick yet, the first featured artist (then the first artist) fills in. */
function picksByDiscipline({ artists, featured, frontPage = {} }) {
  return DISCIPLINES.map(d => ({
    discipline: d,
    artist: frontPage[d] || featured.find(a => a.discipline === d) || artists.find(a => a.discipline === d) || null,
  }));
}

/* Admin login token for a chapter (kept only for this browser tab). */
const adminTokenKey = slug => `cac-admin-${slug}`;
const getAdminToken = slug => { try { return sessionStorage.getItem(adminTokenKey(slug)); } catch { return null; } };
const setAdminToken = (slug, t) => { try { t ? sessionStorage.setItem(adminTokenKey(slug), t) : sessionStorage.removeItem(adminTokenKey(slug)); } catch {} };

function fillFooterYear() {
  const yr = document.getElementById("yr");
  if (yr) yr.textContent = new Date().getFullYear();
}
document.addEventListener("DOMContentLoaded", fillFooterYear);

/* When you change site.js or site.css, bump the ?v= number where every page loads them
   (index.html, 404.html, admin/index.html and each chapter's index.html and admin/index.html)
   so visitors' browsers fetch the new copy instead of a saved old one. */
