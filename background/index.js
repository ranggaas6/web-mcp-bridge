/**
 * index.js — Entry point service worker.
 *
 * Memuat modul pemicu native host lebih dulu, lalu logika background utama.
 * Dipisah agar background.js (besar) tidak perlu diubah saat menambah modul.
 */
import './native_host.js';
import './background.js';
