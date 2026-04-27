// Package firebase wraps the Firebase Admin SDK so the rest of the backend
// doesn't pull SDK types into its signatures. Only loaded when
// USER_PROVIDER=firebase; not referenced at all in local-mode builds.
package firebase

import (
	"context"
	"fmt"

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/auth"
	"cloud.google.com/go/firestore"
	"google.golang.org/api/option"
)

// Client bundles the Firebase Auth + Firestore handles we use.
type Client struct {
	Auth      *auth.Client
	Firestore *firestore.Client
	projectID string
}

// VerifiedToken is the trimmed subset of Firebase ID-token claims we care about.
type VerifiedToken struct {
	UID           string
	Email         string
	EmailVerified bool
	Name          string
}

// NewClient initializes the Admin SDK with a service account JSON file.
// projectID is authoritative; if the service account file also carries a
// project id they must match.
func NewClient(ctx context.Context, serviceAccountPath, projectID string) (*Client, error) {
	if serviceAccountPath == "" {
		return nil, fmt.Errorf("FIREBASE_SERVICE_ACCOUNT path is required")
	}
	if projectID == "" {
		return nil, fmt.Errorf("FIREBASE_PROJECT_ID is required")
	}

	opts := []option.ClientOption{option.WithCredentialsFile(serviceAccountPath)}
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: projectID}, opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to init firebase app: %w", err)
	}

	authClient, err := app.Auth(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to init firebase auth client: %w", err)
	}

	fs, err := firestore.NewClient(ctx, projectID, opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to init firestore client: %w", err)
	}

	return &Client{Auth: authClient, Firestore: fs, projectID: projectID}, nil
}

// VerifyIDToken validates a Firebase ID token issued to a web client and
// returns the verified claim subset we use downstream. Checks signature,
// expiry, issuer, audience — everything Admin SDK does.
func (c *Client) VerifyIDToken(ctx context.Context, idToken string) (*VerifiedToken, error) {
	tok, err := c.Auth.VerifyIDToken(ctx, idToken)
	if err != nil {
		return nil, err
	}
	email, _ := tok.Claims["email"].(string)
	emailVerified, _ := tok.Claims["email_verified"].(bool)
	name, _ := tok.Claims["name"].(string)
	return &VerifiedToken{
		UID:           tok.UID,
		Email:         email,
		EmailVerified: emailVerified,
		Name:          name,
	}, nil
}

// Close releases Firestore resources. Auth has no Close.
func (c *Client) Close() error {
	if c.Firestore != nil {
		return c.Firestore.Close()
	}
	return nil
}
