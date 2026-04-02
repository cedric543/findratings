# findratings

A Chrome extension that displays Letterboxd ratings in real-time hover popups while browsing movies on Netflix and Disney+.

## Features

- **Instant ratings**: Hover over any movie tile on Netflix or Disney+ to see its Letterboxd rating in a popup
- **Smart title matching**: 99%+ accuracy in resolving films, even with duplicate titles, missing years, and ambiguous metadata
- **Multiple rating sources**: Primary lookup via Letterboxd; falls back to TMDB if unavailable
- **Persistent history**: Tracks all browsed films and displays them in a "Top Picks" leaderboard sorted by rating
- **Dark mode UI**: Cohesive, lightweight design that doesn't interfere with native streaming interfaces
- **Works on both platforms**: Netflix and Disney+ (movies only; optimized for Netflix's movie browse pages)

## Installation

### Step 1: Get API Keys

**OMDB API Key** (required):
1. Go to [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx)
2. Sign up for a free account
3. Request a free API key (allows 1,000 requests/day)
4. Copy your key

**TMDB API Key** (optional, for fallback ratings):
1. Create a free account at [themoviedb.org](https://www.themoviedb.org/)
2. Go to **Settings > API**
3. Copy your API Read Access Token

### Step 2: Install the Extension

1. Clone or download this repository:
   ```bash
   git clone https://github.com/cedric543/findratings.git
   ```

2. Open Chrome and go to `chrome://extensions/`

3. Enable **Developer mode** (toggle in the top-right corner)

4. Click **Load unpacked** and select the `findratings` folder

5. The extension icon should now appear in your Chrome toolbar

### Step 3: Configure API Keys

1. Click the findratings extension icon in Chrome
2. Select **Options**
3. Paste your OMDB API key into the first field
4. (Optional) Paste your TMDB key into the second field
5. Click **Save settings**

You're ready to go! Navigate to any Netflix movie genre page and start hovering over movie tiles.

## How It Works

### Architecture

The extension uses a three-tier lookup pipeline for robust title matching:

1. **Optimistic Slug-Matching** (fast path): Guesses the Letterboxd URL slug based on the movie title and year, then validates the result
2. **OMDB Validation** (accuracy): Confirms the correct film using OMDB's database (release year, runtime) to disambiguate identical titles across years
3. **TMDB Fallback** (coverage): If Letterboxd has no rating, optionally retrieves ratings from TMDB

### Data Flow

- **content.js** (content script): Injects into Netflix/Disney+, detects movie tiles via MutationObserver, extracts metadata from the DOM
- **background.js** (service worker): Handles API calls, caching, and persistent storage of seen films
- **styles.css**: Provides the hover popup UI with smooth animations and accessibility support
- **options.html/js**: Settings page for API key management

### Technical Highlights

- **Concurrent API fetching**: Fires OMDB and Letterboxd lookups in parallel to minimize latency
- **Pixel-accurate DOM tracking**: Uses `elementFromPoint` and `MutationObserver` to track dynamic content and handle infinite scroll
- **Defensive zone detection**: Only hides the popup when the cursor genuinely leaves safe zones (tile, popup, Netflix's native modals)
- **Runtime matching heuristics**: Filters candidates by release year and runtime duration to resolve ambiguous titles (e.g., *Moonlight* 2016 vs. 2017)
- **Netflix data extraction**: Parses Netflix's internal script payloads via regex to recover exact release years when they're not exposed in the DOM

## Usage

1. Navigate to the **Movies** section on Netflix (genre browse pages) or any movie section on Disney+
2. Hover over a movie tile
3. After ~200ms, the Letterboxd rating popup appears
4. Click **Open on Letterboxd** to visit the film's page
5. Your browsing history is automatically saved

View your curated list of browsed films in the **Top Picks** page (accessible from the extension options).

## Known Limitations

- Netflix movies only (genre pages); doesn't run on other Netflix sections to avoid interference
- Requires valid API keys for best results; some films may not resolve without OMDB
- Rare edge cases: films with identical names and years may still return wrong matches

## Privacy

- All API keys are stored **locally in your browser** via `chrome.storage.local`
- Keys are **never** sent anywhere except to OMDB and TMDB APIs
- No tracking, no telemetry, no data collection beyond what's necessary for the extension to function

## Tech Stack

- **JavaScript (ES6+)** — content scripts and service worker
- **Chrome Extension APIs** — storage, runtime messaging, content scripts
- **OMDB API** — metadata validation (release year, runtime)
- **TMDB API** — fallback ratings
- **Letterboxd** — web scraping (rating extraction, title validation)

## Troubleshooting

**"Loading..." popup appears but never shows a rating:**
- Check that your OMDB API key is valid and saved in options
- Verify your internet connection
- Check Chrome DevTools (F12) > Extensions tab for errors

**Wrong Letterboxd page is shown:**
- Some ambiguous titles may require manual intervention; this is a known limitation
- You can manually search Letterboxd and add the correct film to your history

**Extension doesn't appear on Netflix:**
- Ensure you're on a Netflix **movie genre page** (e.g., `/browse/genre/34399`)
- The extension intentionally only runs there to avoid breaking other parts of Netflix
- Refresh the page or reload the extension in `chrome://extensions`

## Contributing

Found a bug or have a feature idea? Open an issue or submit a pull request.

---

**Enjoy discovering ratings while you browse!**
