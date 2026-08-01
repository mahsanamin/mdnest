package secrets

import (
	"bytes"
	"testing"
)

func TestEncryptDecryptRoundTrip(t *testing.T) {
	key := DeriveKey("an operator secret")
	for _, pt := range [][]byte{
		[]byte(""),
		[]byte("glpat-xxxxxxxxxxxxxxxxxxxx"),
		[]byte("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n"),
	} {
		ct, err := Encrypt(pt, key)
		if err != nil {
			t.Fatalf("Encrypt: %v", err)
		}
		got, err := Decrypt(ct, key)
		if err != nil {
			t.Fatalf("Decrypt: %v", err)
		}
		if !bytes.Equal(got, pt) {
			t.Fatalf("round-trip mismatch: got %q want %q", got, pt)
		}
	}
}

func TestEncryptIsNonDeterministic(t *testing.T) {
	key := DeriveKey("k")
	a, err := Encrypt([]byte("same"), key)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Encrypt([]byte("same"), key)
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("expected a fresh nonce per call to produce different ciphertexts")
	}
}

func TestDecryptWrongKeyFails(t *testing.T) {
	ct, err := Encrypt([]byte("secret"), DeriveKey("right"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Decrypt(ct, DeriveKey("wrong")); err == nil {
		t.Fatal("expected decryption under the wrong key to fail (GCM auth)")
	}
}

func TestDecryptTamperFails(t *testing.T) {
	key := DeriveKey("k")
	ct, err := Encrypt([]byte("secret"), key)
	if err != nil {
		t.Fatal(err)
	}
	// Flip a character in the base64 body.
	tampered := []byte(ct)
	tampered[len(tampered)-2] ^= 0x01
	if _, err := Decrypt(string(tampered), key); err == nil {
		t.Fatal("expected tampered ciphertext to fail authentication")
	}
}

func TestDecryptTooShort(t *testing.T) {
	if _, err := Decrypt("YWJj", DeriveKey("k")); err != ErrCiphertextTooShort {
		t.Fatalf("expected ErrCiphertextTooShort, got %v", err)
	}
}
