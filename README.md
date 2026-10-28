# Song Ranker

Rank every song by any artist head to head (Elo), then compare your list with friends and with the crowd.
Live at https://ellioshow1.github.io/song-ranker/

The successor to the Artist Ranker (Deezer edition), which stays untouched at
https://ellioshow1.github.io/artist-ranker-deezer/. Rankings made there can be brought over from the home screen:
picks are copied (never moved) and replayed as Elo ratings.

## Features

- **Song catalog from Deezer** (no login): the artist's albums, singles, EPs and compilations, plus features found through
  their top tracks and a name search.
- **Duplicates handled properly.** Tracks with the same ISRC are one song. Titles are compared without feat. credits and
  noise like "Remastered 2011", "Radio Edit", "Single Version" or "Bonus Track". Live, remix, acoustic, instrumental,
  sped up, demo, re-recorded ("Taylor's Version"), extended, skit and other alternate versions stay separate, each type
  toggleable. Pick which version represents a song, split a wrong merge, or merge a missed one; same-title leftovers are
  listed under "possible duplicates".
- **Filters and presets:** release types (albums, singles & EPs, features, greatest hits & compilations, live albums),
  version types, minimum length, years, specific albums, the crowd's top N, manual adds/removes, add by Deezer link.
- **Elo matchups** with 30-second previews, ties, skip, undo and keyboard shortcuts. Rough ≈ 4 matchups per song,
  Solid ≈ 8, Sharp ≈ 14. Every song always has an exact place.
- **Album ranking** from the average rating of each album's songs.
- **The crowd:** Deezer popularity (driven by recent streams) as the robot. Compare shows agreement, your hidden gems,
  what you think is overplayed, a scatter of every song and both top 25s.
- **Sharing:** a link with your whole ranking and your hot takes (notes on songs), an image of your top 10/25/50, or text.
  Opening a friend's link shows their list against yours and the crowd; save it to compare any time.
- **Group ranking:** blend you and any saved friends into a consensus list, see the most divisive songs and who agrees
  with whom.
- Optional Spotify playlist export (matched by ISRC), and backup/restore.

Everything is stored in your browser (state in localStorage under `songRanker.*`, catalogs in IndexedDB).

## Run it locally

Double-click `start.bat`, or run `python -m http.server 8775 --bind 127.0.0.1` here and open http://127.0.0.1:8775/

## Files

- `js/deezer.js`: Deezer API via JSONP, rate limited, catalog scan, previews
- `js/catalog.js`: song merging, version tags, release kinds, filters and presets
- `js/elo.js`: Elo ratings replayed from picks, pairing, progress levels
- `js/compare.js`: agreement, disagreements, group consensus, scatter
- `js/share.js`: share links (varint-packed ids + hot takes) and the share image
- `js/store.js`: localStorage + IndexedDB, read-only access to the old app's saves
- `js/spotify.js`, `js/config.js`: optional Spotify export
- `js/app.js`: UI
