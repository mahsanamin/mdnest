package firebase

import (
	"context"
	"fmt"
	"time"

	"cloud.google.com/go/firestore"
	"github.com/mdnest/mdnest/backend/store"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// firestoreCollection is where we park per-user TOTP state. One doc per
// Firebase UID: totp/{firebase_uid}. Every mdnest server sharing the same
// Firebase project reads the same doc → one enrollment covers all servers.
const firestoreCollection = "totp"

// TOTPStore implements store.TOTPStore against Firestore.
// mdnest user_id → firebase_uid is resolved via the local users table on
// every read (Postgres is fast, and the lookup is per-login, not per-request).
type TOTPStore struct {
	client *firestore.Client
	users  store.UserStore
}

// NewTOTPStore wires a Firestore-backed TOTP store.
func NewTOTPStore(client *firestore.Client, users store.UserStore) *TOTPStore {
	return &TOTPStore{client: client, users: users}
}

type totpDoc struct {
	Enabled           bool      `firestore:"enabled"`
	Secret            string    `firestore:"secret"`
	RecoveryCodesJSON string    `firestore:"recovery_codes_json"`
	EnrolledAt        time.Time `firestore:"enrolled_at,serverTimestamp,omitempty"`
	LastUsedAt        time.Time `firestore:"last_used_at,omitempty"`
}

func (s *TOTPStore) uidFor(userID int) (string, error) {
	u, err := s.users.GetUserByID(userID)
	if err != nil {
		return "", err
	}
	if u == nil {
		return "", fmt.Errorf("user %d not found", userID)
	}
	if u.FirebaseUID == nil || *u.FirebaseUID == "" {
		return "", fmt.Errorf("user %d has no firebase_uid (not a federated account)", userID)
	}
	return *u.FirebaseUID, nil
}

// Get returns (secret, enabled, recoveryCodesJSON). If no Firestore doc exists
// the user simply hasn't enrolled 2FA yet — return zero values with no error.
func (s *TOTPStore) Get(userID int) (string, bool, string, error) {
	uid, err := s.uidFor(userID)
	if err != nil {
		return "", false, "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	snap, err := s.client.Collection(firestoreCollection).Doc(uid).Get(ctx)
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return "", false, "", nil
		}
		return "", false, "", err
	}
	var d totpDoc
	if err := snap.DataTo(&d); err != nil {
		return "", false, "", err
	}
	return d.Secret, d.Enabled, d.RecoveryCodesJSON, nil
}

// Set writes the secret and recovery codes; enabled is NOT touched here —
// it starts false after setup, flips true via Enable(). Matches Postgres
// semantics so the TOTPHandler can be store-agnostic.
func (s *TOTPStore) Set(userID int, secret, recoveryCodesJSON string) error {
	uid, err := s.uidFor(userID)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = s.client.Collection(firestoreCollection).Doc(uid).Set(ctx, map[string]interface{}{
		"secret":              secret,
		"recovery_codes_json": recoveryCodesJSON,
		"last_used_at":        firestore.ServerTimestamp,
	}, firestore.MergeAll)
	return err
}

// Enable flips enabled=true. Called after the user verifies their first code.
func (s *TOTPStore) Enable(userID int) error {
	uid, err := s.uidFor(userID)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = s.client.Collection(firestoreCollection).Doc(uid).Set(ctx, map[string]interface{}{
		"enabled":     true,
		"enrolled_at": firestore.ServerTimestamp,
	}, firestore.MergeAll)
	return err
}

// Disable removes the entire Firestore doc — on every server that shares
// this Firebase project. That's intentional: admin-reset means the user
// needs to re-enroll everywhere.
func (s *TOTPStore) Disable(userID int) error {
	uid, err := s.uidFor(userID)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = s.client.Collection(firestoreCollection).Doc(uid).Delete(ctx)
	return err
}
