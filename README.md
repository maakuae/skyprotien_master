# Sky Protein Oil Private Limited – Website + Admin Panel

A complete website with a built-in admin panel. You can edit **every text and every image** from the browser – no coding.
No packages to install: the server uses only Node.js (version 18 or newer).

## Run it

```bash
node server.js          # or: npm start
```

* Website:  http://localhost:3000
* Admin:    http://localhost:3000/admin

**First login password: `admin123`** – change it straight away under *Settings* in the admin panel
(or start the server with your own password: `ADMIN_PASSWORD=MySecret123 node server.js`).
Optional: `PORT=8080 node server.js`.

## Using the admin panel

| Where | What you can do |
|---|---|
| Left menu (Splash screen … Footer) | Edit every text on the website and replace every image. Click **Save changes** (or Ctrl+S). The site updates immediately. |
| Image fields | **Upload new image** (PNG/JPG/WebP/GIF, up to 8 MB; very large photos are shrunk automatically) or **Choose from library**. |
| Reset to default | Every field has a button that restores the original text/image. |
| Search box | Finds any text or image across the whole site. |
| Enquiries | Everything submitted through the website's contact form, with *Mark as read*, *Delete* and *Export CSV*. |
| Image library | All uploaded images; delete unused ones. |
| Contact section | Address, phone and email are **hidden on the website until you fill them in**. |

## Folder layout

```
server.js            the backend (website + admin API)
public/index.html    website template
public/admin/        admin panel
public/img/          logo, machine photo and default illustrations
uploads/             images you upload (created automatically)
data/schema.json     list of all editable fields and their default values
data/content.json    YOUR edits (only values that differ from the defaults)
data/inquiries.json  enquiries received
data/auth.json       admin password (hashed) once you change it
```

**Backup:** copy the `data/` and `uploads/` folders.

## Going live

* This project includes a Render Blueprint (`render.yaml`). In Render, create a new Blueprint from the GitHub repository and enter a strong, unique value for `ADMIN_PASSWORD` when prompted. The server refuses to start in production if this setting is missing or still uses `admin123`.
* The Render free service uses ephemeral storage. Website edits, enquiries, and uploaded images are stored on its local filesystem and may be lost when the service restarts or is redeployed. Keep backups and do not use this setup if those records must be retained.
* You can also run it on any host with Node 18+ (VPS, Render, Railway, etc.) and put it behind HTTPS (for example nginx or Caddy as a reverse proxy) – the admin password is sent when you sign in, so use HTTPS on a public server. Set `ADMIN_PASSWORD` to a strong, unique value in production.
* The page loads Tailwind CSS, icons and fonts from public CDNs, so visitors need an internet connection (same as the previous version of the site).
* Enquiries are stored in the admin panel. The server does not send e-mail by itself.
