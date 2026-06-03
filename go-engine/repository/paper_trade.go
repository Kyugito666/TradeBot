package repository

import (
	"database/sql"
	"fmt"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"tradebot/go-engine/gateway"
)

type PaperTradeRepo struct {
	db *sql.DB
	mu sync.Mutex
}

func NewPaperTradeRepo(dbPath string) (*PaperTradeRepo, error) {
	// Enable WAL mode
	dsn := fmt.Sprintf("%s?_journal_mode=WAL&_synchronous=NORMAL", dbPath)
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, err
	}

	repo := &PaperTradeRepo{db: db}
	if err := repo.init(); err != nil {
		return nil, err
	}

	return repo, nil
}

func (r *PaperTradeRepo) init() error {
	query := `
	CREATE TABLE IF NOT EXISTS paper_trades (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		symbol TEXT NOT NULL,
		side TEXT NOT NULL,
		entry_price REAL,
		limit_price REAL,
		take_profit REAL,
		stop_loss REAL,
		time TEXT,
		status TEXT,
		pnl REAL,
		margin REAL,
		opened_at DATETIME,
		is_active BOOLEAN DEFAULT 1
	);
	CREATE INDEX IF NOT EXISTS idx_paper_trades_active ON paper_trades(is_active);
	CREATE INDEX IF NOT EXISTS idx_paper_trades_symbol ON paper_trades(symbol);
	`
	_, err := r.db.Exec(query)
	return err
}

func (r *PaperTradeRepo) SaveActiveTrades(activeTrades map[string]*gateway.Position, openedAts map[string]time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Clear all currently active trades in DB
	_, err = tx.Exec("UPDATE paper_trades SET is_active = 0 WHERE is_active = 1")
	if err != nil {
		return err
	}

	stmt, err := tx.Prepare(`
		INSERT INTO paper_trades 
		(symbol, side, entry_price, limit_price, take_profit, stop_loss, time, status, pnl, margin, opened_at, is_active)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
	`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for sym, pos := range activeTrades {
		openedAt := openedAts[sym]
		_, err := stmt.Exec(
			pos.Symbol, pos.Side, pos.EntryPrice, pos.LimitPrice, 
			pos.TakeProfit, pos.StopLoss, pos.Time, pos.Status, 
			pos.PnL, pos.Margin, openedAt,
		)
		if err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (r *PaperTradeRepo) SaveHistory(pos *gateway.Position, openedAt time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	query := `
		INSERT INTO paper_trades 
		(symbol, side, entry_price, limit_price, take_profit, stop_loss, time, status, pnl, margin, opened_at, is_active)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
	`
	_, err := r.db.Exec(query, 
		pos.Symbol, pos.Side, pos.EntryPrice, pos.LimitPrice, 
		pos.TakeProfit, pos.StopLoss, pos.Time, pos.Status, 
		pos.PnL, pos.Margin, openedAt)
	return err
}

func (r *PaperTradeRepo) LoadState() (map[string]*gateway.Position, map[string]time.Time, []gateway.Position, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	activeTrades := make(map[string]*gateway.Position)
	openedAts := make(map[string]time.Time)
	var history []gateway.Position

	// Load active trades
	rows, err := r.db.Query(`
		SELECT symbol, side, entry_price, limit_price, take_profit, stop_loss, time, status, pnl, margin, opened_at
		FROM paper_trades WHERE is_active = 1
	`)
	if err != nil {
		return nil, nil, nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var pos gateway.Position
		var openedAt time.Time
		err := rows.Scan(
			&pos.Symbol, &pos.Side, &pos.EntryPrice, &pos.LimitPrice,
			&pos.TakeProfit, &pos.StopLoss, &pos.Time, &pos.Status,
			&pos.PnL, &pos.Margin, &openedAt,
		)
		if err != nil {
			return nil, nil, nil, err
		}
		activeTrades[pos.Symbol] = &pos
		openedAts[pos.Symbol] = openedAt
	}

	// Load history (last 50)
	histRows, err := r.db.Query(`
		SELECT symbol, side, entry_price, limit_price, take_profit, stop_loss, time, status, pnl, margin
		FROM paper_trades WHERE is_active = 0
		ORDER BY id DESC LIMIT 50
	`)
	if err != nil {
		return activeTrades, openedAts, nil, err
	}
	defer histRows.Close()

	for histRows.Next() {
		var pos gateway.Position
		err := histRows.Scan(
			&pos.Symbol, &pos.Side, &pos.EntryPrice, &pos.LimitPrice,
			&pos.TakeProfit, &pos.StopLoss, &pos.Time, &pos.Status,
			&pos.PnL, &pos.Margin,
		)
		if err != nil {
			return activeTrades, openedAts, history, err
		}
		history = append(history, pos)
	}

	return activeTrades, openedAts, history, nil
}
