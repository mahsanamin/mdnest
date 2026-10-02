package handlers

import "sync"

// noteLocks serialises read-modify-write updates to one note within this
// process. Without it, two appends racing (two agents posting to the same
// chat, or two `mdnest append` calls) both read the old content and the
// second write silently drops the first one's text.
//
// Scope, stated rather than hidden: this is a per-process lock. It covers the
// default single-box deployment (one backend), which is what chat targets.
// A multi-replica MDNEST_ROLE=app deployment would need the lock in the
// shared tier instead.
var noteLocks = newKeyedMutex()

type keyedMutex struct {
	mu    sync.Mutex
	locks map[string]*refMutex
}

type refMutex struct {
	sync.Mutex
	refs int
}

func newKeyedMutex() *keyedMutex {
	return &keyedMutex{locks: make(map[string]*refMutex)}
}

// lock acquires the lock for key and returns its release func. Entries are
// reference-counted and removed when unused, so the map only ever holds the
// notes being written right now.
func (k *keyedMutex) lock(key string) func() {
	k.mu.Lock()
	m, ok := k.locks[key]
	if !ok {
		m = &refMutex{}
		k.locks[key] = m
	}
	m.refs++
	k.mu.Unlock()

	m.Lock()
	return func() {
		m.Unlock()
		k.mu.Lock()
		m.refs--
		if m.refs == 0 {
			delete(k.locks, key)
		}
		k.mu.Unlock()
	}
}

func lockNote(ns, relPath string) func() {
	return noteLocks.lock(ns + "\x00" + relPath)
}
