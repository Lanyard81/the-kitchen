# The Kitchen

Everyday cooking recipes with serving-size scaling, a weekly planner and a merging shopping list. Australian measurements by weight throughout.

One codebase, three targets: **Web/PWA**, **Windows desktop (.exe)** and **iPhone** (via Capacitor). Same structure as the Bakehouse.

---

## 0. Prerequisites (once)

1. Install **Node.js 20 LTS or later** from https://nodejs.org (the LTS button). Verify:
   ```
   node -v
   npm -v
   ```
2. Open a terminal in this folder (`the-kitchen`) and install dependencies:
   ```
   npm install
   ```

That is all you need for web and desktop. iPhone additionally needs a Mac with Xcode (section 3).

---

## 1. Web / PWA

**Run locally (development):**
```
npm run dev
```
Open the URL it prints (usually http://localhost:5173).

**Build for hosting:**
```
npm run build
```
This produces a `dist/` folder. Upload the *contents* of `dist/` to any static host (Netlify, Vercel, Cloudflare Pages, GitHub Pages). Nothing else is required — no server, no database.

**Install as a PWA:** once it is served over HTTPS, open it in Safari or Chrome on your phone → Share → **Add to Home Screen**. It installs with the The Kitchen icon, runs full-screen, and works offline (a service worker caches the app).

> Data note: recipes, the planner and the shopping list are stored in the browser's localStorage on each device. They persist between visits but do not sync between devices.

---

## 2. Windows desktop (.exe)

**Test the desktop app:**
```
npm run electron:dev
```

**Build the installer and portable exe:**
```
npm run electron:build
```
Output lands in `release/`:
- `The Kitchen Setup 1.0.0.exe` — one-click installer with a desktop shortcut
- `The Kitchen 1.0.0.exe` — portable, runs from anywhere with no install

Build this **on a Windows machine** (electron-builder cross-compiling from Mac/Linux is unreliable). On a Mac, use `npm run electron:build:mac` for a `.dmg` instead.

---

## 3. iPhone (Capacitor)

Requires a Mac with **Xcode** installed (free from the App Store) and a free Apple ID.

**First time only:**
```
npm run ios:init
```
This builds the web app and creates the native `ios/` project.

**Every time you change the app:**
```
npm run ios:sync
npm run ios:open
```

In Xcode:
1. Click the **App** target → **Signing & Capabilities** → tick *Automatically manage signing* → select your Apple ID team.
2. Plug in your iPhone, select it as the run destination (top bar), press **▶ Run**.
3. First run on-device: on the iPhone go to *Settings → General → VPN & Device Management* and trust your developer certificate.

With a free Apple ID the app must be re-installed from Xcode every 7 days; a paid developer account ($149 AUD/yr) removes that limit and enables TestFlight/App Store distribution.

---

## 4. Where things live

| Path | What it is |
|---|---|
| `src/App.jsx` | The entire app — recipes, scaler, planner, shopping list |
| `src/main.jsx` | React entry point + service worker registration |
| `public/` | PWA manifest, service worker, icons |
| `electron/main.cjs` | Desktop window shell |
| `capacitor.config.json` | iOS app id and name |
| `package.json` | All scripts and build config |

**Changing starter recipes:** edit the `STARTERS` array near the top of `src/App.jsx`. Note that once the app has run once on a device, recipes load from that device's saved data — starters only seed a fresh install.

**Renaming the app again:** search-and-replace "The Kitchen" in `package.json`, `capacitor.config.json`, `index.html`, `public/manifest.webmanifest` and `src/App.jsx`, then rebuild.

---

## 5. Quick reference

| I want to… | Command |
|---|---|
| Run in a browser | `npm run dev` |
| Build for web hosting | `npm run build` |
| Run desktop app | `npm run electron:dev` |
| Build Windows exe | `npm run electron:build` |
| Set up iPhone project (first time) | `npm run ios:init` |
| Push changes to iPhone project | `npm run ios:sync` then `npm run ios:open` |

---

## 6. App Store release notes (v1.1.0)

**Durable storage.** As of v1.1.0 the native iOS/Android builds store all data as JSON files in the app's Data directory via `@capacitor/filesystem` — this survives WebView storage eviction and is included in device backups. Web/PWA and Electron continue to use localStorage. Existing data from earlier builds migrates automatically on first launch. After pulling this version, run:
```
npm install
npm run ios:sync
```
so the Filesystem plugin is added to the Xcode project.

**Icons & splash screens.** Branded sources live in `resources/` (icon.png 1024, splash.png / splash-dark.png 2732). To generate the full iOS icon and splash set automatically:
```
npm install -D @capacitor/assets
npx capacitor-assets generate --ios
```
This populates the Xcode asset catalogues. PWA icons in `public/` are already the new branding.

**Submission checklist.**
1. Decide the final bundle ID in `capacitor.config.json` and `package.json` (`appId`) — it is permanent after first App Store submission. Check the App Store for name collisions on "The Kitchen" and consider a more ownable name for search.
2. Enrol in the Apple Developer Program (US$99 / ~A$149 per year).
3. In App Store Connect: create the app record, upload screenshots (6.7" and 6.1" iPhone required), set the privacy label — this app collects no data; everything is on-device — and provide a privacy policy URL and support contact.
4. Archive and upload via Xcode (Product → Archive → Distribute), then run a TestFlight round with real users before public release.
5. Pricing: a one-time paid app avoids all in-app purchase complexity.

---

## 7. Custom domain on GitHub Pages

1. Buy a domain from any registrar (Cloudflare Registrar, VentraIP, GoDaddy — for a `.com.au` you need an ABN or ACN).
2. In the registrar's DNS settings add:
   - For the apex domain (`thekitchen.example`): four **A records** pointing to `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - A **CNAME record** for `www` pointing to `<your-username>.github.io`
   - (Subdomain-only alternative, e.g. `app.yourdomain.com`: just one CNAME to `<your-username>.github.io`)
3. In the GitHub repo: **Settings → Pages → Custom domain**, enter the domain, Save. GitHub runs a DNS check (allow up to an hour for DNS to propagate).
4. If deploying via GitHub Actions (this project's setup), also create `public/CNAME` containing exactly one line — your domain — and push. This keeps the domain setting from being wiped on each deploy.
5. Back in **Settings → Pages**, tick **Enforce HTTPS** once the certificate is issued (automatic, usually within the hour).

The app then lives at your domain; Add to Home Screen and the service worker keep working unchanged.

---

## 8. Multi-device sync (Supabase)

Free tier is ample. One-time setup:

1. **supabase.com** → Start your project → sign up (GitHub login is easiest) → **New project**: any name, generate a database password (you won't need it again), region **Sydney (ap-southeast-2)** → Create.
2. Left sidebar → **SQL Editor** → **New query** → paste and **Run**:
```sql
create table public.kitchens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.kitchens enable row level security;
create policy "read own kitchen"   on public.kitchens for select using (auth.uid() = user_id);
create policy "insert own kitchen" on public.kitchens for insert with check (auth.uid() = user_id);
create policy "update own kitchen" on public.kitchens for update using (auth.uid() = user_id);
```
3. **Authentication → URL Configuration** → set **Site URL** to your app's address (e.g. `https://YOUR-USERNAME.github.io/the-kitchen/`) → Save.
4. **Project Settings (gear) → API** → copy **Project URL** and the **anon public** key into `src/syncConfig.js`.
5. Commit and push (`git add . && git commit -m "enable sync" && git push`).

Use: Settings → **Sync across devices** → enter email → tap the link in the email **on that device** → done. Sign in with the same email on each device. Sync is whole-kitchen, automatic (4 s after changes), last-writer-wins. The anon key is safe to publish; row-level security means each account can only ever read its own row.
