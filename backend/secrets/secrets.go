// Package secrets provides authenticated symmetric encryption for values that
// must be stored at rest but read back in plaintext by the server — currently
// per-workspace git credentials (PATs and SSH private keys) in the workspaces
// table.
//
// The construction mirrors the mcp-server OAuth code sealing: a 32-byte key is
// derived from an operator secret via SHA-256, and values are sealed with
// AES-256-GCM (a fresh random nonce per call, nonce prepended to the
// ciphertext). GCM is authenticated, so tampering is detected on Open.
//
// Blast radius: the key material lives in the pod, so a compromised pod can
// decrypt stored credentials. That is documented and mitigated by using
// repo-scoped, revocable credentials (deploy tokens / fine-grained PATs /
// deploy keys), never account-wide secrets.
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
)

// ErrCiphertextTooShort is returned when a ciphertext is shorter than the GCM
// nonce, i.e. it cannot have been produced by Encrypt.
var ErrCiphertextTooShort = errors.New("secrets: ciphertext too short")

// DeriveKey derives a 32-byte AES-256 key from an arbitrary operator secret via
// SHA-256, so the caller can pass any-length secret (e.g. a Vault-managed
// passphrase) without worrying about key sizing.
func DeriveKey(secret string) [32]byte {
	return sha256.Sum256([]byte(secret))
}

// Encrypt seals plaintext with AES-256-GCM under key and returns a standard
// base64 string of nonce||ciphertext||tag. A fresh random nonce is used on
// every call, so sealing the same plaintext twice yields different outputs.
func Encrypt(plaintext []byte, key [32]byte) (string, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, plaintext, nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// Decrypt opens a base64 string produced by Encrypt under the same key. It
// fails if the key is wrong or the ciphertext was tampered with (GCM auth).
func Decrypt(ciphertext string, key [32]byte) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil {
		return nil, err
	}
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	if len(raw) < gcm.NonceSize() {
		return nil, ErrCiphertextTooShort
	}
	nonce, body := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	return gcm.Open(nil, nonce, body, nil)
}

func newGCM(key [32]byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
