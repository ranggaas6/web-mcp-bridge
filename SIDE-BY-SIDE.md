# Instalasi Berdampingan dengan Upstream

Dokumen ini menjelaskan cara menjalankan **fork ini** bersama-sama dengan upstream [AstraxOf/web-mcp-bridge](https://github.com/AstraxOf/web-mcp-bridge) di Chrome/Edge/Brave yang sama tanpa saling menimpa.

## Ringkasan perbedaan

| Aspek | Upstream | Fork ini |
|---|---|---|
| Nama ekstensi | Web MCP Bridge | Web MCP Bridge (Fork) |
| Namespace storage | `wmb_*` | `wmbx_*` |
| Port kontrol bridge | 8099 | 8199 |
| Port launcher | 8098 | 8198 |
| Port server demo | 8090 | 8190 |
| Sumber `notices.json` | `AstraxOf/web-mcp-bridge` | `ranggaas6/web-mcp-bridge` |
| Izin host `raw.githubusercontent.com` | `AstraxOf/*` | `ranggaas6/*` |

Semua nilai ini didefinisikan di `shared/constants.js` dan `manifest.json`.

## Mengapa port harus berbeda

Dua proses bridge Python tidak bisa bind ke port yang sama. Jika upstream memakai 8099, fork memakai 8199. Hal yang sama berlaku untuk port launcher (8098 vs 8198) dan port server demo (8090 vs 8190).

Jika Anda mengubah port di `servers.json` milik fork, pastikan `DEFAULT_CONTROL_PORT` di `shared/constants.js` dan `controlPort` di `DEFAULT_SETTINGS` ikut disesuaikan, lalu muat ulang ekstensi.

## Langkah instalasi berdampingan

### 1. Clone fork

```bash
git clone https://github.com/ranggaas6/web-mcp-bridge ~/web-mcp-bridge-fork
```

### 2. Siapkan `servers.json` untuk fork

```bash
cp ~/web-mcp-bridge-fork/server/servers.example.json \
   ~/web-mcp-bridge-fork/server/servers.json
```

Contoh `servers.json` memakai `control_port: 8199`. Jangan ubah ke 8099 jika upstream sedang berjalan.

### 3. Jalankan bridge fork

```bash
cd ~/web-mcp-bridge-fork
python server/mcp_ws_bridge.py --config server/servers.json
```

Bridge fork mendengarkan di `127.0.0.1:8199`.

### 4. Muat kedua ekstensi di browser

1. Buka `chrome://extensions` (atau `edge://extensions` / `brave://extensions`).
2. Aktifkan **Developer mode**.
3. Klik **Load unpacked** untuk upstream: pilih folder `web-mcp-bridge` asli.
4. Klik **Load unpacked** lagi untuk fork: pilih `~/web-mcp-bridge-fork`.

Kedua ekstensi akan muncul dengan nama berbeda di daftar: "Web MCP Bridge" dan "Web MCP Bridge (Fork)".

### 5. Set port kontrol di panel masing-masing

- Di popup **Web MCP Bridge** (upstream): biarkan `controlPort` di 8099.
- Di popup **Web MCP Bridge (Fork)**: pastikan `controlPort` di 8199.

Nilai ini tersimpan di `chrome.storage.local` masing-masing ekstensi dengan namespace berbeda (`wmb_` vs `wmbx_`), jadi tidak akan saling menimpa.

### 6. Verifikasi

Buka `https://chat.deepseek.com`. Kedua ekstensi akan menyuntikkan widget masing-masing. Karena keduanya memakai adapter yang sama, pastikan Anda hanya mengaktifkan salah satu pada satu waktu lewat popup ekstensi, atau biarkan keduanya aktif jika Anda memang ingin dua jalur tool sekaligus (tidak disarankan karena konteks model akan membengkak).

## Yang tidak berubah dari upstream

- Format protokol MCP (`PROTOCOL_VERSION`).
- Format panggilan `{"mcp_call":{"server":"...","name":"...","arguments":{...}}}`.
- Skema `servers.json`.
- Dukungan adapter ChatGPT, Gemini, Claude, dan DeepSeek.

Artinya, server MCP yang sama (`gitrs-mcp`, `mcp-filesystem-server`, atau `gitdesktop-mcp`) bisa dipakai oleh bridge upstream maupun fork, asalkan didaftarkan di kedua `servers.json`.

## Membersihkan

- Hapus ekstensi fork dari `chrome://extensions`.
- Hapus folder clone fork.
- Port 8199/8198/8190 otomatis bebas ketika proses bridge fork dihentikan.

Tidak ada langkah khusus untuk upstream; ekstensi dan bridge upstream tidak tersentuh.
