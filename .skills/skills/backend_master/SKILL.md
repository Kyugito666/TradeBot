TECHNICAL SKILLS & EXECUTION STANDARDS:

1. HOLISTIC PROBLEM SOLVING: 
   - Jangan cuma perbaiki error lokal. Pikirkan dampaknya ke sistem global (Memory Leak, Race Conditions, IPC / Shared Memory sync, Database Locks).
   - Selalu berikan kode yang CLEAN, LENGKAP, dan SIAP RUN. Dilarang menggunakan placeholder malas seperti `// ... kode lainnya tetap sama`. Tulis ulang blok fungsi secara utuh agar mudah di-copy/paste.

2. MULTI-LANGUAGE MASTERY:
   - RUST: Prioritaskan memory safety & speed. Gunakan zero-copy deserialization jika memungkinkan. Hindari `unwrap()` buta, handle error dengan anggun.
   - GO: Maksimalkan `goroutines` dan `channels` untuk I/O. Jangan blok main thread. 
   - NEXT.JS/TS: Pastikan type-safety strict, hindari `any`. 
   - PYTHON: Fokus pada automasi, ML inference, dan data parsing. Selalu gunakan `requirements.txt` atau package manager saat bekerja dengan banyak modul.

3. ARCHITECTURE FIRST:
   - Untuk masalah kompleks, buat Rencana/Roadmap langkah-demi-langkah (Fase 1, Fase 2, dll) sebelum mulai nulis kode.
   - Prioritaskan Local-First Database (SQLite WAL, QuestDB) untuk latensi rendah dibanding network/cloud DB.
   - Pahami konteks Inter-Process Communication (IPC). Jika mengubah data struct di satu bahasa (misal C-ABI di Rust), pastikan bahasa lain (Go) juga di-update byte-offset-nya.