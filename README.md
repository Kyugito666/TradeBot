# TradeBot — Multi-Agent Quant Trading Terminal

TradeBot adalah terminal trading kuantitatif berbasis sistem multi-agen yang terinspirasi pendekatan ala Renaissance Technologies. Aplikasi ini menggabungkan **dashboard web (Next.js)** untuk analisis dan visualisasi sinyal, dengan **mesin eksekusi opsional berperforma tinggi** yang ditulis dalam **Go** (data feed + gateway) dan **Rust** (otak konsensus multi-agen), yang saling berkomunikasi melalui *shared memory* untuk latensi rendah.

Inti aplikasinya adalah pipeline analisis 6 tahap yang menjalankan sekumpulan agen terspesialisasi (trend, mean-reversion, sentimen, volume, risiko, makro), mengagregasi voting mereka menjadi sinyal konsensus (LONG/SHORT/WAIT), lalu mengevaluasi performa tiap agen dari hasil trade untuk menyesuaikan bobotnya secara otomatis. Secara default aplikasi berjalan dalam mode **paper trading / dry-run** sehingga aman dijalankan tanpa mengeksekusi order sungguhan dan tanpa memerlukan API key.

---

## Daftar Isi

- [Fitur Utama](#fitur-utama)
- [Arsitektur Tingkat Tinggi](#arsitektur-tingkat-tinggi)
- [Prasyarat](#prasyarat)
- [Setup & Instalasi](#setup--instalasi)
- [Menjalankan Aplikasi](#menjalankan-aplikasi)
- [Environment Variables](#environment-variables)
- [Struktur Folder](#struktur-folder)
- [Build & Pemeriksaan](#build--pemeriksaan)
- [Panduan Penggunaan](#panduan-penggunaan)
- [API Endpoints](#api-endpoints)
- [Troubleshooting](#troubleshooting)
- [Kontribusi](#kontribusi)
- [Lisensi](#lisensi)

---

## Fitur Utama

- **Dashboard kuantitatif real-time** — memantau sinyal pasar untuk beragam simbol (BTC, ETH, SOL, dll.) menggunakan data publik dari exchange (default OKX, tanpa API key).
- **Sistem analisis multi-agen** — tim agen terspesialisasi (mis. `ma_cross`, `momentum`, `regime`, `rsi`, `bollinger`, `whale`, `open_interest`, `physicist`) yang masing-masing menilai faktor pasar berbeda.
- **Pipeline analisis 6 tahap** — Validate Input → Run Agents → Aggregate Votes → Risk Check → Generate Signal → Complete, dengan proteksi timeout per agen agar pipeline selalu selesai penuh.
- **Konsensus berbobot + veto risiko** — voting agen diagregasi dengan bobot, dan agen risiko (mis. `physicist`) dapat mem-veto sinyal saat kondisi pasar ekstrem.
- **Self-evaluation / pembelajaran agen** — setiap hasil trade memperbarui skor agen: menang menaikkan bobot/keyakinan, kalah menurunkannya; rentetan kekalahan memicu evaluasi tim.
- **Mode paper trading (dry-run)** — aktif secara default; simulasikan saldo awal, risiko per trade, pembukaan posisi otomatis saat ada konsensus, serta monitoring TP/SL.
- **Backtesting** — endpoint dan panel untuk menguji strategi terhadap data historis.
- **Mesin Go + Rust opsional** — Go engine menyediakan data feed, gateway HTTP/WebSocket, NLP sentiment, dan adapter exchange (Bybit, MEXC); Rust brain menjalankan konsensus & evolusi agen via shared memory untuk eksekusi berlatensi rendah.

> Catatan: Dashboard web dapat berjalan **mandiri** tanpa mesin Go/Rust. Mesin Go/Rust bersifat opsional dan ditujukan untuk skenario eksekusi latensi rendah.

---

## Arsitektur Tingkat Tinggi

Project ini terdiri dari tiga subsistem:

| Subsistem | Bahasa | Peran |
|-----------|--------|-------|
| **Dashboard / UI & API** | Next.js (TypeScript, React) | Antarmuka pengguna, pipeline agen sisi-JS, endpoint API analisis/market/backtest. |
| **Go Engine** | Go | Data feed pasar, gateway HTTP/WebSocket (port `8765`), NLP/sentiment, adapter & executor exchange, penulisan ke shared memory. |
| **Rust Brain** | Rust | Otak konsensus multi-agen + modul evolusi, membaca/menulis state melalui shared memory. |

Komunikasi antar Go engine dan Rust brain dilakukan lewat **shared memory** (di Linux: `/dev/shm/tradebot_v3`), dengan ABI bersama didefinisikan di `shared/shm_types.h`.

---

## Prasyarat

**Untuk menjalankan dashboard web saja (paling umum):**
- **Node.js 18+** (disarankan Node 20.9+ karena project memakai Next.js 16 & React 19)
- **npm** (project menggunakan `package-lock.json`)

**Tambahan, hanya jika ingin menjalankan mesin Go + Rust:**
- **Go** `1.26.3` atau kompatibel (lihat `go-engine/go.mod`)
- **Rust + Cargo** (edition 2021; install via [rustup](https://rustup.rs/))
- Lingkungan dengan dukungan shared memory:
  - **Linux/macOS** untuk `start_bot.sh` (menggunakan `/dev/shm`)
  - **Windows** untuk `start_bot.bat`
- `curl` (dipakai skrip launcher untuk health-check dashboard)

---

## Setup & Instalasi

```bash
# 1. Clone repository
git clone https://github.com/Kyugito666/TradeBot.git
cd TradeBot

# 2. Install dependency dashboard web
npm install
```

---

## Menjalankan Aplikasi

### Opsi A — Dashboard web saja (disarankan untuk mulai)

```bash
# Mode development (hot reload)
npm run dev
```

Lalu buka **http://localhost:3000** di browser. Dashboard langsung memuat data pasar publik (default OKX) tanpa perlu API key, sehingga Anda bisa langsung melihat sinyal, menjalankan analisis multi-agen, dan memakai mode paper trading.

```bash
# Mode production
npm run build
npm run start
```

### Opsi B — Menjalankan mesin Go + Rust (opsional, latensi rendah)

Skrip launcher akan mem-build Go engine dan Rust brain, menjalankannya, lalu memonitor/auto-restart prosesnya.

**Linux / macOS:**
```bash
./start_bot.sh            # build + jalankan engine, dashboard engine di http://localhost:8765
./start_bot.sh --status   # cek status proses & shared memory
./start_bot.sh --stop      # hentikan semua proses dan bersihkan state
```

**Windows:**
```bat
start_bot.bat
```

Saat aktif, gateway Go engine tersedia di **http://localhost:8765**, log ditulis ke `bot.log`. Agar dashboard web menunjuk ke engine ini, set `NEXT_PUBLIC_ENGINE_URL` (lihat bagian Environment Variables).

---

## Environment Variables

Semua variabel berikut **opsional** — aplikasi punya nilai default yang masuk akal sehingga bisa langsung jalan tanpa konfigurasi. Untuk men-set-nya saat pengembangan lokal, buat file `.env.local` di root project.

| Variabel | Default | Dipakai di | Keterangan |
|----------|---------|-----------|------------|
| `NEXT_PUBLIC_ENGINE_URL` | `http://localhost:8765` | `lib/engine.ts` | URL Go engine yang dituju dashboard. |
| `OKX_API_BASE` | `https://www.okx.com` | `lib/exchanges.ts` | Override base URL API OKX. |
| `BINANCE_API_BASE` | `https://fapi.binance.com` | `lib/exchanges.ts` | Override base URL API Binance Futures. |
| `BYBIT_API_BASE` | `https://api.bybit.com` | `lib/exchanges.ts` | Override base URL API Bybit. |
| `BITGET_API_BASE` | `https://api.bitget.com` | `lib/exchanges.ts` | Override base URL API Bitget. |
| `GATEIO_API_BASE` | `https://api.gateio.ws` | `lib/exchanges.ts` | Override base URL API Gate.io. |
| `MEXC_API_BASE` | `https://contract.mexc.com` | `lib/exchanges.ts` | Override base URL API MEXC Contract. |
| `AGENT_EVOLUTION_FILE` | *(internal default)* | `app/api/agents/route.ts` | Path file state evolusi/bobot agen. |

Contoh `.env.local`:

```env
NEXT_PUBLIC_ENGINE_URL=http://localhost:8765
OKX_API_BASE=https://www.okx.com
# AGENT_EVOLUTION_FILE=./agent_evolution.json
```

> Tidak ada API key/secret yang wajib diisi untuk menjalankan aplikasi dengan data pasar publik.

---

## Struktur Folder

Hanya direktori yang benar-benar ada di repo:

```
TradeBot/
├── app/                          # Next.js App Router
│   ├── api/
│   │   ├── agents/
│   │   │   ├── route.ts          # State & evolusi agen
│   │   │   └── analyze/route.ts  # Endpoint analisis multi-agen
│   │   ├── backtest/route.ts     # Endpoint backtesting
│   │   └── market/route.ts       # Data pasar real-time + sinyal
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── components/                   # Komponen UI dashboard
│   ├── dashboard.tsx             # Dashboard utama
│   ├── analysis-progress.tsx     # Progress pipeline 6 tahap
│   ├── agent-votes-panel.tsx     # Tampilan voting agen
│   ├── consensus-panel.tsx
│   ├── backtest-panel.tsx
│   ├── settings-panel.tsx
│   └── ... (panel & widget lain)
├── hooks/
│   ├── use-live-data.ts          # Data live + pemicu analisis
│   └── use-signal-trades.ts
├── lib/
│   ├── agents/                   # Sistem agen (TypeScript)
│   │   ├── types.ts
│   │   ├── registry.ts           # Registrasi agen
│   │   ├── builtin-agents.ts     # Agen bawaan
│   │   ├── pipeline.ts           # Pipeline analisis
│   │   ├── self-evaluation.ts    # Sistem pembelajaran
│   │   ├── config.ts
│   │   └── index.ts
│   ├── exchanges.ts              # Konfigurasi base URL exchange
│   ├── signals.ts                # Komputasi sinyal TA
│   ├── signal-engine.ts
│   ├── backtest.ts
│   ├── dry-run.ts                # Mesin paper trading
│   ├── engine.ts                 # Klien Go engine
│   ├── derive.ts / format.ts / utils.ts
│   ├── local-store.ts
│   └── types.ts
├── go-engine/                    # Mesin Go (opsional)
│   ├── main.go
│   ├── gateway/server.go         # Gateway HTTP/WebSocket (port 8765)
│   ├── market/                   # feed, state, backtest
│   ├── nlp/                      # engine, lexicon, scorer, scraper
│   ├── exchange/
│   │   ├── bybit/                # adapter + executor
│   │   └── mexc/                 # adapter + executor
│   ├── shm/bridge.go             # Bridge shared memory
│   ├── go.mod / go.sum
├── rust-brain/                   # Otak konsensus Rust (opsional)
│   ├── src/
│   │   ├── main.rs
│   │   ├── agents/               # Agen-agen (physicist, economist, dll.)
│   │   ├── consensus/mod.rs
│   │   ├── evolution/mod.rs
│   │   └── shm.rs
│   ├── Cargo.toml / Cargo.lock
├── shared/
│   └── shm_types.h               # Definisi ABI shared memory
├── start_bot.sh                  # Launcher Linux/macOS
├── start_bot.bat                 # Launcher Windows
├── package.json
└── README.md
```

---

## Build & Pemeriksaan

```bash
# Dashboard web (Next.js)
npm run build      # build produksi — pastikan selesai tanpa error
npm run lint       # pemeriksaan lint / type
npm run dev        # server pengembangan
npm run start      # menjalankan hasil build produksi
```

Build dianggap sukses jika `npm run build` selesai tanpa error dan seluruh route (`/`, `/api/agents`, `/api/agents/analyze`, `/api/backtest`, `/api/market`) terkompilasi.

**Mesin Go + Rust** (opsional) dibangun otomatis oleh skrip launcher. Untuk build manual:

```bash
# Go engine
cd go-engine && go build -o go-engine-bin . && cd ..

# Rust brain (release)
cd rust-brain && cargo build --release && cd ..
```

---

## Panduan Penggunaan

1. **Pantau sinyal pasar.** Setelah `npm run dev`, dashboard menampilkan sinyal live untuk simbol yang didukung berbasis data publik exchange.
2. **Jalankan analisis multi-agen.** Pilih simbol (mis. `BTCUSDT`) untuk menjalankan pipeline 6 tahap. Panel progress dan panel voting agen menunjukkan kontribusi tiap agen serta sinyal konsensus akhir (LONG/SHORT/WAIT) beserta entry/TP/SL.
3. **Gunakan mode paper trading (dry-run).** Aktif secara default. Atur saldo awal simulasi dan risiko per trade pada panel pengaturan. Saat muncul sinyal konsensus, posisi dibuka otomatis dan ditutup saat menyentuh TP/SL — tanpa order sungguhan.
4. **Biarkan agen belajar.** Hasil tiap trade (paper maupun nyata) diumpankan ke sistem self-evaluation: agen yang benar mendapat kenaikan bobot, yang salah dikurangi; rentetan kekalahan memicu evaluasi tim.
5. **Backtesting.** Gunakan panel/endpoint backtest untuk menguji perilaku strategi terhadap data historis.
6. **(Opsional) Hubungkan mesin Go/Rust.** Jalankan `./start_bot.sh` (atau `start_bot.bat`), lalu arahkan dashboard ke engine dengan `NEXT_PUBLIC_ENGINE_URL`.

**Batasan:** Trade sungguhan hanya terjadi bila mode dry-run dinonaktifkan **dan** engine trading live terhubung/terkonfigurasi. Tanpa itu, aplikasi sepenuhnya bersifat simulasi/analisis.

---

## API Endpoints

| Method | Endpoint | Fungsi |
|--------|----------|--------|
| `GET` | `/api/market` | Data pasar real-time beserta sinyal terkomputasi. |
| `GET` | `/api/agents/analyze?symbol=BTCUSDT` | Menjalankan analisis multi-agen untuk satu simbol. |
| `POST` | `/api/agents/analyze` | Mengirim hasil trade untuk self-evaluation agen. |
| `GET` | `/api/agents` | Mengambil state/evolusi agen. |
| `*` | `/api/backtest` | Endpoint backtesting strategi. |

Contoh respons `GET /api/agents/analyze`:

```json
{
  "ok": true,
  "symbol": "BTCUSDT",
  "consensus": {
    "signal": "LONG",
    "confidence": 0.72,
    "entry": 107500,
    "tp": 109200,
    "sl": 106300
  },
  "agentOutputs": [],
  "progress": { "stage": "complete", "currentStep": 6, "totalSteps": 6 }
}
```

---

## Troubleshooting

- **Dashboard tidak menampilkan data pasar.** Periksa koneksi internet; data diambil dari API publik exchange. Bila satu exchange diblokir/limit, set base URL alternatif via ENV (mis. `OKX_API_BASE`).
- **`npm run dev` gagal / error versi.** Pastikan Node.js memenuhi syarat (18+, idealnya 20.9+ untuk Next.js 16). Jalankan ulang `npm install` setelah mengganti versi Node.
- **Port 3000 sudah dipakai.** Jalankan dengan port lain, mis. `npm run dev -- -p 3001`.
- **`start_bot.sh` gagal: "Go not found" / "Rust not found".** Install Go (lihat `go-engine/go.mod` untuk versi) dan Rust via rustup, lalu pastikan `go` dan `cargo` ada di `PATH`.
- **"SHM not created" / Rust brain tidak start.** Go engine harus berhasil membuat segmen shared memory (`/dev/shm/tradebot_v3`) lebih dulu. Jalankan `./start_bot.sh --stop` untuk membersihkan state lama, lalu start ulang. Cek detail di `bot.log`.
- **Dashboard tidak terhubung ke engine.** Pastikan Go engine berjalan di `http://localhost:8765` (`./start_bot.sh --status`) dan `NEXT_PUBLIC_ENGINE_URL` menunjuk ke alamat yang benar.
- **Proses mati di tengah jalan.** `start_bot.sh` memiliki monitor yang otomatis me-restart Go engine/Rust brain; periksa `bot.log` untuk penyebabnya.

---

## Kontribusi

Kontribusi dipersilakan dengan alur sederhana:

1. Fork repository ini.
2. Buat branch fitur: `git checkout -b fitur/nama-fitur`.
3. Lakukan perubahan, lalu pastikan `npm run build` dan `npm run lint` lulus.
4. Commit dengan pesan yang jelas dan ringkas.
5. Push ke fork Anda dan buka Pull Request ke branch utama, sertakan deskripsi singkat perubahan.

Untuk menambah agen baru pada sistem TypeScript, daftarkan agen melalui registry di `lib/agents/` (lihat `registry.ts` dan `builtin-agents.ts`).

---

## Lisensi

Berdasarkan dokumentasi internal repo (`RUNNING.md`), project ini menggunakan lisensi **MIT**. Saat ini belum ada berkas `LICENSE` terpisah di repository; disarankan menambahkan file `LICENSE` (MIT) agar lisensi tercatat secara eksplisit.
