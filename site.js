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
const SILHOUETTE = `<div class="silhouette" aria-hidden="true"><svg viewBox="0 0 100 100"><circle cx="50" cy="36" r="20" fill="currentColor"/><path d="M12 100c0-24 17-38 38-38s38 14 38 38z" fill="currentColor"/></svg></div>`;
const photoHtml = (a, alt = "") => a && a.photo
  ? `<img src="${esc(photoUrl(a.photo))}" alt="${esc(alt)}" loading="lazy">`
  : SILHOUETTE;

async function fetchArtists(slug) {
  const res = await fetch(`${TALENT_API}/schools/${encodeURIComponent(slug)}/artists`);
  if (!res.ok) throw new Error(`Couldn't load artists (${res.status})`);
  return res.json();
}

/* One actor, one musician and one filmmaker for the homepage: featured artists first. */
function picksByDiscipline(artists) {
  return DISCIPLINES.map(d => {
    const of = artists.filter(a => a.discipline === d);
    return { discipline: d, artist: of.find(a => a.featured) || of[0] || null };
  });
}

function fillFooterYear() {
  const yr = document.getElementById("yr");
  if (yr) yr.textContent = new Date().getFullYear();
}
document.addEventListener("DOMContentLoaded", fillFooterYear);
