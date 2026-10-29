package store

import (
	"database/sql"
	"encoding/json"
	"time"
)

// OIDCGroupStore keeps the IdP group IDs of each user's last SSO login. An SSO
// session carries its groups in the JWT; an API token has no login of its own,
// so it can only borrow the owner's last snapshot, and only while it is recent.
type OIDCGroupStore interface {
	// SaveOIDCGroups replaces the user's snapshot (an empty list is a snapshot too:
	// the user is in no group).
	SaveOIDCGroups(userID int, groups []string) error
	// OIDCGroups returns the snapshot when it is younger than maxAge, else nil.
	OIDCGroups(userID int, maxAge time.Duration) ([]string, error)
}

// PostgresOIDCGroupStore implements OIDCGroupStore (table user_oidc_groups).
type PostgresOIDCGroupStore struct {
	db *DB
}

func NewPostgresOIDCGroupStore(db *DB) *PostgresOIDCGroupStore {
	return &PostgresOIDCGroupStore{db: db}
}

func (s *PostgresOIDCGroupStore) SaveOIDCGroups(userID int, groups []string) error {
	if groups == nil {
		groups = []string{}
	}
	_, err := s.db.Exec(
		`INSERT INTO user_oidc_groups (user_id, groups, captured_at) VALUES ($1, $2, now())
		 ON CONFLICT (user_id) DO UPDATE SET groups = EXCLUDED.groups, captured_at = EXCLUDED.captured_at`,
		userID, groups,
	)
	return err
}

func (s *PostgresOIDCGroupStore) OIDCGroups(userID int, maxAge time.Duration) ([]string, error) {
	if maxAge <= 0 {
		return nil, nil
	}
	var raw string
	err := s.db.QueryRow(
		`SELECT array_to_json(groups)::text FROM user_oidc_groups
		 WHERE user_id = $1 AND captured_at > now() - make_interval(secs => $2)`,
		userID, maxAge.Seconds(),
	).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var groups []string
	if err := json.Unmarshal([]byte(raw), &groups); err != nil {
		return nil, err
	}
	return groups, nil
}
