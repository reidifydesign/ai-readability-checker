/**
 * Netlify Function: readabilityCheck
 *
 * Powers the public AI-readability checker at /ai-readability-checker.
 * Fetches a URL's RAW HTML (no JS execution, which is exactly what many AI
 * crawlers see) and reports concrete, checkable structural facts: title, meta
 * description, heading tree, JSON-LD types, alt coverage, text volume without
 * hydration, plus robots.txt AI-crawler rules, sitemap, and llms.txt.
 *
 * Deliberately NOT a score-out-of-100 toy. Every finding names what was found,
 * why it matters to a machine reader, and nothing is inferred beyond the bytes.
 */

const TIMEOUT_MS = 10000;
const MAX_BYTES = 2_000_000;

// Same rate-limit shape as sendEmail: in-memory, per-instance, best effort.
const hits = new Map();
const RATE_LIMIT = 12;
const RATE_WINDOW_MS = 60_000;

const rateLimited = (ip) => {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_LIMIT;
};

export const normalizeUrl = (raw) => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, 500);
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  // Block private/loopback ranges so the function cannot be used to probe
  // internal infrastructure (SSRF guard).
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^\[?::1\]?$/.test(host) ||
    !host.includes(".")
  ) {
    return null;
  }
  return u;
};

export const fetchText = async (url, { asText = true } = {}) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        // Identify honestly. This is a user-initiated check, not a crawler.
        "User-Agent": "ReidifyReadabilityCheck/1.0 (+https://reidify.design/ai-readability-checker)",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
    });
    if (!asText) return { ok: res.ok, status: res.status, body: "" };
    const buf = await res.arrayBuffer();
    const sliced = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
    return { ok: res.ok, status: res.status, body: new TextDecoder("utf-8").decode(sliced) };
  } catch {
    return { ok: false, status: 0, body: "" };
  } finally {
    clearTimeout(timer);
  }
};

const stripTags = (html) =>
  html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1] : null;
};

/**
 * Find text that is present in the HTML but hidden from rendering.
 *
 * THIS IS THE CHECK THE TOOL MOST NEEDED AND DID NOT HAVE. Counting words in
 * stripped HTML happily counts words inside a hidden div, so a page whose whole
 * body ships hidden scores a healthy word count while a machine reading
 * document structure sees a placeholder. That is not hypothetical: it is how
 * 123 pages of reidify.design failed silently for four months behind a build
 * check that counted characters. Hidden characters are still characters.
 *
 * Depth-tracked rather than regex-matched, because a non-greedy regex closes on
 * the first nested closing tag and reports a fraction of the real blob.
 *
 * Catches the hidden attribute, inline display:none / visibility:hidden, and
 * template elements, whose contents never render at all.
 */
const HIDDEN_TAG = /<(div|section|main|article|span|template)\b([^>]*)>/gi;

const extractHidden = (html) => {
  const chunks = [];
  let m;
  HIDDEN_TAG.lastIndex = 0;
  while ((m = HIDDEN_TAG.exec(html))) {
    const [full, tag, attrs] = m;
    const isHidden =
      tag.toLowerCase() === "template" ||
      /\shidden(\s|=|$)/i.test(attrs) ||
      /style\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs);
    if (!isHidden || full.endsWith("/>")) continue;

    const open = new RegExp("<" + tag + "\\b[^>]*>", "gi");
    const close = new RegExp("</" + tag + "\\s*>", "gi");
    let depth = 1;
    let cursor = m.index + full.length;
    const start = cursor;
    while (depth > 0 && cursor < html.length) {
      open.lastIndex = cursor;
      close.lastIndex = cursor;
      const o = open.exec(html);
      const c = close.exec(html);
      if (!c) break;
      if (o && o.index < c.index) {
        depth += 1;
        cursor = o.index + o[0].length;
      } else {
        depth -= 1;
        cursor = c.index + c[0].length;
        if (depth === 0) chunks.push(html.slice(start, c.index));
      }
    }
    HIDDEN_TAG.lastIndex = cursor;
  }
  return chunks;
};

export const analyseHtml = (html, pageUrl) => {
  const findings = [];
  const add = (id, label, status, detail) => findings.push({ id, label, status, detail });

  // --- Title ---
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : "";
  if (!title) {
    add("title", "Page title", "fail", "No title tag found in the raw HTML. This is the single strongest label a machine has for the page.");
  } else if (title.length > 65) {
    add("title", "Page title", "warn", `Present but long (${title.length} characters). It will be truncated in results: "${title.slice(0, 80)}"`);
  } else {
    add("title", "Page title", "pass", `"${title}"`);
  }

  // --- Meta description ---
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  const descTag = metaTags.find((t) => /name\s*=\s*["']description["']/i.test(t));
  const desc = descTag ? attr(descTag, "content") : null;
  if (!desc) {
    add("description", "Meta description", "fail", "Missing. Answer engines often use this as the summary sentence when they cite a page.");
  } else if (desc.length < 50) {
    add("description", "Meta description", "warn", `Only ${desc.length} characters. Too thin to summarise the page usefully.`);
  } else {
    add("description", "Meta description", "pass", `${desc.length} characters, present in raw HTML.`);
  }

  // --- Heading tree ---
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({
    level: Number(m[1]),
    text: stripTags(m[2]),
  }));
  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    add("h1", "H1 heading", "fail", "No h1 in the raw HTML. A machine reading structure first has no statement of what this page is about.");
  } else if (h1s.length > 1) {
    add("h1", "H1 heading", "warn", `${h1s.length} h1 tags found. Multiple top-level headings compete to define the page subject.`);
  } else {
    add("h1", "H1 heading", "pass", `"${h1s[0].text.slice(0, 120)}"`);
  }

  if (headings.length === 0) {
    add("tree", "Heading structure", "fail", "No headings at all in the raw HTML. There is no outline for a machine to follow.");
  } else {
    let skipped = null;
    for (let i = 1; i < headings.length; i += 1) {
      if (headings[i].level - headings[i - 1].level > 1) {
        skipped = `h${headings[i - 1].level} jumps straight to h${headings[i].level}`;
        break;
      }
    }
    if (skipped) {
      add("tree", "Heading structure", "warn", `${headings.length} headings, but a level is skipped (${skipped}). Levels chosen for size rather than hierarchy read as a broken outline.`);
    } else {
      add("tree", "Heading structure", "pass", `${headings.length} headings in a logical order, no skipped levels.`);
    }
  }

  // --- Structured data ---
  const ldBlocks = [...html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const types = [];
  for (const b of ldBlocks) {
    try {
      const parsed = JSON.parse(b[1].trim());
      const collect = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach(collect);
        if (node["@type"]) types.push(...[].concat(node["@type"]));
        if (node["@graph"]) collect(node["@graph"]);
      };
      collect(parsed);
    } catch {
      add("schema-invalid", "Structured data syntax", "warn", "A JSON-LD block exists but does not parse as valid JSON, so machines will skip it.");
    }
  }
  const uniqueTypes = [...new Set(types)];
  if (uniqueTypes.length === 0) {
    add("schema", "Structured data", "fail", "No JSON-LD found. Nothing on the page states in machine-readable form who this business is or what it offers.");
  } else {
    const hasIdentity = uniqueTypes.some((t) => /Organization|LocalBusiness|Person/i.test(t));
    add(
      "schema",
      "Structured data",
      hasIdentity ? "pass" : "warn",
      hasIdentity
        ? `Found: ${uniqueTypes.join(", ")}`
        : `Found ${uniqueTypes.join(", ")}, but no Organization, LocalBusiness, or Person type naming the entity behind the page.`
    );
  }

  // --- Text without JavaScript ---
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;

  // Subtract hidden content BEFORE counting, or a page whose whole body ships
  // inside a hidden div reports a healthy word count while a machine sees a
  // placeholder.
  const hiddenChunks = extractHidden(bodyHtml);
  const hiddenWords = hiddenChunks
    .map((c) => stripTags(c))
    .filter(Boolean)
    .reduce((n, t) => n + t.split(/\s+/).length, 0);

  let renderedHtml = bodyHtml;
  for (const c of hiddenChunks) renderedHtml = renderedHtml.replace(c, " ");
  const visibleText = stripTags(renderedHtml);
  const words = visibleText ? visibleText.split(/\s+/).length : 0;

  if (hiddenWords >= 100) {
    add("hidden", "Hidden content", "fail", `${hiddenWords} words sit inside hidden elements and never render. That text is in the file, so byte-counting checks pass, but a machine reading document structure does not see it. If this page prerenders, check whether the reveal script survived your Content Security Policy.`);
  } else if (hiddenWords > 0) {
    add("hidden", "Hidden content", "info", `${hiddenWords} words inside hidden elements. Small enough to be intentional, such as a skip link or an icon label.`);
  }

  if (words < 50) {
    add("text", "Text without JavaScript", "fail", `Only ${words} words survive in the raw HTML. Crawlers that do not execute JavaScript see almost nothing of this page.`);
  } else if (words < 250) {
    add("text", "Text without JavaScript", "warn", `${words} words in the raw HTML. Thin for a page meant to be summarised or cited.`);
  } else {
    add("text", "Text without JavaScript", "pass", `${words} words readable before any JavaScript runs.`);
  }

  // --- Image alt coverage ---
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const withAlt = imgs.filter((t) => /\balt\s*=/i.test(t)).length;
  if (imgs.length === 0) {
    add("alt", "Image alt text", "pass", "No img tags in the raw HTML, so nothing to describe.");
  } else if (withAlt < imgs.length) {
    add("alt", "Image alt text", "warn", `${withAlt} of ${imgs.length} images carry an alt attribute. Meaning inside an undescribed image is invisible to a machine.`);
  } else {
    add("alt", "Image alt text", "pass", `All ${imgs.length} images carry an alt attribute.`);
  }

  // --- Canonical ---
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  const canonical = linkTags.find((t) => /rel\s*=\s*["']canonical["']/i.test(t));
  add(
    "canonical",
    "Canonical URL",
    canonical ? "pass" : "warn",
    canonical ? attr(canonical, "href") || "Present." : "No canonical link. Duplicate or parameterised versions of this page can compete with each other."
  );

  // --- Open Graph ---
  const ogTitle = metaTags.some((t) => /property\s*=\s*["']og:title["']/i.test(t));
  const ogImage = metaTags.some((t) => /property\s*=\s*["']og:image["']/i.test(t));
  add(
    "og",
    "Social preview tags",
    ogTitle && ogImage ? "pass" : "warn",
    ogTitle && ogImage ? "og:title and og:image both present." : `Missing ${!ogTitle ? "og:title" : ""}${!ogTitle && !ogImage ? " and " : ""}${!ogImage ? "og:image" : ""}. Shared links render without a controlled preview.`
  );

  // --- Language ---
  const htmlTag = html.match(/<html\b[^>]*>/i);
  const lang = htmlTag ? attr(htmlTag[0], "lang") : null;
  add("lang", "Language declaration", lang ? "pass" : "warn", lang ? `lang="${lang}"` : 'No lang attribute on the html tag. Machines have to guess the language.');

  return { findings, meta: { title, url: pageUrl } };
};

export const analyseSiteFiles = async (origin) => {
  const findings = [];
  const add = (id, label, status, detail) => findings.push({ id, label, status, detail });

  const robots = await fetchText(`${origin}/robots.txt`);
  if (!robots.ok || !robots.body.trim()) {
    add("robots", "robots.txt", "warn", "No robots.txt found. Crawler access is undefined rather than deliberate.");
  } else {
    const body = robots.body.toLowerCase();
    const bots = ["gptbot", "claudebot", "perplexitybot", "google-extended"];
    const named = bots.filter((b) => body.includes(b));
    const blocked = named.filter((b) => {
      const idx = body.indexOf(b);
      const block = body.slice(idx, idx + 200);
      return /disallow:\s*\//.test(block);
    });
    if (named.length === 0) {
      add("robots", "AI crawler rules", "warn", "robots.txt exists but names no AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended). They fall back to your general rules, which may not be what you intend either way.");
    } else if (blocked.length > 0) {
      add("robots", "AI crawler rules", "fail", `robots.txt blocks ${blocked.join(", ")}. These crawlers are told not to read the site, so it cannot be cited by the systems behind them.`);
    } else {
      add("robots", "AI crawler rules", "pass", `robots.txt explicitly allows ${named.join(", ")}.`);
    }
    add("sitemap-ref", "Sitemap reference", body.includes("sitemap:") ? "pass" : "warn", body.includes("sitemap:") ? "robots.txt points to a sitemap." : "robots.txt does not reference a sitemap.");
  }

  const sitemap = await fetchText(`${origin}/sitemap.xml`);
  const isXml = sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.body);
  if (isXml) {
    const count = (sitemap.body.match(/<loc>/gi) || []).length;
    add("sitemap", "sitemap.xml", "pass", `Found, listing ${count} URL${count === 1 ? "" : "s"}.`);
  } else {
    add("sitemap", "sitemap.xml", "warn", "No valid sitemap.xml at the site root. Discovery relies entirely on crawling links.");
  }

  const llms = await fetchText(`${origin}/llms.txt`);
  const hasLlms = llms.ok && llms.body.trim().length > 0 && !/<html/i.test(llms.body.slice(0, 200));
  add(
    "llms",
    "llms.txt",
    hasLlms ? "pass" : "info",
    hasLlms
      ? "Present. A courtesy signal pointing AI systems at your canonical pages."
      : "Not present. Optional and unsupported by Google, but cheap to add and read by some tools."
  );

  return findings;
};

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  if (rateLimited(ip)) {
    return new Response(JSON.stringify({ error: "Too many checks. Please wait a minute and try again." }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = normalizeUrl(payload?.url);
  if (!url) {
    return new Response(JSON.stringify({ error: "That does not look like a public website address. Try something like example.com" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const page = await fetchText(url.href);
  if (!page.ok || !page.body) {
    return new Response(
      JSON.stringify({
        error:
          page.status >= 400
            ? `The site responded with HTTP ${page.status}, so there was nothing to read.`
            : "Could not reach that site within 10 seconds. It may be blocking automated requests, which is itself worth knowing.",
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  const { findings: pageFindings, meta } = analyseHtml(page.body, url.href);
  let siteFindings = [];
  try {
    siteFindings = await analyseSiteFiles(url.origin);
  } catch {
    siteFindings = [];
  }

  const all = [...pageFindings, ...siteFindings];
  const counts = all.reduce(
    (acc, f) => {
      acc[f.status] = (acc[f.status] || 0) + 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0, info: 0 }
  );

  return new Response(
    JSON.stringify({
      url: meta.url,
      title: meta.title,
      checkedAt: new Date().toISOString(),
      counts,
      page: pageFindings,
      site: siteFindings,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

/** Run every check against one URL. Used by bin/cli.js and by library consumers. */
export const check = async (rawUrl) => {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error(`Not a usable public URL: ${rawUrl}`);
  const page = await fetchText(url.href);
  if (!page.ok || !page.body) {
    throw new Error(`Could not fetch ${url.href} (HTTP ${page.status || "no response"})`);
  }
  const { findings, meta } = analyseHtml(page.body, url.href);
  const site = await analyseSiteFiles(url.origin);
  return { url: url.href, meta, findings: [...findings, ...site] };
};
