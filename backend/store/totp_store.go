package store

import "fmt"

// TOTPStore abstracts where 2FA state is kept. PostgresTOTPStore reads/writes
// the users table on the local DB; FirestoreTOTPStore (in the firebase package)
// reads/writes Firestore so TOTP is shared across every mdnest server that
// points at the same Firebase project.
//
// The TOTP handlers do not care which implementation they're given — they just
// need the four operations below.
type TOTPStore interface {
	Get(userID int) (secret string, enabled bool, recoveryCodesJSON string, err error)
	Set(userID int, secret, recoveryCodesJSON string) error
	Enable(userID int) error
	Disable(userID int) error
}

// PostgresTOTPStore is a thin adapter over UserStore. It exists so TOTPHandler
// can depend on a narrow interface rather than the full UserStore, and so the
// Firestore implementation can slot in alongside it.
type PostgresTOTPStore struct {
	users UserStore
}

// NewPostgresTOTPStore wraps a UserStore.
func NewPostgresTOTPStore(users UserStore) *PostgresTOTPStore {
	return &PostgresTOTPStore{users: users}
}

func (s *PostgresTOTPStore) Get(userID int) (string, bool, string, error) {
	u, err := s.users.GetUserByID(userID)
	if err != nil {
		return "", false, "", err
	}
	if u == nil {
		return "", false, "", fmt.Errorf("user %d not found", userID)
	}
	secret := ""
	if u.TOTPSecret != nil {
		secret = *u.TOTPSecret
	}
	codes := ""
	if u.RecoveryCodes != nil {
		codes = *u.RecoveryCodes
	}
	return secret, u.TOTPEnabled, codes, nil
}

func (s *PostgresTOTPStore) Set(userID int, secret, recoveryCodesJSON string) error {
	return s.users.SetTOTP(userID, secret, recoveryCodesJSON)
}

func (s *PostgresTOTPStore) Enable(userID int) error {
	return s.users.EnableTOTP(userID)
}

func (s *PostgresTOTPStore) Disable(userID int) error {
	return s.users.DisableTOTP(userID)
}
