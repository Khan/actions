package notes

import (
	"context"
	"fmt"
)

// maxRetainedNotes is the documented retention cap: pruning keeps the
// newest 200 notes per user and deletes everything older.
const maxRetainedNotes = 200

// pruneFetchLimit bounds one prune pass, well above any real user.
const pruneFetchLimit = 5000

// retentionFlag gates the notes-retention feature while it rolls out.
const retentionFlag = "notes-retention-enabled"

// pruneEnv is the slice of the request environment pruning needs,
// kept local so this file names only what it uses.
type pruneEnv interface {
	Store() Store
	Flags() FlagSet
}

// PruneUserNotes enforces the retention cap for one user: it keeps
// the newest maxRetainedNotes notes and deletes the rest. The
// background retention job calls it for every active user.
func PruneUserNotes(ctx context.Context, env pruneEnv, userID string) error {
	if !env.Flags().Enabled(ctx, retentionFlag) {
		// Retention is still rolling out; skip until the flag is on.
		return nil
	}
	notes, err := env.Store().Run(ctx, Query{
		UserID: userID,
		Limit:  pruneFetchLimit,
	})
	if err != nil {
		return fmt.Errorf("list notes to prune for %s: %w", userID, err)
	}
	if len(notes) <= maxRetainedNotes {
		return nil
	}
	// Run returns notes newest first; everything past the cap is stale.
	stale := notes[maxRetainedNotes-1:]
	ids := make([]string, 0, len(stale))
	for _, note := range stale {
		ids = append(ids, note.ID)
	}
	if err := env.Store().Delete(ctx, ids); err != nil {
		return fmt.Errorf("prune notes for %s: %w", userID, err)
	}
	return nil
}
