# Atlas Timeclock

Clock-in/clock-out system for Atlas Staffing:

- **Staff mobile app** (iPhone + Android, Expo/React Native): staff sign in, clock in and out with GPS, see their hours, and submit their timesheet at the end of each pay period.
- **Admin portal** (static web pages + one PHP file, for your hosting domain): live "on the clock" board, timesheets by organization and house, shift corrections, staff logins, houses and geofences, and Excel export.
- **Supabase backend** (you manage it): logins, database, row-level security, and the geofence and pay-period logic.

```
atlas-timeclock/
├── supabase/
│   ├── schema.sql          ← run once in the Supabase SQL editor
│   └── sample-data.sql     ← optional test organizations and houses
├── admin/                  ← upload to your hosting domain
│   ├── index.html
│   ├── css/portal.css
│   ├── js/config.js        ← your Supabase URL and anon key
│   ├── js/app.js
│   ├── js/export.js        ← Excel timesheet layout
│   └── api/
│       ├── staff.php       ← creates logins and resets passwords (uses the service key)
│       ├── config.sample.php
│       └── .htaccess
└── mobile/                 ← the staff app (Expo)
    ├── App.js, index.js, app.json, package.json, .env.example
    └── src/…
```

---

## How it works

**Clocking in.** The app takes one high-accuracy GPS fix and sends it to Supabase's `clock_in()` function. The server:

1. stamps the time with **its own clock**, so staff can't change the phone's time to fake a shift;
2. finds the **nearest active house** and measures the distance;
3. if the staff member is inside that house's geofence (150 m by default), records the shift as normal;
4. if they're outside, refuses unless they add a note, then records the shift and **flags it for review**;
5. refuses a GPS fix worse than 150 m and flags "simulated location" apps on Android.

Clocking out works the same way, measured against the house they clocked in at. The app reads location only when staff tap Clock in or Clock out. It never tracks them in the background.

**Pay periods.** Bi-weekly, counted from an anchor date (default Sunday, Sep 13, 2026, so the current period is Sep 13–26). A shift belongs to the period of its clock-in date, in America/New_York time. Overnight shifts stay on one row, and the time out is marked "(+1 day)". You can change the anchor, length and timezone under **Settings**.

**End of the period.**
1. From the last day of the period, staff can **submit their timesheet** in the app, confirming their hours.
2. In the portal, **Timesheets** shows every shift grouped by organization, then house, with subtotals. It also shows flags and who has submitted.
3. **Close & export period** locks every shift in the period and downloads the Excel workbook. **Reopen period** unlocks it if you need to make a correction.

**Excel output.**
- **Download Excel** on an organization creates one workbook for that organization, with two sheets:
  - *Timesheet*: Date, Staff, House, Address, Time In, Time Out, Hours and Notes, grouped by house. Each house has a subtotal and the organization total is at the bottom.
  - *Hours by Staff*: a grid of staff by house, with row and column totals.
- **Download all organizations** creates one workbook with a *Summary* sheet and one timesheet sheet per organization. The summary shows hours per organization and house, the grand total of all hours worked, and total hours per staff member.

All totals are live Excel `SUM` formulas. If you correct a cell, the totals update.

**Audit trail.** Every clock-in, clock-out, admin edit and deletion is written to `clock_entry_audit`. Nobody can change or delete it, including admins. The shift editor in the portal shows each shift's history.

---

## Try the demo on GitHub Pages

`admin/demo.html` runs the portal on built-in sample data (Sep 13–26, 2026), with no Supabase needed. You can browse every tab and download real Excel files. Changes aren't saved.

1. Create a repository on GitHub, for example `atlas-timeclock`.
2. Upload the contents of this folder: **Add file → Upload files**, drag everything in, then **Commit**. The `.gitignore` keeps `.env` and `config.php` out if you use git from your computer. Never upload files that contain keys.
3. Go to **Settings → Pages**. Under *Source*, choose **Deploy from a branch**, then **main** and **/ (root)**, and click **Save**.
4. After a minute the demo is live at `https://<your-username>.github.io/atlas-timeclock/`. The root page redirects to the demo.

GitHub Pages serves static files only. The demo works there, but the real portal needs `api/staff.php`, which requires PHP. Host the real portal on your own domain, as described below. GitHub Pages on a **private** repository needs a paid GitHub plan. On a free account the repository must be public, which is fine because nothing in this code is secret.

---

## Setup

### 1. Supabase (about 10 minutes)

1. Create a **new Supabase project** for Atlas. Keep it separate from AnkorWell's so the two companies' data never mixes.
2. **Authentication → Sign In / Providers → Email:** turn **off** "Allow new users to sign up". Only admins create logins, through the portal.
3. **SQL Editor:** paste all of `supabase/schema.sql` and run it. It's safe to run again later.
4. *(Optional, for testing)* run `supabase/sample-data.sql` to add three sample organizations with six houses. Delete them before go-live.
5. **Create your own admin login.** Go to Authentication → Users → Add user, enter your email and a strong password, and tick "Auto confirm". Then run:
   ```sql
   update auth.users
      set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'
    where email = 'you@atlasstaffing.com';
   update public.profiles set role = 'admin', full_name = 'Your Name'
    where email = 'you@atlasstaffing.com';
   ```
6. From **Project Settings → API**, copy the **Project URL**, the **anon key** and the **service_role key**.

> Free-tier Supabase projects pause after a week with no activity. A timeclock in daily use won't pause, but during setup you may need to unpause the project from the dashboard.

### 2. Admin portal (your hosting domain)

1. In `admin/js/config.js`, set `supabaseUrl` and `supabaseAnonKey`.
2. Copy `admin/api/config.sample.php` to **`/home/<you>/atlas-private/config.php`**, which is outside `public_html`. Fill in the URL, anon key and **service_role key**. `staff.php` looks there first. If you have to keep it in `admin/api/config.php` instead, the `.htaccess` in that folder blocks web access to it.
3. Upload the `admin/` folder to your domain. A subdomain such as `portal.yourdomain.com` works well, or use an unguessable path the way you did for AnkorWell's admin page. The page already has `noindex`.
4. Sign in, open **Settings → Two-factor sign-in → Set up**, and scan the QR code with your authenticator app.
5. Add your **organizations and houses**. To get a house's coordinates, right-click it in Google Maps, click the numbers to copy them, and paste them into the house form.
6. Add **staff** under Staff → Add staff. Each person gets a login email and a temporary password to share with them privately.

The service_role key is only used inside `staff.php`, and only after it confirms the caller is an active admin. It must never go into a `.js` file.

### 3. Staff mobile app

You need Node.js 20+ and a phone with **Expo Go** installed for testing.

```bash
cd mobile
cp .env.example .env            # add your Supabase URL + anon key
npm install
npx expo install --fix          # aligns package versions with the Expo SDK
npx expo start                  # scan the QR code with Expo Go
```

To publish to the App Store and Google Play, use Expo's build service:

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build --platform all        # cloud builds for iOS and Android
eas submit --platform all       # uploads to App Store Connect / Google Play Console
```

- You'll need an **Apple Developer** account ($99/year) and a **Google Play Console** account ($25 one-time). Publish under Atlas's business name.
- Change `bundleIdentifier` and `package` in `app.json` if Atlas wants a different app ID. The current ID is `com.atlasstaffing.timeclock`. The ID can't be changed after the app is first published.
- The location permission message and the "no background location" settings are already in `app.json`. App reviewers check both.
- If you'd rather not list the app publicly, use **TestFlight** (iOS) and **internal testing** (Google Play) to distribute it only to Atlas staff.

---

## Security summary

- Row-level security is on for every table. Staff can read only their own profile, shifts and submissions. They can't insert or edit shifts directly; every change goes through `clock_in()`, `clock_out()` and `submit_timesheet()`.
- Admin rights come only from `app_metadata`, which only the service key can set. A user can't make themselves an admin by editing their own profile metadata.
- Closed pay periods are locked at the database level.
- Deactivating a staff member blocks both their app access and their ability to sign in.
- The audit log can't be changed.

## Good next steps

- **Emailed timesheets.** Automatically email the Excel workbook to payroll when a period closes, using a Supabase Edge Function plus pg_cron.
- **Offline clock-in.** Queue punches when the phone has no signal and send them later. For now the app needs a connection when staff clock in or out.
- **Scheduling.** Compare actual punches with scheduled shifts and flag no-shows and late arrivals.
