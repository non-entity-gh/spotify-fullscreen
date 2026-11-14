# Spotify full-screen art

A small webpage that shows the song you're playing on Spotify as full-screen artwork. The picture slowly zooms and pans (a "Ken Burns" effect) and loops by cross-fading into a new move, so it never visibly jumps.

Unlike Spotify's own full-screen mode, the controls stay available. Move the mouse or tap the screen to bring them back:

- play / pause, previous, next
- a progress bar you can click or drag to seek
- volume, if the playing device allows it
- **Album / Artist / Both** cycles between album art, the artist's photo, and alternating between the two
- **Fill / Fit**: fill the screen (crops the edges), or fit the whole picture over a blurred copy of itself
- **i** shows or hides the small song title
- full screen, plus a menu with motion speed (slow / normal / fast) and sign out

The controls fade away after 3 seconds without mouse or touch input. The page also asks the browser to keep the screen awake.

Keyboard: **Space** play/pause · **← →** previous/next · **↑ ↓** volume · **F** full screen · **V** picture · **C** fill/fit · **I** song text. Double-click the picture to go full screen.

It is plain HTML, CSS and JavaScript with no build step and no server. Everything runs in your browser, which talks straight to Spotify.

**Try it without Spotify:** open the page with `?demo` on the end (for example `https://<you>.github.io/spotify-fullscreen/?demo`). It shows generated sample pictures, and the controls work locally. To test the effect on your own picture, use `?demo=https://example.com/picture.jpg`.

## What you need

- **Spotify Premium for the developer app.** Since February 2026, Spotify requires the owner of a Development Mode app to have Premium. A Development Mode app can have up to 5 signed-in users, and you must add each one by email (see step 5).
- Play/pause, skip, seek and volume use Spotify's playback-control API, which also needs **Premium for whoever signs in**. On a free account the art still works; the page greys out the controls and says why.
- Controls act on whichever device is playing (phone, desktop app, speaker). This page doesn't play audio itself.

## One-time setup

### 1. Put the page online with GitHub Pages

1. Push this folder to a GitHub repository, for example `spotify-fullscreen`.
2. On GitHub, open the repository's **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**, pick **main** and **/ (root)**, then **Save**.
4. After about a minute the page is live at `https://<your-username>.github.io/spotify-fullscreen/`.

### 2. Create your Spotify developer app

1. Go to <https://developer.spotify.com/dashboard>, sign in, and choose **Create app**.
2. Give it any name and description.
3. Under **Redirect URIs**, add the page's exact address, including the trailing slash:
   `https://<your-username>.github.io/spotify-fullscreen/`
   (The setup screen shows this address with a Copy button.)
4. Under "Which API/SDKs are you planning to use?", tick **Web API**. Accept the terms and **Save**.
5. Development Mode only: open the app's **User Management** and add the Spotify email of everyone who will sign in, including yourself if your developer account is separate from your listening account.

### 3. Paste the client ID

1. In the Spotify dashboard, open your app's **Settings** and copy the **Client ID**. Never use or share the client secret; this page doesn't need it.
2. Open your GitHub Pages address. The setup screen asks for the client ID. Paste it, choose **Save and sign in**, and approve the Spotify permissions.

The client ID and sign-in are saved in that browser only (`localStorage`), so each new browser or device asks once. To switch apps or accounts, use **… → Change client ID** or **Sign out**.

## Running it on your own computer

Spotify accepts plain `http` redirect addresses only for loopback IPs, and not for the name `localhost`. So:

```bash
python -m http.server 8888 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8888/> and add `http://127.0.0.1:8888/` as an extra redirect URI in your Spotify app.

## How it works

- **Sign-in:** Spotify's [Authorization Code with PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow) flow, which is designed for apps that can't keep a secret. The page refreshes the access token automatically.
- **Requested permissions:** `user-read-playback-state`, `user-read-currently-playing`, `user-modify-playback-state` (controls) and `user-read-private` (only used to check Premium).
- **What's playing:** `GET /me/player` every 3 seconds while music plays, every 8 seconds while paused, and every 30 seconds in a background tab. If Spotify says to slow down (HTTP 429), the page waits as long as Spotify asks.
- **Artist photo:** `GET /artists/{id}`, fetched once per artist. If an artist has no photo, the album art is used.
- **Podcasts:** episodes show the episode or show artwork.
- **Ken Burns:** two stacked picture layers. Each move zooms between about 1.1× and 1.3× and pans while staying inside the zoomed margin, so no edge ever shows. Shortly before a move ends, the other layer starts a fresh move and fades in on top over 4 seconds while the old one keeps drifting underneath. When a song changes, its new art cross-fades in the same way. If your system is set to reduce motion, the page only cross-fades.

**Picture sharpness:** Spotify serves album and artist pictures at most 640×640 pixels, so on a large or 4K screen they look soft. That is the largest size the API provides.

## Spotify Canvas (the looping video behind some songs)

This page doesn't show Canvas, and that's deliberate:

- The public Web API has no Canvas endpoint. Developers have asked Spotify for one for years.
- Third-party tools get Canvas videos from Spotify's internal endpoints (the ones its own apps use), signed in with a browser session cookie. Those endpoints are undocumented and can break at any time. Using them conflicts with the Spotify Developer Terms, which forbid reverse engineering, using non-public interfaces, and syncing Spotify content with other visuals.

If Spotify ever adds Canvas to the official API, it would fit in as a third picture type.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md). This project is not affiliated with Spotify. Spotify is a trademark of Spotify AB.
