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
	// Run executes the query and returns the matching notes. Reads
	// are eventually consistent: a note stored by a recent Put can
	// take a short time to become visible to Run.
	Run(ctx context.Context, q Query) ([]Note, error)
	// Put stores the given notes, assigning IDs to new ones. Writes
	// are durable once Put returns; see Run for read visibility.
	Put(ctx context.Context, notes []Note) error
	// Delete removes the notes with the given IDs.
	Delete(ctx context.Context, ids []string) error
}
