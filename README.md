<div align="center">

<img src="icons/icon128.png" width="96" alt="Web MCP Bridge (Fork)">

# Web MCP Bridge (Fork)

**Gunakan MCP server lokal dari ChatGPT, Gemini, Claude Web, dan DeepSeek: tanpa API key, tanpa langganan tambahan.**

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-0f766e?style=flat-square&logo=googlechrome&logoColor=white)](https://github.com/ranggaas6/web-mcp-bridge)
![License MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)
![Python](https://img.shields.io/badge/Python-3.9%2B-3776AB?style=flat-square&logo=python&logoColor=white)
![Chrome | Edge | Brave](https://img.shields.io/badge/Chrome%20%7C%20Edge%20%7C%20Brave-116%2B-informational?style=flat-square)

</div>

---

> **Web MCP Bridge (Fork)** memungkinkan versi web gratis ChatGPT, Gemini, Claude, dan DeepSeek **memakai tool di komputer Anda**: membaca berkas, mengontrol program, mengakses data, tanpa API key dan tanpa langganan tambahan. **Anda menyetujui setiap aksi.**

> [!NOTE]
> Ini adalah **fork** dari [AstraxOf/web-mcp-bridge](https://github.com/AstraxOf/web-mcp-bridge) yang bisa dipasang **berdampingan** dengan upstream pada browser dan mesin yang sama. Ini adalah bridge yang dipakai proyek [Easy-Vibe](https://github.com/ranggaas6/Easy-Vibe).
>
> Perbedaan dari upstream:
>
> | | Upstream | Fork ini |
> |---|---|---|
> | Nama ekstensi | Web MCP Bridge | Web MCP Bridge (Fork) |
> | `chrome.storage` | `wmb_*` | `wmbx_*` |
> | `sessionStorage` | `wmb:*` | `wmbx:*` |
> | Penanda injeksi | `[WMB:...]` | `[WMBX:...]` |
> | Web Lock | `wmb-alive` | `wmbx-alive` |
> | Port kontrol | 8099 | 8199 |
> | Port launcher | 8098 | 8198 |
> | Port hub | 8090 | 8190 |
> | Izin native messaging | tidak | ya |

> [!IMPORTANT]
> Hanya hubungkan MCP server yang Anda percaya. Tool dengan akses filesystem bisa membaca apa pun yang Anda izinkan.

## Cara kerja (20 detik)

Dua bagian bekerja bersama:

| Bagian | Apa itu | Di mana |
|---|---|---|
| Ekstensi | Dipasang di browser. Membaca permintaan AI, menampilkan tombol dan izin. | Chrome, Edge, Brave |
| Bridge | Program Python kecil yang menghubungkan ekstensi ke tool (MCP server). | Komputer Anda, di latar belakang |

1. Anda bertanya ke AI di chat.
2. AI menjawab dengan blok JSON yang meminta tool.
3. Ekstensi meminta izin, menjalankan tool di PC, lalu **menempelkan hasilnya kembali ke chat** agar AI melanjutkan.

## Pemicu otomatis via tab DeepSeek (khusus fork ini)

Fork ini menambahkan **native messaging host** sehingga bridge tidak perlu dinyalakan manual dan tidak berjalan 24 jam:

1. Anda membuka tab `chat.deepseek.com` di Brave.
2. Service worker (`background/index.js`) memuat `background/native_host.js`.
3. Modul itu mengirim `{action:"start"}` ke native host `com.ranggaas6.easy_vibe`.
4. Native host menjalankan `~/.easy-vibe/start-easy-vibe.fish` dan mencatat PID ke `~/.easy-vibe/bridge.pid`.
5. Bridge hidup, `coding-mcp` dan `filesystem` tersedia di port masing-masing.
6. Saat tab DeepSeek terakhir ditutup, modul mengirim `{action:"stop"}`; native host mematikan bridge dan child server-nya.
7. Jika Brave ditutup, stdin native host mendapat EOF dan host juga mematikan bridge.

Native host, manifest Brave, dan skrip `install.fish` disediakan oleh repo [Easy-Vibe](https://github.com/ranggaas6/Easy-Vibe). Tanpa native host terpasang, tombol **Start/Stop** di popup tetap berfungsi seperti upstream, tetapi pemicu tab DeepSeek tidak aktif.

## Yang Anda butuhkan

- **Chrome, Edge, atau Brave** versi 116+
- **Python 3.9+**
- **Proyek ini diunduh** (Code -> Download ZIP, atau `git clone`), disimpan di folder permanen karena ekstensi memuat dari sana.
- Opsional: **Node.js** jika memakai MCP server via `npx`.

## Instalasi (Windows)

1. Buka folder `server`, klik dua kali `install.cmd`. Tunggu sampai *Done*.
2. Ketik `chrome://extensions` (Edge: `edge://extensions`).
3. Aktifkan **Developer mode**, klik **Load unpacked**, pilih folder proyek.
4. Sematkan ekstensi lewat ikon puzzle.

## Instalasi (macOS / Linux)

```bash
python3 server/install_service.py
```

Lalu muat ekstensi seperti langkah 2 di atas. Untuk pemasangan lengkap dengan pemicu tab DeepSeek di CachyOS, gunakan installer Easy-Vibe, bukan langkah ini.

## Kontrol bridge dari ekstensi

Di popup, kartu bridge:

| Tombol | Fungsi |
|---|---|
| **Start** | Menyalakan bridge (jika mati) |
| **Stop** | Mematikan bridge dan membiarkannya mati sampai Anda menyalakan lagi |
| **Restart** | Menutup dan membuka ulang |
| **JSON editor / Add MCP** | Membuka editor `servers.json` dengan validasi langsung |

Sakelar besar di header hanya membuat ekstensi berhenti bertindak (ikon `OFF`). **Stop** mematikan program di PC.

## Pertama kali (60 detik)

Proyek menyertakan **demo server (`demo`)** untuk uji cepat tanpa memasang apa pun.

1. Buka popup, tab Servers, nyalakan sakelar **demo**.
2. Buka ChatGPT, Gemini, Claude, atau DeepSeek.
3. Ketik misalnya: "Jam berapa sekarang? Pakai tool."
4. AI meminta tool, muncul prompt, klik **Run**.
5. Hasilnya ditempel ke chat dan AI menjawab.

Secara default izinnya **Always ask**: tidak ada yang berjalan tanpa persetujuan Anda.

## Menambah MCP server sendiri

Server didefinisikan di `server/servers.json`. Contoh:

```json
{
  "control_port": 8199,
  "launcher_port": 8198,
  "servers": [
    { "name": "demo",   "port": 8190, "command": ["python", "server/examples/demo_mcp_server.py"] },
    { "name": "my-mcp", "port": 8181, "command": ["python", "-m", "my_mcp_server"] }
  ]
}
```

Klik **JSON editor / Add MCP** di popup, simpan, dan dalam ~2 detik server muncul di daftar. Maksimum **5** sekaligus; **1** lebih hemat token. Untuk menonaktifkan: tambahkan `"disabled": true`.

Contoh `servers.json` yang ditulis Easy-Vibe memakai path absolut agar tidak bergantung pada PATH:

```json
{
  "control_port": 8199,
  "launcher_port": 8198,
  "servers": [
    { "name": "coding-mcp", "port": 8190, "command": ["/home/USER/.npm-global/bin/coding-mcp", "serve", "--transport", "stdio"] },
    { "name": "filesystem", "port": 8192, "command": ["/home/USER/go/bin/mcp-filesystem-server", "/home/USER"] }
  ]
}
```

## Troubleshooting

| Gejala | Perbaikan |
|---|---|
| Popup bilang "Bridge is off" | Klik **Start**, atau buka tab DeepSeek jika native host terpasang. |
| "Launcher missing" | Normal pada instalasi manual: jalankan `server/install.cmd` sekali. |
| `python` tidak dikenali | Pasang ulang Python dengan **Add Python to PATH**, atau coba `py`. |
| "Port in use" | Klik **Restart**, atau ubah `port` server itu. |
| Notifikasi merah "servers.json has an error" | Ada koma atau kutip salah tempat. Perbaiki dan simpan. |
| Chat tidak bereaksi | Muat ulang tab (F5) dan pastikan sakelar header menyala. |
| Pemicu tab DeepSeek tidak jalan | Pastikan manifest `com.ranggaas6.easy_vibe.json` ada di folder NativeMessagingHosts Brave dan `allowed_origins` memuat ID ekstensi Anda. |
| `Access to the specified native messaging host is forbidden` | `allowed_origins` tidak cocok dengan ID ekstensi. Jalankan ulang installer Easy-Vibe dengan `--extension-id`. |

## Platform yang didukung

| Platform | Adapter |
|---|---|
| ChatGPT | `adapters/chatgpt.js` |
| Gemini | `adapters/gemini.js` |
| Claude | `adapters/claude.js` |
| DeepSeek | `adapters/deepseek.js` |

## Protokol panggilan

```json
{ "mcp_call": { "server": "server_name", "name": "tool_name", "arguments": { "arg1": "value" } } }
```

Hasil dikembalikan sebagai:

```
[MCP_RESULT server="..." tool="..." status="ok|error|rejected"]
...
[/MCP_RESULT]
```

Isi `MCP_RESULT` diperlakukan sebagai *data*, bukan instruksi (mitigasi prompt injection).

## Model keamanan

| Risiko | Mitigasi |
|---|---|
| Situs membuka `ws://localhost` dan menjalankan tool | Bridge menolak `Origin` yang bukan ekstensi browser. |
| AI menjalankan aksi yang tidak diinginkan | "Always ask" adalah default; pilihan eksplisit per MCP. |
| Instruksi tersembunyi dalam hasil | Prompt menandai `MCP_RESULT` sebagai data saja. |
| Eksposur jaringan | Hanya mendengarkan `127.0.0.1`; token opsional (`--token`). |
| Situs membaca/mematikan port kontrol atau launcher | Hanya menerima `Origin` ekstensi dan `Host` lokal. |

## Kontribusi

Fork ini menerima issue dan pull request di [ranggaas6/web-mcp-bridge](https://github.com/ranggaas6/web-mcp-bridge).

<div align="center">

Fork dikelola oleh [@ranggaas6](https://github.com/ranggaas6). Proyek upstream oleh [@AstraxOf](https://github.com/AstraxOf).

**[MIT License](LICENSE)**

</div>
