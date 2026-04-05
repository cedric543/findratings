// SANITY CHECK: Change this number to verify you are running the latest code
console.log("[FindRatings] Service Worker Loaded. Version: FIXED_V19");

let OMDB_API_KEY = ""; 

// grabs the key your friend saved in the options page out of chrome storage
chrome.storage.local.get("omdb_key", (data) => {
  if (data.omdb_key) OMDB_API_KEY = data.omdb_key;
}); 

// if they type a new key while netflix is open this updates it immediately without a refresh
chrome.storage.onChanged.addListener((changes) => {
  if (changes.omdb_key) OMDB_API_KEY = changes.omdb_key.newValue;
});

const TMDB_API_KEY = "YOUR_TMDB_API_KEY";

// in-memory cache so hovering the same movie twice is instant
const ratingsCache = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // basic security check to make sure netflix didn't accidentally send us a massive string or code
  if (message?.type === "FETCH_RATINGS") {
    if (typeof message.title !== 'string' || message.title.length > 200) {
      // for debugging
      console.error("[FindRatings] Invalid title received:", message.title);
      return false; 
    }
    
    // for debugging
    console.log("[FindRatings] Received fetch request:", { title: message.title, year: message.year });
    fetchRatings(message.title, message.year)
      // for debugging
      .then((data) => { console.log("[FindRatings] Sending response:", data); sendResponse({ ok: true, data }); })
      .catch((error) => {
        sendResponse({ ok: false, error: String(error) });
      });
    return true; // tells chrome to wait because we are fetching data from the internet asynchronously
  }

  // opens letterboxd in a new tab when you click the button on the card
  if (message?.type === "OPEN_TAB" && message.url) {
    chrome.tabs.create({ url: message.url });
  }
});

async function fetchRatings(title, year) {
  const cacheKey = `${String(title).trim()}::${String(year || "").trim()}`;
  if (ratingsCache.has(cacheKey)) {
    return ratingsCache.get(cacheKey);
  }

  const rawTitle = title;
  let rawYear = year;

  // Step 1: Always ask OMDB for authoritative title, year, and runtime.
  // This is the source of truth we use to validate the letterboxd page later.
  let omdbRuntime = null;
  let omdbYear = null;
  if (OMDB_API_KEY && OMDB_API_KEY !== "YOUR_OMDB_API_KEY") {
    const omdbData = await fetchOmdb(rawTitle, rawYear || null, null);
    if (omdbData) {
      console.log("[FindRatings] OMDB data:", { year: omdbData.Year, runtime: omdbData.Runtime });
      if (omdbData.Year) {
        const parsedYear = omdbData.Year.replace(/[^\d]/g, "").slice(0, 4);
        // ignore future years — they're unreleased stubs and will point to the wrong page
        if (parsedYear && Number(parsedYear) <= new Date().getFullYear()) {
          omdbYear = parsedYear;
        }
      }
      if (omdbData.Runtime) {
        omdbRuntime = parseRuntimeMinutes(omdbData.Runtime);
      }
    }
  }

  // If Netflix gave us no year but OMDB has one, use it
  if ((!rawYear || rawYear === "undefined" || rawYear === "N/A") && omdbYear) {
    console.log("[FindRatings] Year from OMDB:", omdbYear);
    rawYear = omdbYear;
  }

  // Step 2: Find the correct Letterboxd page, validated by year AND runtime.
  let letterboxd = await fetchLetterboxd(rawTitle, rawYear, omdbRuntime);

  // Fallback to TMDB if Letterboxd failed to get a rating (and user has a key)
  if ((!letterboxd || letterboxd.letterboxdRating === "N/A") && TMDB_API_KEY !== "YOUR_TMDB_API_KEY") {
    const tmdb = await fetchTmdb(rawTitle, rawYear);
    if (tmdb) letterboxd = { ...letterboxd, ...tmdb };
  }

  const result = {
    // we use the real title from the letterboxd page so the popup is completely accurate
    title: letterboxd?.letterboxdTitle || rawTitle,
    year: rawYear || letterboxd?.letterboxdYear || null,
    letterboxdRating: letterboxd?.letterboxdRating || "N/A",
    letterboxdUrl: letterboxd?.letterboxdUrl || null,
    letterboxdSlug: letterboxd?.letterboxdSlug || null,
    letterboxdSource: letterboxd?.letterboxdSource || null
  };
  ratingsCache.set(cacheKey, result);
  return result;
}

// asks omdb for extra data just in case we need to verify a run time
async function fetchOmdb(title, year, runtime) {
  if (!OMDB_API_KEY || OMDB_API_KEY === "YOUR_OMDB_API_KEY") {
    return null;
  }

  const params = new URLSearchParams({
    t: title,
    apikey: OMDB_API_KEY
  });
  if (year) {
    params.set("y", String(year));
  }

  // when no year is given, skip the direct lookup — it defaults to the most recent film
  // which is wrong for titles like "Snake Eyes" where the old film is what Netflix has.
  // go straight to search-by-votes which reliably picks the most well-known version.
  if (!year) return fetchOmdbBySearch(title, null, runtime);

  const response = await fetch(`https://www.omdbapi.com/?${params.toString()}`);
  const data = await response.json();
  if (data?.Response === "True") {
    if (runtime && data?.Runtime) {
      const runtimeMinutes = parseRuntimeMinutes(data.Runtime);
      if (runtimeMinutes && !isRuntimeClose(runtimeMinutes, runtime)) {
        return fetchOmdbBySearch(title, year, runtime);
      }
    }
    return data;
  }
  return fetchOmdbBySearch(title, year, runtime);
}

// if the normal omdb search fails we grab a list of matches and filter through them
async function fetchOmdbBySearch(title, year, runtime) {
  if (!OMDB_API_KEY) return null;

  const params = new URLSearchParams({
    s: title,
    type: "movie",
    apikey: OMDB_API_KEY
  });
  if (year) {
    params.set("y", String(year));
  }

  const response = await fetch(`https://www.omdbapi.com/?${params.toString()}`);
  const data = await response.json();
  let results = Array.isArray(data?.Search) ? data.Search : [];
  if (!results.length) return null;

  // fetch all candidate details in parallel
  const desiredYear = year ? String(year) : null;
  const detailedCandidates = (await Promise.all(
    results
      .filter(item => item?.imdbID)
      .map(async item => {
        try {
          const detailParams = new URLSearchParams({ i: item.imdbID, apikey: OMDB_API_KEY });
          const detailResponse = await fetch(`https://www.omdbapi.com/?${detailParams.toString()}`);
          const detail = await detailResponse.json();
          if (detail?.Response !== "True") return null;
          // exclude TV series and TV episodes — Netflix movies shouldn't match these
          if (!desiredYear && detail?.Type && detail.Type !== "movie") return null;
          const matchesYear = !desiredYear || String(detail?.Year) === desiredYear;
          const runtimeMinutes = parseRuntimeMinutes(detail?.Runtime);
          const matchesRuntime = !runtime || (runtimeMinutes && isRuntimeClose(runtimeMinutes, runtime));
          return (matchesYear && matchesRuntime) ? detail : null;
        } catch { return null; }
      })
  )).filter(Boolean);

  if (!detailedCandidates.length) return null;

  // If year was missing, sort by imdbVotes to find the "main" movie (fixes Moonlight/Whiplash)
  // otherwise we might grab a random short film from 2024 just because it's newer
  detailedCandidates.sort((a, b) => {
    const votesA = parseInt((a.imdbVotes || "0").replace(/,/g, "")) || 0;
    const votesB = parseInt((b.imdbVotes || "0").replace(/,/g, "")) || 0;
    return votesB - votesA;
  });

  return detailedCandidates[0];
}

// when year is completely unknown and search fails, try title-YEAR slugs from most
// recent down 12 years. stops at the first slug that exists AND has a real rating.
// this fixes films like War Machine (2017) where Netflix doesn't expose the year.
async function fetchLetterboxdRecentYears(title, omdbRuntime) {
  const slug = slugifyLetterboxdTitle(title);
  // also generate a slug that drops "&" entirely instead of converting to "and"
  // e.g. "Mr. & Mrs. Smith" → "mr-mrs-smith" not "mr-and-mrs-smith"
  const slugNoAnd = title.includes("&")
    ? slugifyLetterboxdTitle(title.replace(/\s*&\s*/g, " "))
    : null;

  const slugsToTry = [...new Set([slug, slugNoAnd].filter(Boolean))];
  if (!slugsToTry.length) return null;

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 30 }, (_, i) => currentYear - i);

  // fire all year+slug combinations in parallel, then pick the newest with a real rating
  const results = await Promise.all(
    years.flatMap(y =>
      slugsToTry.map(s =>
        fetchLetterboxdFilmRaw(`${s}-${y}`, title, String(y), omdbRuntime, false)
          .then(r => (r && r.letterboxdRating !== "N/A" ? { ...r, _year: y } : null))
          .catch(() => null)
      )
    )
  );

  // return the result with the highest (most recent) year
  return results.filter(Boolean).sort((a, b) => b._year - a._year)[0] || null;
}

// main letterboxd hub. it tries guessing the exact url first to be fast
// if that fails it relies on searching
// omdbRuntime is in minutes and is used to disambiguate films with the same title and year
async function fetchLetterboxd(title, year, omdbRuntime) {
  if (!year || year === "undefined" || year === "N/A") {
    // run search and recent-year slug guessing in parallel
    const [fromSearch, fromYearGuess] = await Promise.all([
      fetchLetterboxdFromSearch(title, null, omdbRuntime).catch(() => null),
      fetchLetterboxdRecentYears(title, omdbRuntime).catch(() => null)
    ]);
    // prefer the year-guess result if it has a real rating — it's more specific than a
    // popularity-ranked search result which could be a remake or TV series
    if (fromYearGuess && fromYearGuess.letterboxdRating !== "N/A") return fromYearGuess;
    if (fromSearch && fromSearch.letterboxdRating !== "N/A") return fromSearch;
    if (fromYearGuess) return fromYearGuess;
    if (fromSearch) return fromSearch;
  }

  const variants = buildLetterboxdSlugVariants(title, year);
  if (!variants.length) {
    return null;
  }

  // try all slug variants in parallel — first valid result wins
  const slugResults = await Promise.all(
    variants.map(slug => fetchLetterboxdFilm(slug, title, year, omdbRuntime, true).catch(() => null))
  );
  // when we have a year, take the first match; without a year prefer a result with a real rating
  // to avoid landing on an old obscure film (e.g. 1941 Mr. & Mrs. Smith) over the Netflix one
  const resolved = year
    ? slugResults.find(r => r !== null) || null
    : slugResults.find(r => r && r.letterboxdRating !== "N/A") || slugResults.find(r => r !== null) || null;
  if (resolved) return resolved;

  // fallback to search if the url guessing failed for some reason
  const fromSearch = await fetchLetterboxdFromSearch(title, year, omdbRuntime);
  if (fromSearch) return fromSearch;

  // If search failed, try the best guess slug one last time WITHOUT strict checking.
  const fallbackSlug = variants[0];
  const fallbackFetch = await fetchLetterboxdFilm(fallbackSlug, title, year, omdbRuntime, false);
  if (fallbackFetch) return fallbackFetch;

  return {
    letterboxdRating: "N/A",
    letterboxdUrl: `https://letterboxd.com/film/${fallbackSlug}/`,
    letterboxdSlug: fallbackSlug,
    letterboxdSource: "letterboxd"
  };
}

// parses slug/year/title out of a single search result block
function parseLbSearchBlock(blockHtml) {
  const slugMatch = blockHtml.match(/data-film-slug="([^"]+)"/);
  let slug = slugMatch ? slugMatch[1].replace(/^\/film\/|\/$/g, "") : null;
  if (!slug) {
    const aMatch = blockHtml.match(/<a[^>]+href="\/film\/([^/]+)\/"/i);
    if (aMatch) slug = aMatch[1];
  }
  if (!slug) return null;
  const yearMatch = blockHtml.match(/data-release-year="(\d{4})"/);
  const year = yearMatch ? yearMatch[1] : null;
  const titleMatch = blockHtml.match(/<span[^>]*film-title-name[^>]*>([^<]+)<\/span>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : slug;
  return { slug, year, title };
}

// rebuilt with regex because domparser crashes in chrome background scripts.
// method 2 is a fallback in case Letterboxd changes their HTML class names.
function extractLetterboxdCandidates(html) {
  const candidates = [];
  const seen = new Set();

  // Method 1: <li class="... listitem ..."> (original, still the most precise)
  const liRegex = /<li[^>]*class="[^"]*listitem[^>]*>[\s\S]*?<\/li>/gi;
  let liMatch;
  while ((liMatch = liRegex.exec(html)) !== null) {
    const item = parseLbSearchBlock(liMatch[0]);
    if (item?.slug && !seen.has(item.slug)) {
      seen.add(item.slug);
      candidates.push(item);
    }
  }
  if (candidates.length) return candidates;

  // Method 2: find all data-film-slug attributes on the page and correlate with
  // the nearest data-release-year. Works even if Letterboxd renames their classes.
  console.log("[FindRatings] Listitem search found nothing, trying data-film-slug fallback.");
  const slugMatches = [...html.matchAll(/data-film-slug="([^"]+)"/g)];
  const yearMatches = [...html.matchAll(/data-release-year="(\d{4})"/g)];
  const titleMatches = [...html.matchAll(/<span[^>]*film-title-name[^>]*>([^<]+)<\/span>/gi)];

  slugMatches.forEach((sm, i) => {
    const slug = sm[1].replace(/^\/film\/|\/$/g, "");
    if (!slug || seen.has(slug)) return;
    // find the year attribute closest to this slug in the raw HTML
    const nearYear = yearMatches.reduce((best, ym) => {
      const dist = Math.abs(ym.index - sm.index);
      return !best || dist < Math.abs(best.index - sm.index) ? ym : best;
    }, null);
    const title = titleMatches[i] ? decodeHtmlEntities(titleMatches[i][1].trim()) : slug;
    seen.add(slug);
    candidates.push({ slug, year: nearYear ? nearYear[1] : null, title });
  });

  return candidates;
}

// searches letterboxd using their internal search engine url
async function fetchLetterboxdFromSearch(title, year, omdbRuntime) {
  if (!title) return null;
  const searchUrl = `https://letterboxd.com/search/films/${encodeURIComponent(title)}/`;

  try {
    const response = await fetch(searchUrl, {
      headers: { "Accept": "text/html" }
    });
    if (!response.ok) return null;

    const html = await response.text();
    const candidates = extractLetterboxdCandidates(html);
    // for debugging
    console.log(`[FindRatings] Search results for "${title}":`, candidates);

    if (!candidates.length) return null;

    // runs through the search results to find the one that matches our movie perfectly
    const selected = pickBestCandidate(candidates, title, year);
    // for debugging
    console.log(`[FindRatings] Selected candidate for "${title}" (${year}):`, selected);

    if (!selected?.slug) return null;

    // Try strict first
    const strictResult = await fetchLetterboxdFilm(selected.slug, title, year, omdbRuntime, true);
    if (strictResult) return strictResult;

    // If strict failed and we have no year, try the next few candidates in parallel
    // — the top search result is often a newer remake/series, not the film Netflix has
    if (!year) {
      const remaining = candidates.filter(c => c.slug !== selected.slug).slice(0, 3);
      if (remaining.length) {
        const fallbacks = await Promise.all(
          remaining.map(c => fetchLetterboxdFilm(c.slug, title, year, omdbRuntime, true).catch(() => null))
        );
        const hit = fallbacks.find(r => r && r.letterboxdRating !== "N/A");
        if (hit) return hit;
      }
    }

    // If strict failed but we found a candidate, try lenient (allows year mismatch)
    return fetchLetterboxdFilm(selected.slug, title, year, omdbRuntime, false);
  } catch (e) {
    console.error("[FindRatings] Search failed:", e);
    return null;
  }
}

// makes the search smart so it matches both the title and the year
// this guarantees we grab the modern lin-manuel miranda movie instead of the short film
function pickBestCandidate(candidates, expectedTitle, expectedYear) {
  if (!candidates.length) return null;

  const currentYear = new Date().getFullYear();

  // filter out future-year stubs unless we explicitly want that year
  const filtered = candidates.filter(c => !c.year || Number(c.year) <= currentYear || String(c.year) === String(expectedYear));
  if (filtered.length) candidates = filtered;

  if (expectedTitle) {
      const normExpected = normalizeTitleForCompare(expectedTitle);
      
      // 1. looks for a result with the exact same title AND exact same year
      const exact = candidates.find(c => 
         String(c.year) === String(expectedYear) && 
         normalizeTitleForCompare(c.title || "") === normExpected
      );
      if (exact) return exact;

      // 2. looks for a result with just the exact year
      if (expectedYear) {
        const yearMatch = candidates.find(c => String(c.year) === String(expectedYear));
        if (yearMatch) return yearMatch;
      }

      // 3. looks for a result with just the exact title
      const titleMatch = candidates.find(c => normalizeTitleForCompare(c.title || "") === normExpected);
      if (titleMatch) return titleMatch;
  } 

  // 4. if everything fails it just grabs the first result which letterboxd ranks by popularity
  return candidates[0];
}

// completely regex based now so it doesnt crash the service worker
function extractLetterboxdRating(html) {
  // 1. Try to parse the JSON-LD script block. This is the most reliable method.
  // We use a regex to grab the content inside <script type="application/ld+json">...</script>
  const jsonLdRegex = /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(scriptMatch[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        // Check for aggregateRating
        const rating = item?.aggregateRating?.ratingValue || item?.ratingValue;
        if (rating) return formatRating(rating);
      }
    } catch (e) {
      // ignore parse errors
    }
  }

  // 2. Fallback: Try the meta tag with name (standard)
  let match = html.match(/<meta\s+name="twitter:data2"\s+content="[^"]*?(\d+(?:\.\d+)?)/i);
  if (match && match[1]) return formatRating(match[1]);

  // 3. Fallback: JSON model (weightedAverage) - internal value
  match = html.match(/"weightedAverage"\s*:\s*([0-9.]+)/);
  if (match && match[1]) return formatRating(match[1]);

  return null;
}

function formatRating(value) {
  const num = Number(String(value).trim());
  return Number.isFinite(num) ? num.toFixed(1) : null;
}

// actually visits the letterboxd film url and checks if it's the movie we want
// omdbRuntime is the expected runtime in minutes from OMDB (or null if unavailable)
// strict=true means we enforce title+year match; after that we always check runtime if available
async function fetchLetterboxdFilm(slug, expectedTitle, expectedYear, omdbRuntime, strict) {
  if (!slug) return null;
  // for debugging
  console.log(`[FindRatings] Attempting to fetch Letterboxd page: /film/${slug}/`);
  const filmUrl = `https://letterboxd.com/film/${slug}/`;
  try {
    const filmResponse = await fetch(filmUrl, {
      headers: { "Accept": "text/html" }
    });
    if (!filmResponse.ok) return null;

    // Handle redirects (e.g. surfs-up-2007 -> surfs-up)
    const finalUrl = filmResponse.url;

    // If we got redirected to the search page, it means the slug was invalid
    if (finalUrl.includes("/search/")) {
      return null;
    }

    const finalSlugMatch = finalUrl.match(/letterboxd\.com\/film\/([^/?#]+)/);
    const finalSlug = finalSlugMatch ? finalSlugMatch[1] : slug;

    const filmHtml = await filmResponse.text();

    // checks the html on the page. if the year or title is wrong we throw it out and try the next one
    // year is ALWAYS validated regardless of strict mode — strict only controls how tight the tolerance is
    if (!isLetterboxdTitleMatch(filmHtml, expectedTitle, expectedYear, strict)) {
      // for debugging
      console.log(`[FindRatings] Title/year mismatch for slug: ${slug}. Skipping.`);
      return null;
    }

    // If we have a runtime from OMDB, check the Letterboxd runtime.
    // If it doesn't match, this is the wrong version — try numbered disambiguation slugs.
    if (omdbRuntime) {
      const lbRuntime = extractLetterboxdRuntime(filmHtml);
      console.log(`[FindRatings] Runtime check for ${slug}: OMDB=${omdbRuntime}min LB=${lbRuntime}min`);
      if (lbRuntime && !isRuntimeClose(lbRuntime, omdbRuntime)) {
        console.log(`[FindRatings] Runtime mismatch for ${slug}. Trying numbered disambiguation.`);
        // Try slug-1 through slug-5 in parallel (letterboxd uses these for same-name same-year films)
        const baseForNumbered = expectedYear ? `${slug.replace(/-\d+$/, "")}-${expectedYear}` : slug.replace(/-\d+$/, "");
        const numberedResults = await Promise.all(
          [1,2,3,4,5].map(i =>
            fetchLetterboxdFilmRaw(`${baseForNumbered}-${i}`, expectedTitle, expectedYear, omdbRuntime, strict).catch(() => null)
          )
        );
        const numberedMatch = numberedResults.find(r => r !== null);
        if (numberedMatch) return numberedMatch;
        // no numbered variant matched runtime — return null so caller can try other slug variants
        return null;
      }
    }

    // pulls the real official title off the letterboxd page using regex so we can pass it to the popup
    let actualTitle = expectedTitle;
    const ogTitleMatch = filmHtml.match(/<meta property="og:title" content="([^"]+)"/i);
    if (ogTitleMatch) {
       actualTitle = decodeHtmlEntities(ogTitleMatch[1].replace(/\s*\(\d{4}\)$/, "").trim());
    }

    let rating = extractLetterboxdRating(filmHtml);

    // for debugging
    console.log(`[FindRatings] Success for slug: ${slug}`, { actualTitle, rating });
    return {
      letterboxdRating: rating || "N/A",
      letterboxdUrl: finalUrl,
      letterboxdSlug: finalSlug,
      letterboxdSource: "letterboxd",
      letterboxdTitle: actualTitle // this is sent to the content script for display
    };
  } catch (e) {
    // for debugging
    console.error(`[FindRatings] Error fetching Letterboxd film for slug ${slug}:`, e);
    return null;
  }
}

// inner helper used by the disambiguation loop — fetches a slug and validates title+year+runtime,
// but does NOT recurse into numbered disambiguation itself to avoid infinite loops
async function fetchLetterboxdFilmRaw(slug, expectedTitle, expectedYear, omdbRuntime, strict) {
  if (!slug) return null;
  console.log(`[FindRatings] Numbered disambiguation attempt: /film/${slug}/`);
  const filmUrl = `https://letterboxd.com/film/${slug}/`;
  try {
    const filmResponse = await fetch(filmUrl, { headers: { "Accept": "text/html" } });
    if (!filmResponse.ok) return null;

    const finalUrl = filmResponse.url;
    if (finalUrl.includes("/search/")) return null;

    const finalSlugMatch = finalUrl.match(/letterboxd\.com\/film\/([^/?#]+)/);
    const finalSlug = finalSlugMatch ? finalSlugMatch[1] : slug;

    const filmHtml = await filmResponse.text();

    if (!isLetterboxdTitleMatch(filmHtml, expectedTitle, expectedYear, strict)) {
      console.log(`[FindRatings] Title/year mismatch for numbered slug: ${slug}. Skipping.`);
      return null;
    }

    // check runtime — this is the whole point of numbered disambiguation
    if (omdbRuntime) {
      const lbRuntime = extractLetterboxdRuntime(filmHtml);
      console.log(`[FindRatings] Numbered runtime check for ${slug}: OMDB=${omdbRuntime}min LB=${lbRuntime}min`);
      if (lbRuntime && !isRuntimeClose(lbRuntime, omdbRuntime)) {
        console.log(`[FindRatings] Runtime mismatch for numbered slug: ${slug}. Skipping.`);
        return null;
      }
    }

    let actualTitle = expectedTitle;
    const ogTitleMatch = filmHtml.match(/<meta property="og:title" content="([^"]+)"/i);
    if (ogTitleMatch) {
      actualTitle = decodeHtmlEntities(ogTitleMatch[1].replace(/\s*\(\d{4}\)$/, "").trim());
    }

    const rating = extractLetterboxdRating(filmHtml);
    console.log(`[FindRatings] Numbered match found: ${slug}`, { actualTitle, rating });
    return {
      letterboxdRating: rating || "N/A",
      letterboxdUrl: finalUrl,
      letterboxdSlug: finalSlug,
      letterboxdSource: "letterboxd",
      letterboxdTitle: actualTitle
    };
  } catch (e) {
    console.error(`[FindRatings] Error fetching numbered slug ${slug}:`, e);
    return null;
  }
}

// converts a title into the format letterboxd uses for urls
function slugifyLetterboxdTitle(title) {
  if (!title) return null;
  return String(title)
    .toLowerCase()
    .replace(/&/g, "and")
    // deletes all punctuation so tick, tick... boom! becomes tick tick boom perfectly
    .replace(/['’‘.,!?:;]/g, "") 
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// creates a list of possible urls to try for a movie title
function buildLetterboxdSlugVariants(title, year) {
  if (!title) return [];
  let variants = [];
  
  const add = (value) => {
    const slug = slugifyLetterboxdTitle(value);
    if (slug) variants.push(slug);
  };

  const normalizedKey = normalizeTitleForCompare(title);
  const overrides = LETTERBOXD_TITLE_OVERRIDES[normalizedKey];

  if (overrides && Array.isArray(overrides)) {
    overrides.forEach(add);
  }
  
  const base = String(title).trim();
  add(base);
  add(stripSubtitle(base));
  add(stripLeadingArticle(base));
  add(stripLeadingArticle(stripSubtitle(base)));

  // letterboxd sometimes drops "&" entirely instead of converting to "and"
  // e.g. "The Death & Life of..." → "the-death-life-of-..." not "the-death-and-life-of-..."
  if (base.includes("&")) {
    const dropAmpersand = base.replace(/\s*&\s*/g, " ");
    add(dropAmpersand);
    add(stripSubtitle(dropAmpersand));
    add(stripLeadingArticle(dropAmpersand));
    add(stripLeadingArticle(stripSubtitle(dropAmpersand)));
  }

  variants = [...new Set(variants)];

  // adds the -year suffix and puts them at the front of the line so we check exact remakes first
  if (year) {
    const yearSuffix = String(year).trim();
    if (yearSuffix) {
      const yearVariants = variants.map(slug => `${slug}-${yearSuffix}`);
      variants = [...yearVariants, ...variants];
      variants = [...new Set(variants)];
    }
  }

  return variants;
}

// manual overrides for movies with completely unguessable formatting
const LETTERBOXD_TITLE_OVERRIDES = {
  "war dogs": ["war-dogs-2016"],
  "gladiator": ["gladiator-2000"],
  "tick tick boom": ["tick-tick-boom-2021"],
  "break up": ["the-break-up"]
};

function stripSubtitle(value) {
  return String(value)
    .replace(/\s*[:–—-]\s*.*/g, "")
    .replace(/\s*\(.*?\)\s*/g, "")
    .trim();
}

function stripLeadingArticle(value) {
  return String(value).replace(/^(the|a|an)\s+/i, "").trim();
}

// the guard at the door that verifies the letterboxd page is the right movie
// entirely rewritten with regex because the domparser doesnt work in chrome background extensions
// strict=true: year tolerance ±2 (default). strict=false: year tolerance ±5 (lenient fallback).
// year is ALWAYS checked regardless of strict — only the tolerance changes.
function isLetterboxdTitleMatch(html, expectedTitle, expectedYear, strict = true) {
  if (!expectedTitle) return true;
  // for debugging
  let debugInfo = { expectedTitle, expectedYear, strict };

  let actualTitle = "";
  const ogTitleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
  if (ogTitleMatch) {
     actualTitle = ogTitleMatch[1].replace(/\s*\(\d{4}\)$/, "").trim();
  } else {
     const headlineMatch = html.match(/<h1 class="headline-1[^>]*>.*?<span[^>]*>(.*?)<\/span>.*?<\/h1>/si) ||
                           html.match(/<h1 class="headline-1[^>]*>(.*?)<\/h1>/si);
     if (headlineMatch) {
         actualTitle = headlineMatch[1].replace(/<[^>]+>/g, "").trim();
     }
  }
  actualTitle = decodeHtmlEntities(actualTitle);
  // for debugging
  debugInfo.actualTitle = actualTitle;

  const normalizedExpected = normalizeTitleForCompare(expectedTitle);
  const normalizedActual = normalizeTitleForCompare(actualTitle || "");

  // word-boundary prefix check: handles subtitle stripping ("Inception: The Story" vs "Inception")
  // but blocks short-word false matches ("break" must not match "break up")
  // the shorter side must account for at least 2 words OR be a full single-word exact match
  const expectedWords = normalizedExpected.split(" ");
  const actualWords = normalizedActual.split(" ");
  const wordsMatch = (shorter, longer) => shorter.length >= 2 && shorter.every((w, i) => w === longer[i]);
  const titleMatch =
    normalizedExpected === normalizedActual ||
    (expectedWords.length <= actualWords.length && wordsMatch(expectedWords, actualWords)) ||
    (actualWords.length < expectedWords.length && wordsMatch(actualWords, expectedWords));

  if (!titleMatch) {
    // in lenient mode, skip title check — maybe LB uses a slightly different title
    if (strict) {
      console.log("[FindRatings] Title match failed:", { ...debugInfo, normalizedExpected, normalizedActual });
      return false;
    }
  }

  if (!expectedYear) return true;

  // regex to scrape the exact year from the release date link on letterboxd
  let actualYear = null;

  // 1. Try JSON-LD (Most reliable)
  const jsonLdRegex = /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(scriptMatch[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'Movie' || item['@type'] === 'TVSeries') {
             if (item.datePublished) {
                 const m = String(item.datePublished).match(/\d{4}/);
                 if (m) { actualYear = m[0]; break; }
             }
             if (item.releasedEvent) {
                 const events = Array.isArray(item.releasedEvent) ? item.releasedEvent : [item.releasedEvent];
                 for (const e of events) {
                     if (e.startDate) {
                         const m = String(e.startDate).match(/\d{4}/);
                         if (m) { actualYear = m[0]; break; }
                     }
                 }
             }
        }
      }
    } catch (e) {}
    if (actualYear) break;
  }

  // 2. Regex fallback (releasedate span)
  if (!actualYear) {
      const releaseDateMatch = html.match(/<span class="releasedate">\s*<a[^>]*>(\d{4})<\/a>/i);
      if (releaseDateMatch) {
        actualYear = releaseDateMatch[1];
      }
  }

  // 3. Regex fallback (meta og:title with year in parens)
  if (!actualYear) {
    const ogYearMatch = html.match(/<meta property="og:title" content=".*?\((\d{4})\)"/i);
    if (ogYearMatch) actualYear = ogYearMatch[1];
  }

  // 4. Regex fallback (page <title> tag — Letterboxd format: "Movie Title (2022) - Letterboxd")
  if (!actualYear) {
    const pageTitleMatch = html.match(/<title[^>]*>.*?\((\d{4})\)[^<]*<\/title>/i);
    if (pageTitleMatch) actualYear = pageTitleMatch[1];
  }

  // for debugging
  debugInfo.actualYear = actualYear;

  // if we genuinely can't extract a year, give benefit of the doubt only in strict mode
  // in lenient mode we still give benefit of the doubt (we've already loosened tolerance)
  if (!actualYear) return true;

  // strict=true: allow ±2 years (festival vs wide release dates)
  // strict=false: allow ±5 years (lenient fallback, but still blocks a 23-year mismatch like 1999 vs 2022)
  const tolerance = strict ? 2 : 5;
  const diff = Math.abs(Number(actualYear) - Number(expectedYear));
  const yearMatch = diff <= tolerance;
  if (!yearMatch) console.log("[FindRatings] Year match failed:", { ...debugInfo, diff, tolerance });
  return yearMatch;
}

function normalizeTitleForCompare(title) {
  return String(title)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(the|a|an)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// -------------------------------------------------------------
// EVERYTHING BELOW THIS LINE IS YOUR RESTORED RUNTIME/IMDB/TMDB LOGIC
// -------------------------------------------------------------

// custom html parser that doesnt crash if domparser is missing
function parseHtml(html) {
  try {
    if (typeof DOMParser !== 'undefined') {
      return new DOMParser().parseFromString(html, "text/html");
    }
    return null;
  } catch {
    return null;
  }
}

function extractLetterboxdRuntime(html) {
  const doc = parseHtml(html);
  if (doc) {
    const jsonLdScripts = [...doc.querySelectorAll('script[type="application/ld+json"]')];
    for (const script of jsonLdScripts) {
      const text = script.textContent?.trim();
      if (!text) continue;
      try {
        const data = JSON.parse(text);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const duration = item?.duration || item?.itemReviewed?.duration;
          const minutes = parseRuntimeMinutes(duration);
          if (minutes) return minutes;
        }
      } catch {
        // ignore
      }
    }

    const runtimeText =
      doc.querySelector(".film-header-lockup .text-sluglist .text-link")?.textContent ||
      doc.querySelector(".text-sluglist")?.textContent ||
      "";
    const minutes = parseRuntimeMinutes(runtimeText);
    if (minutes) return minutes;
  }

  // regex fallback
  const isoMatch = html.match(/"duration"\s*:\s*"([^"]+)"/);
  if (isoMatch?.[1]) {
    const minutes = parseRuntimeMinutes(isoMatch[1]);
    if (minutes) return minutes;
  }

  return null;
}

function parseRuntimeMinutes(value) {
  if (!value) return null;
  const text = String(value).toLowerCase();
  const isoMatch = text.match(/pt(?:(\d+)h)?(?:(\d+)m)?/i);
  if (isoMatch) {
    const hours = isoMatch[1] ? Number(isoMatch[1]) : 0;
    const mins = isoMatch[2] ? Number(isoMatch[2]) : 0;
    const total = hours * 60 + mins;
    return Number.isFinite(total) && total > 0 ? total : null;
  }

  const hourMatch = text.match(/(\d+)\s*h/);
  const minMatch = text.match(/(\d+)\s*m/);
  if (hourMatch || minMatch) {
    const hours = hourMatch ? Number(hourMatch[1]) : 0;
    const mins = minMatch ? Number(minMatch[1]) : 0;
    const total = hours * 60 + mins;
    return Number.isFinite(total) && total > 0 ? total : null;
  }

  const minOnly = text.match(/(\d+)\s*min/);
  if (minOnly) {
    const total = Number(minOnly[1]);
    return Number.isFinite(total) && total > 0 ? total : null;
  }

  return null;
}

function isRuntimeClose(actualMinutes, expectedMinutes) {
  if (!actualMinutes || !expectedMinutes) return false;
  return Math.abs(Number(actualMinutes) - Number(expectedMinutes)) <= 2;
}

// scrapes imdb for the rating if we ever need it as a fallback
async function fetchImdbScrape(title, year) {
  const imdbID = await fetchImdbIdFromSearch(title, year);
  if (!imdbID) return null;

  const titleUrl = `https://www.imdb.com/title/${imdbID}/`;
  const titleResponse = await fetch(titleUrl, {
    headers: {
      "Accept": "text/html",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  if (!titleResponse.ok) return null;
  const titleHtml = await titleResponse.text();
  const rating = extractImdbRating(titleHtml);
  const imdbYear = extractImdbYear(titleHtml);

  return {
    imdbRating: rating || "N/A",
    imdbYear: imdbYear || null,
    imdbID,
    imdbUrl: titleUrl
  };
}

function extractImdbId(href) {
  const match = href.match(/\/title\/(tt\d+)/);
  return match?.[1] || null;
}

// this part scrapes the imdb rating out of the hidden json data on their site
function extractImdbRating(html) {
  const doc = parseHtml(html);
  if (doc) {
    const jsonLdScripts = [...doc.querySelectorAll('script[type="application/ld+json"]')];
    for (const script of jsonLdScripts) {
      const text = script.textContent?.trim();
      if (!text) continue;
      const rating = extractImdbRatingFromJsonLd(text);
      if (rating) return rating;
    }

    const ratingEl =
      doc.querySelector('[data-testid="hero-rating-bar__aggregate-rating__score"] span') ||
      doc.querySelector('[data-testid="hero-rating-bar__aggregate-rating__score"]') ||
      doc.querySelector('span[itemprop="ratingValue"]');
    const ratingText = ratingEl?.textContent?.trim();
    if (ratingText) return ratingText;

    const metaRating = doc.querySelector('meta[itemprop="ratingValue"]')?.getAttribute("content");
    if (metaRating) return metaRating;

    const ogDescription = doc.querySelector('meta[property="og:description"]')?.getAttribute("content");
    const ogMatch = ogDescription?.match(/([0-9.]+)\/10/);
    if (ogMatch?.[1]) return ogMatch[1];

    const nextData = doc.querySelector("script#__NEXT_DATA__")?.textContent;
    const nextRating = extractImdbRatingFromNextData(nextData);
    if (nextRating) return nextRating;
  }

  // regex fallbacks for the background script
  const regexMatch = html.match(/"aggregateRating"\s*:\s*{[^}]*"ratingValue"\s*:\s*"?([0-9.]+)"?/);
  if (regexMatch?.[1]) return regexMatch[1];

  const fallbackMatch = html.match(/ratingValue["']?\s*[:=]\s*"?([0-9.]+)"?/);
  if (fallbackMatch?.[1]) return fallbackMatch[1];

  return null;
}

function extractImdbRatingFromJsonLd(text) {
  try {
    const data = JSON.parse(text);
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      const rating = item?.aggregateRating?.ratingValue || item?.ratingValue;
      if (rating) return String(rating);
    }
  } catch {
    // ignore
  }
  return null;
}

function extractImdbRatingFromNextData(text) {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    const rating =
      data?.props?.pageProps?.aboveTheFoldData?.ratingsSummary?.aggregateRating ||
      data?.props?.pageProps?.mainColumnData?.ratingsSummary?.aggregateRating;
    if (rating) return String(rating);
  } catch {
    // ignore
  }
  return null;
}

function extractImdbYear(html) {
  const doc = parseHtml(html);
  if (doc) {
    const yearLink = doc.querySelector('a[href^="/year/"]');
    const yearText = yearLink?.textContent?.trim();
    if (yearText && /^\d{4}$/.test(yearText)) {
      return yearText;
    }

    const metaYear = doc.querySelector('meta[itemprop="datePublished"]')?.getAttribute("content");
    if (metaYear) {
      const match = metaYear.match(/\d{4}/);
      if (match?.[0]) return match[0];
    }

    const jsonLdScripts = [...doc.querySelectorAll('script[type="application/ld+json"]')];
    for (const script of jsonLdScripts) {
      const text = script.textContent?.trim();
      if (!text) continue;
      try {
        const data = JSON.parse(text);
        const candidates = Array.isArray(data) ? data : [data];
        for (const item of candidates) {
          const date = item?.datePublished || item?.dateCreated || item?.releasedEvent?.startDate;
          if (date) {
            const match = String(date).match(/\d{4}/);
            if (match?.[0]) return match[0];
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // regex fallback
  const regexMatch = html.match(/"datePublished"\s*:\s*"(\d{4})/);
  if (regexMatch?.[1]) return regexMatch[1];

  return null;
}

async function fetchImdbIdFromSearch(title, year) {
  const normalized = String(title || "").trim();
  if (!normalized) return null;

  const searchParams = new URLSearchParams({
    q: normalized,
    s: "tt",
    ttype: "ft"
  });

  const searchResponse = await fetch(`https://www.imdb.com/find/?${searchParams.toString()}`, {
    headers: { "Accept": "text/html" }
  });
  if (!searchResponse.ok) return null;
  const searchHtml = await searchResponse.text();
  const searchDoc = parseHtml(searchHtml);
  
  const desiredYear = year ? Number(year) : null;
  const candidates = [];

  if (searchDoc) {
    searchDoc.querySelectorAll('a[href^="/title/tt"]').forEach((link) => {
      const href = link.getAttribute("href") || "";
      const imdbID = extractImdbId(href);
      if (!imdbID) return;

      const container =
        link.closest(".findResult") ||
        link.closest(".ipc-metadata-list-summary-item") ||
        link.closest("li") ||
        link.parentElement;
      const text = container?.textContent || "";
      const yearMatch = text.match(/\b(19|20)\d{2}\b/);
      const foundYear = yearMatch ? Number(yearMatch[0]) : null;
      candidates.push({ imdbID, year: foundYear });
    });
  } else {
    // regex fallback for background script
    const idRegex = /href="\/title\/(tt\d+)\/[^>]*>(.*?)<\/a>/gi;
    let m;
    while ((m = idRegex.exec(searchHtml)) !== null) {
       const id = m[1];
       const text = m[2];
       const yearMatch = text.match(/\b(19|20)\d{2}\b/);
       candidates.push({ imdbID: id, year: yearMatch ? Number(yearMatch[0]) : null });
    }
  }

  if (!candidates.length) return null;
  if (!desiredYear) return candidates[0].imdbID;

  const exact = candidates.find((c) => c.year === desiredYear);
  return exact?.imdbID || candidates[0].imdbID;
}

function buildImdbSearchUrl(title, year) {
  const params = new URLSearchParams({
    q: title,
    s: "tt",
    ttype: "ft"
  });
  if (year) {
    params.set("y", String(year));
  }
  return `https://www.imdb.com/find/?${params.toString()}`;
}

// tmdb logic just in case letterboxd and omdb both fail
async function fetchTmdb(title, year) {
  if (!TMDB_API_KEY || TMDB_API_KEY === "YOUR_TMDB_API_KEY") {
    return null;
  }

  const params = new URLSearchParams({
    api_key: TMDB_API_KEY,
    query: title
  });
  if (year) {
    params.set("year", String(year));
  }

  const response = await fetch(`https://api.themoviedb.org/3/search/movie?${params.toString()}`);
  const data = await response.json();
  const result = data?.results?.[0];
  if (!result) {
    return null;
  }

  const ratingOutOfFive = result.vote_average ? (result.vote_average / 2).toFixed(1) : null;

  return {
    letterboxdRating: ratingOutOfFive || "N/A",
    letterboxdUrl: result.id ? `https://www.themoviedb.org/movie/${result.id}` : null,
    letterboxdSlug: null,
    letterboxdSource: "tmdb"
  };
}

function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'");
}