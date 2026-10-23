# Telegram Comma Remover Bot

Bot Telegram ringan yang menghapus semua karakter koma ASCII (`,`) dari teks dan mengirimkan hasilnya kembali. Berjalan sepenuhnya di Cloudflare Workers melalui webhook, tanpa polling, VPS, database, atau framework backend.

## Fitur

- Menghapus semua koma tanpa mengubah karakter lain. Titik desimal, tanda minus, spasi, emoji, dan huruf tetap dipertahankan.
- Membaca link Google Maps dan membalas nama tempat, alamat tanpa koma, latitude, dan longitude.
- Perintah `/start`, `/help`, dan `/clean`.
- Pesan teks biasa langsung diproses dan dibalas ke pesan asli.
- Hasil dikirim sebagai teks biasa (tanpa Markdown/HTML) agar aman disalin.
- Validasi `X-Telegram-Bot-Api-Secret-Token`, validasi payload, dan penanganan error Telegram API.
- Tidak mencatat isi pesan pengguna ke log.

Contoh:

```text
-7.123456, 109.123456        ->  -7.123456 109.123456
Jakarta, Bandung, Surabaya   ->  Jakarta Bandung Surabaya
```

Contoh link Google Maps:

```text
https://maps.app.goo.gl/bqwmTtGrR9AvJGHm9
```

Balasan:

```text
Nama: Pondok Pesantren Al Anshor
Alamat: Jl. Curug Bandung Ciheuleut Limbangan Kec. Wanareja Kabupaten Cilacap Jawa Tengah 53232
Latitude: -7.2810178
Longitude: 108.7039185
```

## Struktur Proyek

```text
src/
  index.ts       # Entry point Worker, routing, validasi, handler update
  telegram.ts    # Helper Telegram sendMessage
  processor.ts   # Fungsi pure penghapus koma
  maps.ts        # Resolver link Google Maps dan formatter hasil
  types.ts       # Tipe Env dan payload Telegram
tests/
  processor.test.ts
  handler.test.ts
  maps.test.ts
wrangler.jsonc
```

## Prasyarat

- Node.js 20 atau lebih baru
- Akun Cloudflare (paket gratis cukup)
- Akun Telegram

## Deployment dari Nol

### 1. Buat bot di BotFather

1. Buka Telegram, cari `@BotFather`, lalu kirim `/newbot`.
2. Ikuti instruksi sampai mendapat **bot token**.
3. Simpan token di tempat aman. Jangan masukkan token ke source code atau Git.
4. Opsional untuk grup: kirim `/setprivacy` ke BotFather, pilih bot, lalu pilih `Disable` agar bot dapat membaca pesan biasa di grup. Dengan privacy mode aktif, bot hanya menerima perintah dan pesan yang menyebut bot.

### 2. Siapkan Cloudflare

1. Buat akun di <https://dash.cloudflare.com> jika belum punya.
2. Install dependensi proyek:

   ```powershell
   npm install
   ```

3. Login Wrangler (membuka browser):

   ```powershell
   npx wrangler login
   ```

### 3. Buat secret acak untuk webhook

Buat nilai acak yang aman (hanya huruf, angka, `_`, dan `-`):

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Simpan hasilnya sebagai `WEBHOOK_SECRET`. Nilai ini harus sama di Cloudflare Worker dan saat memanggil `setWebhook`.

### 4. Simpan token dan secret sebagai Worker Secret

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Wrangler akan meminta nilai secara interaktif. Nilai tidak ditulis ke `wrangler.jsonc`, tidak masuk ke Git, dan tidak ditampilkan kembali.

Untuk pengembangan lokal, salin `.dev.vars.example` menjadi `.dev.vars` lalu isi nilainya. File `.dev.vars` sudah diabaikan Git.

### 5. Deploy Worker

```powershell
npx wrangler deploy
```

Catat URL Worker yang muncul, misalnya:

```text
https://telegram-comma-remover.<subdomain>.workers.dev
```

Endpoint webhook adalah URL tersebut ditambah `/webhook`:

```text
https://telegram-comma-remover.<subdomain>.workers.dev/webhook
```

### 6. Daftarkan webhook Telegram

Gunakan PowerShell (token diambil dari environment variable agar tidak tersimpan di riwayat perintah):

```powershell
$env:TELEGRAM_BOT_TOKEN = "TOKEN_DARI_BOTFATHER"
$env:WEBHOOK_SECRET = "SECRET_YANG_DIBUAT_TADI"

$body = @{
  url = "https://telegram-comma-remover.<subdomain>.workers.dev/webhook"
  secret_token = $env:WEBHOOK_SECRET
  allowed_updates = @("message")
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/setWebhook" `
  -ContentType "application/json" `
  -Body $body
```

Alternatif dengan curl:

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://telegram-comma-remover.<subdomain>.workers.dev/webhook","secret_token":"'"${WEBHOOK_SECRET}"'","allowed_updates":["message"]}'
```

### 7. Verifikasi webhook

```powershell
Invoke-RestMethod "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

Pastikan:

- `url` menunjuk ke endpoint `/webhook`.
- `pending_update_count` rendah.
- `last_error_message` kosong setelah bot diuji.

### 8. Uji bot

1. Buka bot di Telegram dan kirim `/start`.
2. Kirim `Jakarta, Bandung, Surabaya`; bot harus membalas `Jakarta Bandung Surabaya`.
3. Kirim `/clean -7.123456, 109.123456`; bot harus membalas `-7.123456 109.123456`.
4. Kirim `/clean` saja; bot harus meminta teks.

### 9. Perbarui kode dan redeploy

```powershell
npm test
npm run typecheck
npx wrangler deploy
```

Secret yang sudah disimpan tetap ada saat redeploy. Jika `TELEGRAM_WEBHOOK_SECRET` diganti, panggil `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET` lalu jalankan ulang `setWebhook` dengan nilai baru. Jika token bot diganti, perbarui secret dan daftarkan ulang webhook.

## Pengembangan Lokal

```powershell
Copy-Item .dev.vars.example .dev.vars
# isi .dev.vars dengan nilai asli, jangan di-commit
npx wrangler dev
```

Telegram membutuhkan URL HTTPS publik untuk webhook. Untuk pengujian lokal, gunakan unit test atau tunnel HTTPS seperti `cloudflared tunnel` dan arahkan webhook ke URL tunnel.

## Pengujian

```powershell
npm test
npm run typecheck
```

## Fitur Google Maps

Kirim link tempat atau titik dari Google Maps. Link yang didukung antara lain:

```text
https://maps.app.goo.gl/...
https://goo.gl/maps/...
https://www.google.com/maps/...
https://maps.google.com/...
https://www.google.co.id/maps/...
```

Cara kerja:

1. Short link di-resolve maksimal 5 redirect.
2. Koordinat diambil dari parameter `!3d`/`!4d`, `@lat,lng`, atau `q=lat,lng`.
3. Nama dan alamat diambil dari data tempat halaman Google Maps.
4. Jika data alamat Google tidak tersedia, bot menampilkan `Alamat: Tidak tersedia` dan tetap membalas koordinat yang berhasil dibaca.
5. Koma dihapus dari nama dan alamat sebelum dibalas.
6. Balasan alamat menyertakan tombol `Salin alamat` yang menyalin alamat ke clipboard jika panjangnya maksimal 256 karakter.

Catatan penting:

- Bot tidak memakai Google Maps API resmi atau API key. Data diambil dari halaman publik Google Maps. Format halaman dapat berubah atau akses dapat dibatasi Google, sehingga fitur ini bersifat best-effort.
- Link yang dibuka hanya domain Google Maps yang diizinkan. Link lain tidak di-fetch.
- Link harus dapat diakses publik. Link yang membutuhkan login tidak dapat diproses.
- Untuk dropped pin tanpa halaman tempat, alamat mungkin tidak tersedia; koordinat tetap ditampilkan.
- URL dikirim ke Google Maps untuk diproses. Bot tidak menyimpannya ke database dan tidak mencatat isi pesan ke log.

## Perilaku dan Batas

- Batas aman input adalah 4096 karakter (batas teks pesan Telegram). Pesan yang lebih panjang mendapat balasan bahwa pesan terlalu panjang.
- Jika pesan berisi link Google Maps, fitur Maps diproses dan teks lain dalam pesan yang sama diabaikan.
- Jika teks tidak memiliki koma, bot membalas bahwa tidak ada koma dan teks tidak berubah.
- Jika hasil kosong (misalnya hanya koma), bot memberi tahu bahwa tidak ada teks tersisa.
- Perintah yang tidak dikenal diabaikan.
- Update tanpa pesan teks, pesan dari bot lain, dan update tidak relevan diabaikan dengan HTTP 200.

## Keamanan

- Endpoint hanya menerima `POST /webhook` dengan header `X-Telegram-Bot-Api-Secret-Token` yang cocok. Perbandingan dilakukan secara constant-time.
- Payload update divalidasi sebelum diproses.
- Fetch untuk fitur Maps hanya diizinkan ke host Google Maps, dengan batas redirect dan timeout 8 detik per request.
- Bot token dan webhook secret hanya disimpan sebagai Worker Secrets.
- Isi pesan pengguna tidak dicatat ke log. Log hanya berisi status/error dari Telegram API.
- Jangan pernah menulis token ke source code, dokumentasi, tangkapan layar, atau commit Git.
- Jika token bocor, buat token baru melalui `/revoke` di BotFather, perbarui secret, lalu daftarkan ulang webhook.

## Kode Status HTTP

| Kondisi | Status |
| --- | --- |
| Webhook berhasil diproses / update diabaikan | `200` |
| Path tidak dikenal | `404` |
| Method bukan POST | `405` |
| Secret header tidak ada atau salah | `401` |
| JSON atau payload tidak valid | `400` |
| Konfigurasi/token tidak tersedia | `500` |
| Telegram API gagal, timeout, atau menolak pesan | `502` |

## Troubleshooting

- **Bot tidak merespons**: jalankan `npx wrangler tail` untuk melihat log, lalu cek `getWebhookInfo`.
- **`last_error_message` berisi 401**: nilai `secret_token` di `setWebhook` berbeda dengan `TELEGRAM_WEBHOOK_SECRET` di Worker.
- **404**: URL webhook harus berakhiran `/webhook`.
- **Bot diam di grup**: periksa privacy mode BotFather atau gunakan `/clean@NamaBot <teks>`.
- **Webhook terdaftar tetapi salah URL**: jalankan ulang `setWebhook` dengan URL yang benar.
- **Link Maps gagal diproses**: pastikan link publik dan mengarah ke tempat/titik, bukan link yang membutuhkan login. Coba buka link di browser; jika Google menampilkan captcha/consent, Worker juga tidak dapat membacanya.
- **Alamat tidak tersedia**: Google Maps tidak mengirim data alamat untuk link tersebut. Bot tetap mengirim nama tempat dan koordinat jika tersedia.
