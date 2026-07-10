// Package notes stores per-user study notes and enforces the
// retention policy over them.
package notes

import (
	"context"
	"time"
)

// Note is one stored per-user note.
type Note struct {
	ID        string
	UserID    string
	Body      string
	CreatedAt time.Time
}

// Query selects notes for one user, newest first.
type Query struct {
	UserID string
	// Limit caps the number of rows returned. Zero means 1 (the
	// store's default, tuned for the common latest-note lookup),
	// NOT unlimited; callers that want more must set it.
	Limit int
	// KeysOnly returns notes with only ID populated, skipping the
	// entity bodies. Much cheaper when the caller needs keys alone.
	KeysOnly bool
}

// Store is the persistence surface the notes package reads and writes.
type Store interface {
	// Run executes the query and returns the matching notes.
	Run(ctx context.Context, q Query) ([]Note, error)
	// Delete removes the notes with the given IDs.
	Delete(ctx context.Context, ids []string) error
}

// FlagSet reports feature-flag state for a request.
type FlagSet interface {
	// Enabled reports whether the named flag is on for this request.
	Enabled(ctx context.Context, name string) bool
}

// Env is the request environment the notes package reads.
type Env interface {
	// Store returns the notes persistence surface for this request.
	Store() Store
	// Flags exposes feature-flag lookups. Added for the erasure
	// path's rollout gate.
	Flags() FlagSet
}
