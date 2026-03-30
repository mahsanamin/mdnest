package store

import (
	"database/sql"
	"fmt"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// User represents a row in the users table.
type User struct {
	ID           int
	Email        string
	Username     string
	PasswordHash string
	Role         string // "admin" or "collaborator"
	InvitedBy    *int
	CreatedAt    time.Time
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
}

// PostgresUserStore implements UserStore against a Postgres database.
type PostgresUserStore struct {
	db *DB
}

// NewPostgresUserStore creates a new PostgresUserStore.
func NewPostgresUserStore(db *DB) *PostgresUserStore {
	return &PostgresUserStore{db: db}
}

func (s *PostgresUserStore) CreateUser(email, username, password, role string, invitedBy *int) (*User, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	var user User
	err = s.db.QueryRow(
		`INSERT INTO users (email, username, password_hash, role, invited_by)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, email, username, password_hash, role, invited_by, created_at`,
		email, username, string(hash), role, invitedBy,
	).Scan(&user.ID, &user.Email, &user.Username, &user.PasswordHash, &user.Role, &user.InvitedBy, &user.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}
	return &user, nil
}

func (s *PostgresUserStore) GetUserByUsername(username string) (*User, error) {
	return s.scanUser(
		`SELECT id, email, username, password_hash, role, invited_by, created_at
		 FROM users WHERE username = $1`, username,
	)
}

func (s *PostgresUserStore) GetUserByEmail(email string) (*User, error) {
	return s.scanUser(
		`SELECT id, email, username, password_hash, role, invited_by, created_at
		 FROM users WHERE email = $1`, email,
	)
}

func (s *PostgresUserStore) GetUserByID(id int) (*User, error) {
	return s.scanUser(
		`SELECT id, email, username, password_hash, role, invited_by, created_at
		 FROM users WHERE id = $1`, id,
	)
}

func (s *PostgresUserStore) scanUser(query string, args ...interface{}) (*User, error) {
	var u User
	err := s.db.QueryRow(query, args...).Scan(
		&u.ID, &u.Email, &u.Username, &u.PasswordHash, &u.Role, &u.InvitedBy, &u.CreatedAt,
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
	rows, err := s.db.Query(
		`SELECT id, email, username, password_hash, role, invited_by, created_at
		 FROM users ORDER BY id`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list users: %w", err)
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Email, &u.Username, &u.PasswordHash, &u.Role, &u.InvitedBy, &u.CreatedAt); err != nil {
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
	_, err = s.db.Exec(`UPDATE users SET password_hash = $1 WHERE id = $2`, string(hash), userID)
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

// CheckPassword verifies a plaintext password against a user's stored hash.
func CheckPassword(user *User, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) == nil
}
