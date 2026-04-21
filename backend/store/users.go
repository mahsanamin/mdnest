package store

import (
	"database/sql"
	"fmt"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// User represents a row in the users table.
// In Firebase mode, PasswordHash is empty and FirebaseUID points at the
// Firebase Auth UID. In local mode, FirebaseUID is nil.
type User struct {
	ID                 int
	Email              string
	Username           string
	PasswordHash       string
	FirebaseUID        *string // nil for local-mode users
	Role               string  // "admin" or "collaborator"
	InvitedBy          *int
	CreatedAt          time.Time
	MustChangePassword bool
	TOTPSecret         *string // base32-encoded TOTP secret (nil if not set up)
	TOTPEnabled        bool
	RecoveryCodes      *string // JSON array of hashed recovery codes (nil if not set up)
	Blocked            bool
}

// UserStore defines user CRUD operations.
type UserStore interface {
	CreateUser(email, username, password, role string, invitedBy *int) (*User, error)
	GetUserByUsername(username string) (*User, error)
	GetUserByEmail(email string) (*User, error)
	GetUserByID(id int) (*User, error)
	GetUserByFirebaseUID(uid string) (*User, error)
	ListUsers() ([]User, error)
	UpdatePassword(userID int, newPassword string) error
	UpdateRole(userID int, role string) error
	DeleteUser(id int) error
	CountUsers() (int, error)
	SetMustChangePassword(userID int, must bool) error
	SetTOTP(userID int, secret string, recoveryCodes string) error
	EnableTOTP(userID int) error
	DisableTOTP(userID int) error
	ClearMustChangePassword(userID int) error
	SetBlocked(userID int, blocked bool) error
	AdminResetPassword(userID int, newPassword string) error

	// Firebase identity federation.
	UpsertFirebaseUser(email, firebaseUID, displayName string, adminEmails map[string]bool) (*User, error)
	PromoteToAdmin(email string) (bool, error)
}

// PostgresUserStore implements UserStore against a Postgres database.
type PostgresUserStore struct {
	db *DB
}

// NewPostgresUserStore creates a new PostgresUserStore.
func NewPostgresUserStore(db *DB) *PostgresUserStore {
	return &PostgresUserStore{db: db}
}

const userColumns = `id, email, username, password_hash, firebase_uid, role, invited_by, created_at, must_change_password, totp_secret, totp_enabled, recovery_codes, blocked`

func (s *PostgresUserStore) CreateUser(email, username, password, role string, invitedBy *int) (*User, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	return s.scanUser(
		`INSERT INTO users (email, username, password_hash, role, invited_by, must_change_password)
		 VALUES ($1, $2, $3, $4, $5, true)
		 RETURNING `+userColumns,
		email, username, string(hash), role, invitedBy,
	)
}

func (s *PostgresUserStore) GetUserByUsername(username string) (*User, error) {
	return s.scanUser(`SELECT `+userColumns+` FROM users WHERE username = $1`, username)
}

func (s *PostgresUserStore) GetUserByEmail(email string) (*User, error) {
	return s.scanUser(`SELECT `+userColumns+` FROM users WHERE email = $1`, email)
}

func (s *PostgresUserStore) GetUserByID(id int) (*User, error) {
	return s.scanUser(`SELECT `+userColumns+` FROM users WHERE id = $1`, id)
}

func (s *PostgresUserStore) GetUserByFirebaseUID(uid string) (*User, error) {
	return s.scanUser(`SELECT `+userColumns+` FROM users WHERE firebase_uid = $1`, uid)
}

// scanUserRow maps a single row to *User. Kept separate so scanUser (single
// row) and ListUsers (many rows) can share the same nullable-handling logic.
// username and password_hash became nullable in migration 005 — Firebase
// users don't have them.
func scanUserRow(scan func(dest ...interface{}) error) (*User, error) {
	var u User
	var username sql.NullString
	var passwordHash sql.NullString
	var firebaseUID sql.NullString
	if err := scan(
		&u.ID, &u.Email, &username, &passwordHash, &firebaseUID, &u.Role, &u.InvitedBy, &u.CreatedAt,
		&u.MustChangePassword, &u.TOTPSecret, &u.TOTPEnabled, &u.RecoveryCodes, &u.Blocked,
	); err != nil {
		return nil, err
	}
	if username.Valid {
		u.Username = username.String
	}
	if passwordHash.Valid {
		u.PasswordHash = passwordHash.String
	}
	if firebaseUID.Valid && firebaseUID.String != "" {
		s := firebaseUID.String
		u.FirebaseUID = &s
	}
	return &u, nil
}

func (s *PostgresUserStore) scanUser(query string, args ...interface{}) (*User, error) {
	u, err := scanUserRow(s.db.QueryRow(query, args...).Scan)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to query user: %w", err)
	}
	return u, nil
}

func (s *PostgresUserStore) ListUsers() ([]User, error) {
	rows, err := s.db.Query(`SELECT ` + userColumns + ` FROM users ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("failed to list users: %w", err)
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		u, err := scanUserRow(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("failed to scan user: %w", err)
		}
		users = append(users, *u)
	}
	return users, rows.Err()
}

func (s *PostgresUserStore) UpdatePassword(userID int, newPassword string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}
	_, err = s.db.Exec(
		`UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2`,
		string(hash), userID,
	)
	return err
}

func (s *PostgresUserStore) UpdateRole(userID int, role string) error {
	_, err := s.db.Exec(`UPDATE users SET role = $1 WHERE id = $2`, role, userID)
	return err
}

func (s *PostgresUserStore) DeleteUser(id int) error {
	result, err := s.db.Exec(`DELETE FROM users WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("failed to delete user: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("user not found")
	}
	return nil
}

func (s *PostgresUserStore) CountUsers() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count)
	return count, err
}

func (s *PostgresUserStore) SetMustChangePassword(userID int, must bool) error {
	_, err := s.db.Exec(`UPDATE users SET must_change_password = $1 WHERE id = $2`, must, userID)
	return err
}

func (s *PostgresUserStore) ClearMustChangePassword(userID int) error {
	return s.SetMustChangePassword(userID, false)
}

func (s *PostgresUserStore) SetTOTP(userID int, secret string, recoveryCodes string) error {
	_, err := s.db.Exec(
		`UPDATE users SET totp_secret = $1, recovery_codes = $2 WHERE id = $3`,
		secret, recoveryCodes, userID,
	)
	return err
}

func (s *PostgresUserStore) EnableTOTP(userID int) error {
	_, err := s.db.Exec(`UPDATE users SET totp_enabled = true WHERE id = $1`, userID)
	return err
}

func (s *PostgresUserStore) DisableTOTP(userID int) error {
	_, err := s.db.Exec(
		`UPDATE users SET totp_enabled = false, totp_secret = NULL, recovery_codes = NULL WHERE id = $1`,
		userID,
	)
	return err
}

func (s *PostgresUserStore) SetBlocked(userID int, blocked bool) error {
	_, err := s.db.Exec(`UPDATE users SET blocked = $1 WHERE id = $2`, blocked, userID)
	return err
}

func (s *PostgresUserStore) AdminResetPassword(userID int, newPassword string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}
	_, err = s.db.Exec(
		`UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2`,
		string(hash), userID,
	)
	return err
}

// CheckPassword verifies a plaintext password against a user's stored hash.
func CheckPassword(user *User, password string) bool {
	if user.PasswordHash == "" {
		return false // Firebase-only users have no local password
	}
	return bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) == nil
}

// UpsertFirebaseUser is the login-time claim flow for federated identity.
//   1. If a row already has this firebase_uid → return it (no change).
//   2. Else if a row has this email AND firebase_uid is NULL → claim it
//      (attach the Firebase UID). This is the invite-then-signin path.
//   3. Else if a row has this email but firebase_uid is a DIFFERENT UID →
//      reject (same email mapped to two Google accounts, refuse).
//   4. Else → reject (user not invited on this server).
//
// adminEmails is consulted at claim time: if the email is in the set, the
// row's role is bumped to "admin" on first claim (operator-level bootstrap).
func (s *PostgresUserStore) UpsertFirebaseUser(email, firebaseUID, displayName string, adminEmails map[string]bool) (*User, error) {
	// 1. Already linked?
	existing, err := s.GetUserByFirebaseUID(firebaseUID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		// Email can change on the Firebase side — mirror it.
		if existing.Email != email {
			_, _ = s.db.Exec(`UPDATE users SET email = $1 WHERE id = $2`, email, existing.ID)
			existing.Email = email
		}
		return existing, nil
	}

	// 2/3. Email known?
	byEmail, err := s.GetUserByEmail(email)
	if err != nil {
		return nil, err
	}
	if byEmail != nil {
		if byEmail.FirebaseUID != nil && *byEmail.FirebaseUID != "" && *byEmail.FirebaseUID != firebaseUID {
			return nil, fmt.Errorf("email %s is already linked to a different Firebase account", email)
		}
		// Claim the row.
		role := byEmail.Role
		if adminEmails != nil && adminEmails[lower(email)] {
			role = "admin"
		}
		_, err := s.db.Exec(
			`UPDATE users SET firebase_uid = $1, role = $2, must_change_password = false WHERE id = $3`,
			firebaseUID, role, byEmail.ID,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to claim user row: %w", err)
		}
		return s.GetUserByID(byEmail.ID)
	}

	// 4. Not invited.
	return nil, fmt.Errorf("user %s is not invited on this server", email)
}

// PromoteToAdmin sets role='admin' for any user matching the given email.
// Idempotent — safe to call on every startup for every ADMIN_EMAILS entry.
// Returns true if a row was updated.
func (s *PostgresUserStore) PromoteToAdmin(email string) (bool, error) {
	res, err := s.db.Exec(
		`UPDATE users SET role = 'admin' WHERE lower(email) = lower($1) AND role <> 'admin'`,
		email,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func lower(s string) string {
	b := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		b[i] = c
	}
	return string(b)
}
