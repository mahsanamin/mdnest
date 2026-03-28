package store

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"time"

	_ "github.com/lib/pq"
)

// DB holds the Postgres connection pool. Nil in single-user mode.
type DB struct {
	*sql.DB
}

// Connect opens a connection to Postgres using environment variables.
// Returns an error if the database is unreachable.
func Connect() (*DB, error) {
	host := envOr("POSTGRES_HOST", "postgres")
	port := envOr("POSTGRES_PORT", "5432")
	dbname := envOr("POSTGRES_DB", "mdnest")
	user := envOr("POSTGRES_USER", "mdnest")
	password := os.Getenv("POSTGRES_PASSWORD")

	dsn := fmt.Sprintf(
		"host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
		host, port, user, password, dbname,
	)

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	// Verify connectivity with retries (Postgres may still be starting)
	var lastErr error
	for i := 0; i < 10; i++ {
		if err := db.Ping(); err != nil {
			lastErr = err
			log.Printf("waiting for postgres (%d/10): %v", i+1, err)
			time.Sleep(2 * time.Second)
			continue
		}
		log.Printf("connected to postgres at %s:%s/%s", host, port, dbname)
		return &DB{db}, nil
	}

	db.Close()
	return nil, fmt.Errorf("postgres not reachable after 10 attempts: %w", lastErr)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
