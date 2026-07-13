package notes

import (
	"context"
	"fmt"
)

// dedupCheckLimit bounds the dedup read to the retention cap; a user
// never retains more notes than that, so reading this many covers
// everything a new note could duplicate.
const dedupCheckLimit = 200

// saveEnv is the slice of the request environment saving needs,
// kept local so this file names only what it uses.
type saveEnv interface {
	Store() Store
}

// SaveNotes stores the given notes for userID. A note the user
// already has is skipped, so repeated submissions of the same
// content do not pile up duplicate entries.
func SaveNotes(ctx context.Context, env saveEnv, userID string, notes []Note) error {
	existing, err := env.Store().Run(ctx, Query{
		UserID: userID,
		Limit:  dedupCheckLimit,
	})
	if err != nil {
		return fmt.Errorf("list notes for dedup of %s: %w", userID, err)
	}
	seen := make(map[string]bool, len(existing))
	for _, note := range existing {
		seen[note.Body] = true
	}
	fresh := make([]Note, 0, len(notes))
	for _, note := range notes {
		if seen[note.Body] {
			continue
		}
		seen[note.Body] = true
		fresh = append(fresh, note)
	}
	if len(fresh) == 0 {
		return nil
	}
	if err := env.Store().Put(ctx, fresh); err != nil {
		return fmt.Errorf("save notes for %s: %w", userID, err)
	}
	return nil
}
