package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"tradebot/data-gateway/api"
)

func main() {
	log.Println("[Gateway] Inisialisasi Go Data Gateway v1.0...")

	// 1. Inisialisasi HTTP Multiplexer
	mux := http.NewServeMux()

	// 2. Registrasi Endpoints untuk dikonsumsi oleh GatewayClient (Python)
	mux.HandleFunc("/api/health", api.HealthCheckHandler)
	mux.HandleFunc("/api/ohlcv", api.FetchOHLCVHandler)
	mux.HandleFunc("/api/oi", api.FetchOpenInterestHandler)
	mux.HandleFunc("/api/lsr", api.FetchLSRHandler)

	// 3. Konfigurasi Server Teroptimasi
	server := &http.Server{
		Addr:         ":7890",
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// 4. Eksekusi asinkron pada goroutine
	go func() {
		log.Println("[Gateway] Menunggu koneksi di http://localhost:7890")
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[Gateway] Peladen terhenti karena kegagalan kritis: %v", err)
		}
	}()

	// 5. Intersepsi Sinyal Terminasi (Graceful Shutdown)
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	
	log.Println("[Gateway] Sinyal terminasi diterima. Menutup koneksi berjalan...")

	// Beri toleransi 5 detik agar request yang sedang diproses (seperti polling CEX) dapat selesai
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("[Gateway] Terminasi paksa dengan kesalahan: %v", err)
	}

	log.Println("[Gateway] Shutdown berhasil. Lingkungan eksekusi bersih.")
}