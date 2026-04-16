package store

import (
	"database/sql"
	"fmt"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// User represents a row in the users table.
type User struct {
	ID                 int
	Email              string
	Username           string
	PasswordHash       string
	Role               string // "admin" or "collaborator"
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
}

// PostgresUserStore implements UserStore against a Postgres database.
type PostgresUserStore struct {
	db *DB
}

// NewPostgresUserStore creates a new PostgresUserStore.
func NewPostgresUserStore(db *DB) *PostgresUserStore {
	return &PostgresUserStore{db: db}
}

const userColumns = `id, email, username, password_hash, role, invited_by, created_at, must_change_password, totp_secret, totp_enabled, recovery_codes, blocked`

func (s *PostgresUserStore) CreateUser(email, username, password, role string, invitedBy *int) (*User, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	var user User
	err = s.db.QueryRow(
		`INSERT INTO users (email, username, password_hash, role, invited_by, must_change_password)
		 VALUES ($1, $2, $3, $4, $5, true)
		 RETURNING `+userColumns,
		email, username, string(hash), role, invitedBy,
	).Scan(&user.ID, &user.Email, &user.Username, &user.PasswordHash, &user.Role, &user.InvitedBy, &user.CreatedAt,
		&user.MustChangePassword, &user.TOTPSecret, &user.TOTPEnabled, &user.RecoveryCodes, &user.Blocked)
	if err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}
	return &user, nil
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

func (s *PostgresUserStore) scanUser(query string, args ...interface{}) (*User, error) {
	var u User
	err := s.db.QueryRow(query, args...).Scan(
		&u.ID, &u.Email, &u.Username, &u.PasswordHash, &u.Role, &u.InvitedBy, &u.CreatedAt,
		&u.MustChangePassword, &u.TOTPSecret, &u.TOTPEnabled, &u.RecoveryCodes, &u.Blocked,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to query user: %w", err)
	}
	return &u, nil
}

func (s *PostgresUserStore) ListUsers() ([]User, error) {
	rows, err := s.db.Query(`SELECT ` + userColumns + ` FROM users ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("failed to list users: %w", err)
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Email, &u.Username, &u.PasswordHash, &u.Role, &u.InvitedBy, &u.CreatedAt,
			&u.MustChangePassword, &u.TOTPSecret, &u.TOTPEnabled, &u.RecoveryCodes, &u.Blocked); err != nil {
			return nil, fmt.Errorf("failed to scan user: %w", err)
		}
		users = append(users, u)
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
	return bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) == nil
}
