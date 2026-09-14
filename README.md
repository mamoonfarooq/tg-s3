# TG-S3

**Telegram-backed S3-Compatible Object Storage Gateway**

TG-S3 turns Telegram supergroups/channels into a high-performance, S3-compatible object storage server. Built as a standalone Node.js ESM server using Hono, SQLite (`better-sqlite3`), Content-Addressable Storage (CAS) chunking, and MTProto via `@mtcute/node`.

---

## Key Features

- **S3-Compatible API** — Works seamlessly with S3 tools (`aws-cli`, `rclone`, MinIO client, AWS SDKs) with AWS SigV4 authentication, presigned URLs, and multipart uploads.
- **Telegram MTProto Storage** — Uploads and retrieves media chunks directly via Telegram MTProto (`@mtcute/node`) for unlimited persistent cloud storage.
- **CAS Chunking & Deduplication** — Large files are split into configurable chunks (default: 10MB) with SHA-256 hash deduplication. Identical file chunks across any bucket or file are stored only once.
- **Local Caching Layer** — Frequently accessed chunks are cached locally in `./data/cache` to deliver sub-second retrieval speeds and minimize Telegram API requests.
- **Embedded SQLite Database** — Metadata, credentials, bucket objects, and chunk maps are stored locally in a high-performance `better-sqlite3` database running in WAL mode.
- **Interactive MTProto Auth CLI** — Built-in `npm run login` CLI utility to authenticate your Telegram user account and generate string sessions.

---

## Architecture Overview

```
                        ┌──────────────────────────────────────────────┐
                        │              S3 Client / App                 │
                        └──────────────────────┬───────────────────────┘
                                               │ (S3 API - SigV4 / Presigned)
                                               ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                 TG-S3 Node.js Server                                   │
│                                                                                         │
│  ┌───────────────────────┐   ┌───────────────────────────┐   ┌───────────────────────┐  │
│  │   Hono HTTP Server    │──▶│   CAS Engine (Chunking)   │──▶│ Local Disk Cache      │  │
│  │  (S3 Handlers & Auth) │   │   (SHA-256 Deduplication) │   │ (./data/cache)        │  │
│  └───────────┬───────────┘   └─────────────┬─────────────┘   └───────────────────────┘  │
│              │                             │                                            │
│              ▼                             ▼                                            │
│  ┌───────────────────────┐   ┌───────────────────────────┐                              │
│  │ SQLite Metadata DB    │   │  Telegram MTProto Client  │                              │
│  │ (./data/tg-s3.db)     │   │      (@mtcute/node)       │                              │
│  └───────────────────────┘   └─────────────┬─────────────┘                              │
└────────────────────────────────────────────┼────────────────────────────────────────────┘
                                             │ (Upload / Download Chunks)
                                             ▼
                        ┌──────────────────────────────────────────────┐
                        │          Telegram Supergroup / Channel       │
                        └──────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

1. **Node.js 22+**
2. **Telegram API ID & API Hash** from [my.telegram.org](https://my.telegram.org)
3. **Telegram Storage Supergroup / Channel ID** (e.g. `-1001234567890`)

---

### Step 1: Installation & Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/gps949/tg-s3.git
cd tg-s3
npm install
```

---

### Step 2: Configure Environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env`:
```env
PORT=3000
S3_ADMIN_KEY=admin
S3_ADMIN_SECRET=adminsecret

TG_APP_ID=123456
TG_APP_HASH=your_api_hash_here
TG_GROUP_ID=-1001234567890
```

---

### Step 3: Telegram Login Authentication

Run the login script to authenticate your Telegram user account and generate your session string:

```bash
npm run login
```

Follow the interactive prompts:
1. Enter your phone number (e.g. `+1234567890`)
2. Enter the login code received in Telegram
3. Enter your 2FA password (if enabled)

Copy the resulting `TG_SESSION=...` string into your `.env` file.

---

### Step 4: Start Server

Development mode with auto-reload:
```bash
npm run dev
```

Production build and start:
```bash
npm run build
npm start
```

The S3 server will be listening at `http://localhost:3000`.

---

## Usage Examples

### AWS CLI

Configure credentials:
```bash
aws configure set aws_access_key_id admin
aws configure set aws_secret_access_key adminsecret
aws configure set default.region us-east-1
```

List buckets / objects:
```bash
aws --endpoint-url http://localhost:3000 s3 ls
```

Upload a file:
```bash
aws --endpoint-url http://localhost:3000 s3 cp myfile.txt s3://mybucket/myfile.txt
```

Download a file:
```bash
aws --endpoint-url http://localhost:3000 s3 cp s3://mybucket/myfile.txt downloaded.txt
```

---

### Rclone

Add TG-S3 remote configuration:
```bash
rclone config create tgs3 s3 \
  provider=Other \
  access_key_id=admin \
  secret_access_key=adminsecret \
  endpoint=http://localhost:3000 \
  acl=private
```

List objects:
```bash
rclone ls tgs3:default
```

Sync directory:
```bash
rclone sync ./my-folder tgs3:default/my-folder
```

---

## Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port for the HTTP server |
| `S3_ADMIN_KEY` | `admin` | S3 Access Key ID for authentication |
| `S3_ADMIN_SECRET` | `adminsecret` | S3 Secret Access Key for authentication |
| `S3_REGION` | `us-east-1` | S3 Region name |
| `TG_APP_ID` | *Required* | Telegram API ID from my.telegram.org |
| `TG_APP_HASH` | *Required* | Telegram API Hash from my.telegram.org |
| `TG_SESSION` | *Required* | Session string generated by `npm run login` |
| `TG_GROUP_ID` | *Required* | Telegram Supergroup or Channel ID for storage |
| `CHUNK_SIZE` | `10485760` | CAS chunk size in bytes (default: 10MB) |
| `DATABASE_PATH` | `./data/tg-s3.db` | Path to SQLite metadata database |
| `CACHE_DIR` | `./data/cache` | Path for local chunk cache |
| `TEMP_DIR` | `./data/temp` | Temporary staging directory for uploads |
| `CACHE_RETENTION_DAYS` | `7` | Days to retain chunks in local cache |

---

## Documentation

- [Configuration Reference](docs/configuration.md)
- [S3 Compatibility Specification](docs/S3-COMPAT.md)

---

## License

MIT License. See [LICENSE](LICENSE) for details.
