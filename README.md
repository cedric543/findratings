# findratings

See Letterboxd ratings for Netflix movies by hovering over any title.

## Install

**Chrome Web Store (recommended):**
[chromewebstore.google.com/detail/findratings/ailknndkpengghndlmoibfbkmlnnkjoi](https://chromewebstore.google.com/detail/findratings/ailknndkpengghndlmoibfbkmlnnkjoi)

## Setup

A free OMDB API key is recommended for best accuracy:
1. Go to [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx) and sign up
2. Open the extension options: `chrome://extensions` → findratings → Details → Extension options
3. Paste your key and click **Save settings**

The extension works without a key but may occasionally match the wrong film for ambiguous titles.

## Usage

1. Go to the Movies genre page on Netflix
2. Hover over any movie tile
3. A popup appears with the Letterboxd rating and a link to the film's page

## Privacy

API keys are stored locally in your browser via `chrome.storage.local` and are never sent anywhere except to omdbapi.com. No data is collected or tracked.
