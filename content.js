(() => {
  // how long you hover before it triggers
  const HOVER_DELAY = 200;
  // set to 0 so the physical mouse checker kills the popup instantly
  const HIDE_DELAY = 0; 
  // nudges the popup so it doesnt cover the netflix play button
  const EXTRA_OFFSET = isNetflix() ? 80 : 30;

  // the safe html elements your mouse can touch. we include bob-card 
  // so netflix's video preview doesn't accidentally trigger a close
  const SAFE_ZONES = ".title-card-container, .title-card, .bob-card, .previewModal--wrapper, .previewModal--container, #findratings-card, .gv2-asset-link";

  if (!isNetflix() && !isDisney()) {
    return;
  }
  // only run this on movie genre pages so it doesnt break other parts of netflix
  if (isNetflix() && !isNetflixBrowseGenre()) {
    return;
  } 

  const TILE_SELECTOR = isNetflix() ? ".title-card" : ".gv2-asset-link";
  const seenTiles = new WeakSet();
  const ratingsCache = new Map();

  let hoverTimer = null;
  let hideTimer = null;
  let activeTile = null;
  let requestToken = 0;
  let card = null;
  let isTileHovered = false;
  let isCardHovered = false;
  let lastPointer = { x: 0, y: 0 };
  let activeTileRect = null;
  
  // caches the giant netflix script block so we dont freeze the browser searching it every time
  let netflixCacheHtml = ""; 

  ensureCard();
  observeTiles();
  scanExistingTiles();

  function isNetflix() {
    return location.hostname.includes("netflix.com");
  }

  function isDisney() {
    return location.hostname.includes("disneyplus.com");
  }

  function isNetflixBrowseGenre() {
    if (!location.pathname.startsWith("/browse/genre/")) return false;
    const id = location.pathname.split("/browse/genre/")[1]?.split(/[/?#]/)[0];
    const params = new URLSearchParams(location.search);
    const bc = params.get("bc");
    return bc === "34399" || id === "34399";
  }

  // builds the physical box
  function ensureCard() {
    if (document.getElementById("findratings-card")) {
      return;
    }

    card = document.createElement("div");
    card.id = "findratings-card";
    card.className = "fr-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-hidden", "true");

    card.innerHTML = `
      <div class="fr-title" id="fr-title">Loading…</div>
      <div class="fr-meta" id="fr-meta"></div>
      <div class="fr-ratings">
        <a class="fr-rating fr-letterboxd" id="fr-letterboxd" href="#" target="_blank" rel="noopener noreferrer">Letterboxd: --</a>
      </div>
      <button class="fr-log" id="fr-log" type="button">Open on Letterboxd</button>
      <div class="fr-footnote" id="fr-footnote"></div>
    `;

    // if your mouse is on the popup keep it alive so you can click the button
    card.addEventListener("mouseenter", () => {
      isCardHovered = true;
      clearTimeout(hideTimer);
    });

    card.addEventListener("mouseleave", () => {
      isCardHovered = false;
      scheduleHide();
    });

    const logButton = card.querySelector("#fr-log");
    logButton.addEventListener("click", () => {
      const url = logButton.dataset.url;
      if (!url) return;
      chrome.runtime.sendMessage({ type: "OPEN_TAB", url });
    });

    waitForBody(() => {
      document.body.appendChild(card);
    });

    // keeps popup locked to the tile if you scroll
    window.addEventListener("scroll", () => {
      if (card?.classList.contains("is-visible") && activeTile) {
        positionCard(activeTile);
      }
    }, { passive: true });

    window.addEventListener("resize", () => {
      if (card?.classList.contains("is-visible") && activeTile) {
        positionCard(activeTile);
      }
    });

    // the master pixel tracker that fixes the sticky popup problem
    window.addEventListener(
      "mousemove",
      (event) => {
        lastPointer = { x: event.clientX, y: event.clientY };
        
        if (card && card.classList.contains("is-visible")) {
          const el = document.elementFromPoint(lastPointer.x, lastPointer.y);
          const isSafe = el && el.closest(SAFE_ZONES);
          
          if (isSafe) {
            clearTimeout(hideTimer);
          } else {
            scheduleHide();
          }
        }
      },
      { passive: true }
    );
  }

  function waitForBody(callback) {
    if (document.body) {
      callback();
      return;
    }
    requestAnimationFrame(() => waitForBody(callback));
  }

  // watches for netflix loading new movies as you scroll down
  function observeTiles() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches?.(TILE_SELECTOR)) {
            registerTile(node);
          }
          node.querySelectorAll?.(TILE_SELECTOR).forEach(registerTile);
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function scanExistingTiles() {
    document.querySelectorAll(TILE_SELECTOR).forEach(registerTile);
  }

  function registerTile(tile) {
    if (seenTiles.has(tile)) return;
    seenTiles.add(tile);

    tile.addEventListener("mouseenter", handleEnter);
    tile.addEventListener("mouseleave", handleLeave);
    tile.addEventListener("focusin", handleEnter);
    tile.addEventListener("focusout", handleLeave);
  }

  function handleEnter(event) {
    clearTimeout(hideTimer);
    clearTimeout(hoverTimer);

    activeTile = event.currentTarget;
    activeTileRect = activeTile?.getBoundingClientRect?.() || null;
    isTileHovered = true;
    hoverTimer = setTimeout(() => {
      showCard(activeTile);
    }, HOVER_DELAY);
  }

  function handleLeave() {
    clearTimeout(hoverTimer);
    isTileHovered = false;
    activeTileRect = null;
    scheduleHide();
  }

  // runs the pixel check one last time before destroying the popup
  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!card) return;
      const el = document.elementFromPoint(lastPointer.x, lastPointer.y);
      const isSafe = el && el.closest(SAFE_ZONES);
      
      if (!isSafe) {
        hideCard();
      }
    }, HIDE_DELAY);
  }

  function hideCard() {
    if (!card) return;
    card.classList.remove("is-visible");
    card.setAttribute("aria-hidden", "true");
    activeTile = null;
    activeTileRect = null;
    isTileHovered = false;
    isCardHovered = false;
  }

  async function showCard(tile) {
    if (!tile || !card) return;
    if (isNetflix() && !isNetflixBrowseGenre()) {
      hideCard();
      return;
    }

    const meta = extractTitleYear(tile);
    console.log("sending to background:", meta.title, "year:", meta.year);
    
    if (!meta?.title) {
      hideCard();
      return;
    }

    // stops the box from showing the wrong movie if you swipe your mouse super fast
    const token = ++requestToken;
    updateCardLoading(meta);
    card.classList.add("is-visible");
    card.setAttribute("aria-hidden", "false");
    card.style.visibility = "hidden";

    requestAnimationFrame(() => {
      card.style.visibility = "visible";
      positionCard(tile);
    });

    try {
      const ratings = await getRatings(meta);
      if (token !== requestToken) return;
      updateCard(meta, ratings);
      positionCard(tile);
    } catch (error) {
      if (token !== requestToken) return;
      updateCardError(meta);
    }
  }

  function updateCardLoading(meta) {
    card.querySelector("#fr-title").textContent = meta.title;
    card.querySelector("#fr-meta").textContent = meta.year ? String(meta.year) : "";
    setLinkState(card.querySelector("#fr-letterboxd"), "Letterboxd: …", null);
    const logButton = card.querySelector("#fr-log");
    logButton.disabled = true;
    logButton.dataset.url = "";
    card.querySelector("#fr-footnote").textContent = "fetching ratings…";
  }

  // fallback to kill the popup if netflix changes the page url in the background
  setInterval(() => {
    if (isNetflix() && !isNetflixBrowseGenre() && card?.classList.contains("is-visible")) {
      hideCard();
    }
  }, 500);

  function updateCard(meta, ratings) {
    const titleEl = card.querySelector("#fr-title");
    const metaEl = card.querySelector("#fr-meta");
    
    // shows the actual letterboxd title so you know what movie it grabbed
    titleEl.textContent = ratings.title || meta.title;
    metaEl.textContent = ratings.year || meta.year || "";

    const letterboxdLabel = ratings.letterboxdSource === "tmdb"
      ? `Letterboxd (TMDB): ${ratings.letterboxdRating || "N/A"}`
      : `Letterboxd: ${ratings.letterboxdRating || "N/A"}`;
    setLinkState(card.querySelector("#fr-letterboxd"), letterboxdLabel, ratings.letterboxdUrl);

    const logButton = card.querySelector("#fr-log");
    if (ratings.letterboxdUrl) {
      logButton.disabled = false;
      logButton.dataset.url = ratings.letterboxdUrl;
    } else {
      logButton.disabled = true;
      logButton.dataset.url = "";
    }

    const footnote = card.querySelector("#fr-footnote");
    footnote.textContent = ratings.letterboxdSource === "tmdb"
      ? "letterboxd score unavailable; showing tmdb rating." : "";
  }

  function updateCardError(meta) {
    card.querySelector("#fr-title").textContent = meta.title;
    card.querySelector("#fr-meta").textContent = meta.year ? String(meta.year) : "";
    setLinkState(card.querySelector("#fr-letterboxd"), "Letterboxd: N/A", null);
    card.querySelector("#fr-footnote").textContent = "ratings unavailable.";
  }

  function setLinkState(el, label, url) {
    el.textContent = label;
    if (url) {
      el.href = url;
      el.classList.remove("is-disabled");
      el.setAttribute("tabindex", "0");
    } else {
      el.href = "#";
      el.classList.add("is-disabled");
      el.setAttribute("tabindex", "-1");
    }
  }

  // does the math to flip the popup above or below the movie depending on screen space
  function positionCard(tile) {
    if (!card || !tile) return;

    const rect = getStableRect(tile);
    const cardRect = card.getBoundingClientRect();
    const margin = 12;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const needsBelow = cardRect.height + EXTRA_OFFSET;

    let top;
    if (spaceBelow >= needsBelow || spaceBelow >= spaceAbove) {
      top = rect.bottom + margin + EXTRA_OFFSET;
    } else {
      top = rect.top - margin - EXTRA_OFFSET - cardRect.height;
    }

    let left = rect.left + rect.width / 2 - cardRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - cardRect.width - margin));

    card.style.top = `${top + window.scrollY}px`;
    card.style.left = `${left + window.scrollX}px`;
  }

  function getStableRect(tile) {
    const rect = tile.getBoundingClientRect();
    const width = tile.offsetWidth || rect.width;
    const height = tile.offsetHeight || rect.height;
    const left = rect.left + (rect.width - width) / 2;
    const top = rect.top + (rect.height - height) / 2;

    return {
      left, top, width, height,
      right: left + width,
      bottom: top + height
    };
  }

  function isPointerOverTile() {
    const { x, y } = lastPointer || {};
    if (typeof x !== "number" || typeof y !== "number") return false;
    const el = document.elementFromPoint(x, y);
    return !!(el && el.closest && el.closest(TILE_SELECTOR));
  }

  function isPointerOverCard() {
    const { x, y } = lastPointer || {};
    if (typeof x !== "number" || typeof y !== "number") return false;
    const el = document.elementFromPoint(x, y);
    return !!(el && card && (el === card || card.contains(el)));
  }

  function isPointerInTileRect() {
    if (!activeTileRect) return false;
    const { x, y } = lastPointer || {};
    if (typeof x !== "number" || typeof y !== "number") return false;
    return (
      x >= activeTileRect.left && x <= activeTileRect.right &&
      y >= activeTileRect.top && y <= activeTileRect.bottom
    );
  }

  function isTileHoverActive() {
    if (!activeTile) return false;
    try { return activeTile.matches(":hover"); } catch { return false; }
  }

  function isNetflixHoverLive() {
    if (!isNetflix()) return false;
    const live = document.querySelector('.screenReaderMessage[role="alert"][aria-live="assertive"]');
    if (!live) return false;
    const text = live.textContent?.trim();
    return !!text;
  }

  function isPointerOverNetflixHover() {
    if (!isNetflix()) return false;
    const { x, y } = lastPointer || {};
    if (typeof x !== "number" || typeof y !== "number") return false;
    const el = document.elementFromPoint(x, y);
    if (!el) return false;
    return !!el.closest(".bob-card, .title-card-hover, .previewModal--wrapper, .previewModal--container, .previewModal--details, .title-card-container");
  }

  async function getRatings(meta) {
    const cacheKey = `${meta.title}::${meta.year || ""}`;
    if (ratingsCache.has(cacheKey)) return ratingsCache.get(cacheKey);

    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "FETCH_RATINGS", title: meta.title, year: meta.year },
        (res) => resolve(res)
      );
    });

    if (!response?.ok) throw new Error(response?.error || "failed to fetch ratings");

    ratingsCache.set(cacheKey, response.data);
    return response.data;
  }

  function extractTitleYear(tile) {
    const candidates = new Set();

    const pushCandidate = (value) => {
      if (!value) return;
      const cleaned = cleanCandidate(value);
      if (cleaned && cleaned.length >= 2) candidates.add(cleaned);
    };

    // check every attribute because netflix moves the title around
    const attrNames = ["aria-label", "alt", "title", "data-title", "data-item-title"];
    attrNames.forEach((attr) => pushCandidate(tile.getAttribute(attr)));

    tile.querySelectorAll("[aria-label],[alt],[title]").forEach((node) => {
      attrNames.forEach((attr) => pushCandidate(node.getAttribute(attr)));
    });

    const textSnippets = [
      tile.textContent,
      tile.querySelector("img")?.alt,
      tile.querySelector("img")?.getAttribute("aria-label")
    ];
    textSnippets.forEach(pushCandidate);

    const best = pickBestCandidate([...candidates]);
    const { title, year: parsedYear } = parseTitleYear(best);

    const yearFromData =
      tile.getAttribute("data-release-year") ||
      tile.getAttribute("data-year") ||
      tile.dataset?.releaseYear ||
      tile.dataset?.year;

    // searches netflix's hidden script database for the exact year
    let exactNetflixYear = null;
    if (isNetflix()) {
      const videoId = getNetflixVideoId(tile);
      if (videoId) {
        exactNetflixYear = getNetflixYearById(videoId);
      }
    }

    const yearFromHover = (exactNetflixYear || yearFromData) ? null : getNetflixHoverYear();

    return {
      title,
      // always trust the exact database year first
      year: exactNetflixYear || yearFromData || yearFromHover || parsedYear || undefined
    };
  }

  function getNetflixVideoId(tile) {
    const ptrack = tile.closest('.ptrack-content') || tile.querySelector('.ptrack-content');
    if (ptrack) {
      const ctx = ptrack.getAttribute('data-ui-tracking-context');
      if (ctx) {
        try {
          const decoded = JSON.parse(decodeURIComponent(ctx));
          if (decoded.video_id) return decoded.video_id;
        } catch(e) {}
      }
    }
    const link = tile.nodeName === 'A' ? tile : tile.querySelector('a[href^="/watch/"]');
    if (link) {
      const match = link.getAttribute('href').match(/\/watch\/(\d+)/);
      if (match) return match[1];
    }
    return null;
  }

  function getNetflixYearById(videoId) {
    if (!netflixCacheHtml) {
      const scripts = Array.from(document.querySelectorAll('script'));
      netflixCacheHtml = scripts.map(s => s.textContent).join(" ");
    }
    const regex = new RegExp(`"videoId":${videoId}[^}]*"releaseYear":(\\d{4})`);
    const match = netflixCacheHtml.match(regex);
    if (match && match[1]) return match[1];
    return null;
  }

  // FIX: the lego batman movie bug
  // we changed the regex to only delete "movie" if it is in parentheses
  function cleanCandidate(value) {
    return String(value)
      .replace(/\s+/g, " ")
      .replace(/^(Play|Watch)\s+/i, "")
      .replace(/\s*\((Series|Movie|TV)\)\s*$/i, "") // only removes if it looks like (Movie)
      .replace(/\s*\(HD\)\s*$/i, "")
      .trim();
  }

  function pickBestCandidate(candidates) {
    if (!candidates.length) return "";
    return candidates.sort((a, b) => b.length - a.length)[0];
  }

  function parseTitleYear(candidate) {
    if (!candidate) return { title: "", year: undefined };

    const yearMatch = candidate.match(/^(.*?)(?:\s*\(|\s*,\s*)(\d{4})/);
    if (yearMatch) {
      return {
        title: yearMatch[1].trim(),
        year: yearMatch[2]
      };
    }

    const trimmed = candidate.replace(/\s*\([^)]*\)\s*$/g, "").trim();
    return { title: trimmed, year: undefined };
  }

  function getNetflixHoverYear() {
    if (!isNetflix()) return null;
    const hover =
      document.querySelector(".previewModal--wrapper.detail-modal[aria-modal=\"true\"]") ||
      document.querySelector(".previewModal--container.detail-modal") ||
      document.querySelector(".bob-card");
    if (!hover) return null;

    const yearEl =
      hover.querySelector(".previewModal--detailsMetadata .year") ||
      hover.querySelector(".videoMetadata--line .year") ||
      hover.querySelector(".year") ||
      hover.querySelector("[data-release-year]") ||
      hover.querySelector("[data-year]");
    const yearText = yearEl?.textContent || hover.textContent || "";
    const match = yearText.match(/\b(19|20)\d{2}\b/);
    return match ? match[0] : null;
  }
})();