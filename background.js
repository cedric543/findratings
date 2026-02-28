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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // basic security check to make sure netflix didn't accidentally send us a massive string or code
  if (message?.type === "FETCH_RATINGS") {
    if (typeof message.title !== 'string' || message.title.length > 200) {
      return false; 
    }
    
    fetchRatings(message.title, message.year)
      .then((data) => sendResponse({ ok: true, data }))
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
  const rawTitle = title;
  let rawYear = year;

  // fix for tick tick boom. if netflix gives us no year we ask omdb for the most recent one
  // before we search letterboxd so we dont accidentally grab a random short film from 2001
  if (!rawYear || rawYear === "undefined" || rawYear === "N/A") {
    const omdbData = await fetchOmdbBySearch(rawTitle, null, null);
    if (omdbData && omdbData.Year) {
      rawYear = omdbData.Year.replace(/[^\d]/g, ""); 
    }
  }

  let letterboxd = await fetchLetterboxd(rawTitle, rawYear);

  return {
    // we use the real title from the letterboxd page so the popup is completely accurate
    title: letterboxd?.letterboxdTitle || rawTitle,
    year: rawYear,
    letterboxdRating: letterboxd?.letterboxdRating || "N/A",
    letterboxdUrl: letterboxd?.letterboxdUrl || null,
    letterboxdSlug: letterboxd?.letterboxdSlug || null,
    letterboxdSource: letterboxd?.letterboxdSource || null
  };
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

  // sorts the results by year so we get modern movies first instead of old black and white ones
  results.sort((a, b) => parseInt(b.Year || "0") - parseInt(a.Year || "0"));

  const desiredYear = year ? String(year) : null;
  let best = null;

  for (const item of results) {
    if (!item?.imdbID) continue;
    const detailParams = new URLSearchParams({
      i: item.imdbID,
      apikey: OMDB_API_KEY
    });
    const detailResponse = await fetch(`https://www.omdbapi.com/?${detailParams.toString()}`);
    const detail = await detailResponse.json();
    if (detail?.Response !== "True") continue;

    const matchesYear = !desiredYear || String(detail?.Year) === desiredYear;
    const runtimeMinutes = parseRuntimeMinutes(detail?.Runtime);
    const matchesRuntime = !runtime || (runtimeMinutes && isRuntimeClose(runtimeMinutes, runtime));

    if (matchesYear && matchesRuntime) {
      return detail;
    }

    if (!best) {
      best = detail;
    }
  }

  return best;
}

// main letterboxd hub. it tries guessing the exact url first to be fast
// if that fails it relies on searching
async function fetchLetterboxd(title, year) {
  if (!year || year === "undefined" || year === "N/A") {
    const fromSearch = await fetchLetterboxdFromSearch(title, year);
    if (fromSearch) return fromSearch;
  }

  const variants = buildLetterboxdSlugVariants(title, year);
  if (!variants.length) {
    return null;
  }

  for (const slug of variants) {
    const resolved = await fetchLetterboxdFilm(slug, title, year, true);
    if (resolved) return resolved;
  }

  // fallback to search if the url guessing failed for some reason
  const fromSearch = await fetchLetterboxdFromSearch(title, year);
  if (fromSearch) return fromSearch;

  const fallbackSlug = variants[0];
  return {
    letterboxdRating: "N/A",
    letterboxdUrl: `https://letterboxd.com/film/${fallbackSlug}/`,
    letterboxdSlug: fallbackSlug,
    letterboxdSource: "letterboxd"
  };
}

// rebuilt this with regex because domparser crashes in chrome background scripts
function extractLetterboxdCandidates(html) {
  const candidates = [];
  const seen = new Set();
  
  // isolates each list item in the search results
  const liRegex = /<li[^>]*class="[^"]*listitem[^>]*>(.*?)<\/li>/gis;
  let liMatch;
  while ((liMatch = liRegex.exec(html)) !== null) {
      const liHtml = liMatch[1];
      
      const slugMatch = liHtml.match(/data-film-slug="([^"]+)"/);
      let slug = slugMatch ? slugMatch[1].replace(/^\/film\/|\/$/g, "") : null;
      
      if (!slug) {
          const aMatch = liHtml.match(/<a[^>]+href="\/film\/([^/]+)\/"/i);
          if (aMatch) slug = aMatch[1];
      }

      const yearMatch = liHtml.match(/data-release-year="(\d{4})"/);
      const year = yearMatch ? yearMatch[1] : null;

      const titleMatch = liHtml.match(/<span class="film-title-name">([^<]+)<\/span>/i);
      const title = titleMatch ? titleMatch[1].trim() : slug;

      if (slug && !seen.has(slug)) {
          seen.add(slug);
          candidates.push({ slug, year, title });
      }
  }
  return candidates;
}

// searches letterboxd using their internal search engine url
async function fetchLetterboxdFromSearch(title, year) {
  if (!title) return null;
  const searchUrl = `https://letterboxd.com/search/films/${encodeURIComponent(title)}/`;
  
  try {
    const response = await fetch(searchUrl, {
      headers: { "Accept": "text/html" }
    });
    if (!response.ok) return null;
    
    const html = await response.text();
    const candidates = extractLetterboxdCandidates(html);
    if (!candidates.length) return null;

    // runs through the search results to find the one that matches our movie perfectly
    const selected = pickBestCandidate(candidates, title, year);
    if (!selected?.slug) return null;
    
    return fetchLetterboxdFilm(selected.slug, title, year, true);
  } catch (e) {
    return null;
  }
}

// makes the search smart so it matches both the title and the year
// this guarantees we grab the modern lin-manuel miranda movie instead of the short film
function pickBestCandidate(candidates, expectedTitle, expectedYear) {
  if (!candidates.length) return null;

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
  const averageMatch = html.match(/<meta name="twitter:data2" content="([0-9.]+)"/i) || 
                       html.match(/data-average-rating="([0-9.]+)"/i) ||
                       html.match(/"ratingValue"\s*:\s*"?([0-9.]+)"?/i);
  
  if (averageMatch && averageMatch[1]) {
    const num = Number(String(averageMatch[1]).trim());
    return Number.isFinite(num) ? num.toFixed(1) : null;
  }
  return null;
}

// actually visits the letterboxd film url and checks if it's the movie we want
async function fetchLetterboxdFilm(slug, expectedTitle, expectedYear, strict) {
  if (!slug) return null;
  const filmUrl = `https://letterboxd.com/film/${slug}/`;
  try {
    const filmResponse = await fetch(filmUrl, {
      headers: { "Accept": "text/html" }
    });
    if (!filmResponse.ok) return null;
    
    const filmHtml = await filmResponse.text();
    
    // checks the html on the page. if the year or title is wrong we throw it out and try the next one
    if (strict && !isLetterboxdTitleMatch(filmHtml, expectedTitle, expectedYear)) {
      return null;
    }

    // pulls the real official title off the letterboxd page using regex so we can pass it to the popup
    let actualTitle = expectedTitle;
    const ogTitleMatch = filmHtml.match(/<meta property="og:title" content="([^"]+)"/i);
    if (ogTitleMatch) {
       actualTitle = ogTitleMatch[1].replace(/\s*\(\d{4}\)$/, "").trim();
    }

    let rating = extractLetterboxdRating(filmHtml);

    return {
      letterboxdRating: rating || "N/A",
      letterboxdUrl: filmUrl,
      letterboxdSlug: slug,
      letterboxdSource: "letterboxd",
      letterboxdTitle: actualTitle // this is sent to the content script for display
    };
  } catch (e) {
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
  "tick tick boom": ["tick-tick-boom-2021"]
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
function isLetterboxdTitleMatch(html, expectedTitle, expectedYear) {
  if (!expectedTitle) return true;

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

  const normalizedExpected = normalizeTitleForCompare(expectedTitle);
  const normalizedActual = normalizeTitleForCompare(actualTitle || "");

  const titleMatch =
    normalizedExpected === normalizedActual ||
    normalizedExpected.startsWith(normalizedActual) ||
    normalizedActual.startsWith(normalizedExpected);

  if (!titleMatch) return false;
  if (!expectedYear) return true;

  // regex to scrape the exact year from the release date link on letterboxd
  let actualYear = null;
  const releaseDateMatch = html.match(/<span class="releasedate">\s*<a[^>]*>(\d{4})<\/a>/i);
  if (releaseDateMatch) {
    actualYear = releaseDateMatch[1];
  } else {
    const ogYearMatch = html.match(/<meta property="og:title" content=".* \((\d{4})\)"/i);
    if (ogYearMatch) actualYear = ogYearMatch[1];
  }

  if (!actualYear) return true; 

  // allow a 1 year gap for weird distribution dates
  const diff = Math.abs(Number(actualYear) - Number(expectedYear));
  return diff <= 1; 
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