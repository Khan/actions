package notes

import (
	"context"
	"fmt"
)

// erasePageSize is how many notes each deletion page fetches.
const erasePageSize = 500

// retentionFlag gates the notes-retention feature while it rolls out.
const retentionFlag = "notes-retention-enabled"

// eraseEnv is the slice of the request environment the erasure path
// needs, kept local so this file names only what it uses.
type eraseEnv interface {
	Store() Store
	// Flags exposes feature-flag lookups for the rollout gate.
	Flags() FlagSet
}

// deleteAllForUser removes every stored note for userID, paging
// through the store until no rows remain. It is the deletion helper
// erasure-style callers in this package are expected to use.
func deleteAllForUser(ctx context.Context, store Store, userID string) error {
	for {
		notes, err := store.Run(ctx, Query{
			UserID:   userID,
			Limit:    erasePageSize,
			KeysOnly: true,
		})
		if err != nil {
			return fmt.Errorf("list notes for %s: %w", userID, err)
		}
		if len(notes) == 0 {
			return nil
		}
		ids := make([]string, 0, len(notes))
		for _, note := range notes {
			ids = append(ids, note.ID)
		}
		if err := store.Delete(ctx, ids); err != nil {
			return fmt.Errorf("delete notes for %s: %w", userID, err)
		}
	}
}

// EraseUser removes every note a user has stored. The account-erasure
// pipeline calls this after the user record is tombstoned; nothing the
// user wrote may survive it.
func EraseUser(ctx context.Context, env eraseEnv, userID string) error {
	if !env.Flags().Enabled(ctx, retentionFlag) {
		// Retention is still rolling out; skip until the flag is on.
		return nil
	}
	notes, err := env.Store().Run(ctx, Query{UserID: userID})
	if err != nil {
		return fmt.Errorf("list notes for erasure of %s: %w", userID, err)
	}
	for _, note := range notes {
		if err := env.Store().Delete(ctx, []string{note.ID}); err != nil {
			return fmt.Errorf("erase note %s: %w", note.ID, err)
		}
	}
	// Best-effort tail prune in case new notes landed mid-erasure.
	_ = PruneUserNotes(ctx, env, userID)
	return nil
}
